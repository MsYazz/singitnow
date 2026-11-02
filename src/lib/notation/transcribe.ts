import { db } from '../db'
import type { Song } from '../types'
import { decodeForAnalysis, loadTokens, modelUrl, runSpeechModel } from '../audio/analyze'
import { applyCtc, makeVocab, wordTimes } from '../audio/ctc'
import { ANALYSIS_RATE } from '../audio/activity'
import { isolateVoice } from '../audio/isolate'
import { findNotes } from './notes'

/** Bump when the way notes are found changes, so voices are written out again. */
export const NOTES_VERSION = 2

/** Pitch per 10 ms of one voice, and how sure the model is, found by the pitch model in a worker. */
export function runPitchModel(pcm: Float32Array, onProgress?: (share: number) => void): Promise<{ hz: Float32Array; conf: Float32Array }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../audio/pitchWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e) => {
      const d = e.data as { progress?: number; hz?: Float32Array; conf?: Float32Array; error?: string }
      if (d.progress != null) return onProgress?.(d.progress)
      w.terminate()
      if (d.error) reject(new Error(d.error))
      else resolve({ hz: d.hz!, conf: d.conf! })
    }
    w.onerror = (e) => {
      w.terminate()
      reject(new Error(e.message || 'Tonhöjdsmodellen misslyckades'))
    }
    const x = pcm.slice()
    w.postMessage({ modelUrl: modelUrl('fcpe.f16.onnx'), pcm: x }, [x.buffer])
  })
}

async function decodeFile(id: string | undefined): Promise<Float32Array | null> {
  if (!id) return null
  const file = await db.files.get(id)
  return file ? (await decodeForAnalysis(file.blob)).pcm : null
}

/**
 * Writes out the notes of the given voices of a song. For each voice the other voices and ALLA
 * are taken out of its file (see isolateVoice), the pitch model then hears only that voice, and
 * the speech model finds when each word is sung; together they give notes with their syllables.
 * Also keeps the finer line times, as the fine-sync would.
 */
export async function transcribeSong(song: Song, voices: string[], onProgress?: (voice: string, share: number) => void): Promise<void> {
  const all = Object.keys(song.voices)
  const pcm = new Map<string, Float32Array>()
  for (const v of all) {
    const x = await decodeFile(song.voices[v].audioFileId)
    if (x) pcm.set(v, x)
  }
  const alla = await decodeFile(song.allaFileId)
  const vocab = makeVocab(await loadTokens())
  for (const voice of voices) {
    const track = song.voices[voice]
    const own = pcm.get(voice)
    if (!own) throw new Error('Ljudfilen saknas')
    const spans = track.spans ?? []
    const out = await runSpeechModel(own, spans, (s) => onProgress?.(voice, s * 0.75))
    const sections = track.timing === 'speech' ? track.sections : applyCtc(track.sections, out.lp, out.frames, out.vocab, vocab, spans)
    const words = wordTimes(sections, out.lp, out.frames, out.vocab, vocab)
    const others = [...all.filter((v) => v !== voice).map((v) => pcm.get(v)), alla].filter((x): x is Float32Array => !!x)
    const alone = isolateVoice(own, others, spans, ANALYSIS_RATE)
    const { hz, conf } = await runPitchModel(alone, (s) => onProgress?.(voice, 0.75 + s * 0.25))
    const notes = findNotes(hz, words, spans, own.length / ANALYSIS_RATE, conf)
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
}
