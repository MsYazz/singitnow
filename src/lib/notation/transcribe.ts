import { db } from '../db'
import type { Song } from '../types'
import { decodeForAnalysis, loadTokens, modelUrl, runSpeechModel } from '../audio/analyze'
import { applyCtc, makeVocab, wordTimes } from '../audio/ctc'
import { findNotes } from './notes'

/** Bump when the way notes are found changes, so voices are written out again. */
export const NOTES_VERSION = 1

/** Pitch per 10 ms of one voice, found by the pitch model in a worker. */
export function runPitchModel(pcm: Float32Array, onProgress?: (share: number) => void): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/pitchWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e) => {
      const d = e.data as { progress?: number; hz?: Float32Array; error?: string }
      if (d.progress != null) return onProgress?.(d.progress)
      w.terminate()
      if (d.error) reject(new Error(d.error))
      else resolve(d.hz!)
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message || 'Tonhöjdsmodellen misslyckades'))
    }
    const x = pcm.slice()
    w.postMessage({ modelUrl: modelUrl('fcpe.f16.onnx'), pcm: x }, [x.buffer])
  })
}

/**
 * Writes out the notes of one voice: the speech model finds when each word is sung, the pitch
 * model what is sung, and the two together give notes with their syllables. Also keeps the finer
 * line times, as the fine-sync would. About as slow as the fine-sync, plus a few seconds.
 */
export async function transcribeVoice(song: Song, voice: string, onProgress?: (share: number) => void): Promise<void> {
  const track = song.voices[voice]
  const file = await db.files.get(track.audioFileId)
  if (!file) throw new Error('Ljudfilen saknas')
  const { pcm, duration } = await decodeForAnalysis(file.blob)
  const spans = track.spans ?? []
  const out = await runSpeechModel(pcm, spans, (s) => onProgress?.(s * 0.75))
  const vocab = makeVocab(await loadTokens())
  const sections = track.timing === 'speech' ? track.sections : applyCtc(track.sections, out.lp, out.frames, out.vocab, vocab, spans)
  const words = wordTimes(sections, out.lp, out.frames, out.vocab, vocab)
  const hz = await runPitchModel(pcm, (s) => onProgress?.(0.75 + s * 0.25))
  const notes = findNotes(hz, words, spans, duration)
  await db.songs.update(song.id, (s) => {
    const t = s.voices[voice]
    if (!t || t.audioFileId !== track.audioFileId) return
    t.notes = notes
    t.notesV = NOTES_VERSION
    if (t.timing !== 'speech') {
      t.sections = sections
      t.timing = 'speech'
    }
  })
}
