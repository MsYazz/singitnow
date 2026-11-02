// Dev helper: npx vite-node scripts/words-dump.ts <song folder> <voice> <out.json>
// Runs the in-app analysis on one voice and writes when every word is sung (to try out the notes view offline).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as ort from 'onnxruntime-web'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extractPdf } from '../src/lib/pdf/extract'
import { parseLyrics } from '../src/lib/pdf/parseLyrics'
import { ANALYSIS_RATE, computeActivity, sungSpans } from '../src/lib/audio/activity'
import { alignLyrics } from '../src/lib/audio/align'
import { applyCtc, makeVocab, wordTimes } from '../src/lib/audio/ctc'
import { FBANK_BINS, fbank, normalizeFeatures } from '../src/lib/audio/fbank'
import { findBeats } from '../src/lib/audio/beats'
import { classify } from '../src/lib/names'

const decode = (p: string) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}
const [dir, voiceName, out] = process.argv.slice(2)
const files = readdirSync(dir)
const textDir = `${dir}/${files.find((f) => f.toLowerCase() === 'text')}`
const pdfs = readdirSync(textDir)
const music = decode(`${dir}/${files.find((f) => classify(f)?.kind === 'musik')!}`)
const vf = files.find((f) => classify(f)?.kind === 'voice' && classify(f)?.voice === voiceName)!
const pdf = pdfs.find((p) => classify(p)?.voice === voiceName)!
const voice = decode(`${dir}/${vf}`)
const spans = sungSpans(computeActivity(voice, music))
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${textDir}/${pdf}`)) }).promise
const parsed = parseLyrics(await extractPdf(doc, pdfjs.OPS as unknown as Record<string, number>))
const first = alignLyrics(parsed, spans, voice.length / ANALYSIS_RATE)

// Speech model over 20 s windows, as analyze.ts does in the browser.
const tokens: string[] = JSON.parse(readFileSync('public/models/ctc-en-small.tokens.json', 'utf8'))
ort.env.wasm.numThreads = 1
const session = await ort.InferenceSession.create(readFileSync('public/models/ctc-en-small.int8.onnx'))
const SR = 16000, WIN = 20, OV = 3, FPS = 25
const dur = voice.length / SR
const total = Math.ceil(dur * FPS) + 50
let V = 0
let lp = new Float32Array(0)
for (let t = 0; t < dur; t += WIN) {
  const a = Math.max(0, t - OV), b = Math.min(dur, t + WIN + OV)
  const f = fbank(voice.slice(Math.floor(a * SR), Math.floor(b * SR)))
  normalizeFeatures(f)
  const x = new Float32Array(FBANK_BINS * f.frames)
  for (let m = 0; m < f.frames; m++) for (let k = 0; k < FBANK_BINS; k++) x[k * f.frames + m] = f.data[m * FBANK_BINS + k]
  const r = await session.run({
    audio_signal: new ort.Tensor('float32', x, [1, FBANK_BINS, f.frames]),
    length: new ort.Tensor('int64', BigInt64Array.from([BigInt(f.frames)]), [1]),
  })
  const o = r[session.outputNames[0]]
  const [, n, v] = o.dims as number[]
  if (!V) {
    V = v
    lp = new Float32Array(total * V)
  }
  const s = Math.round((t - a) * FPS)
  const e = Math.min(n, s + Math.round(Math.min(WIN, dur - t) * FPS))
  lp.set((o.data as Float32Array).subarray(s * V, e * V), Math.round(t * FPS) * V)
  process.stderr.write('.')
}
const frames = Math.floor(lp.length / V)
const vocab = makeVocab(tokens)
const sections = applyCtc(first, lp, frames, V, vocab, spans)

const outWords = wordTimes(sections, lp, frames, V, vocab)
const beats = findBeats(music, ANALYSIS_RATE)
writeFileSync(out, JSON.stringify({ voice: voiceName, file: vf, duration: dur, spans, sections, words: outWords, beats }))
console.error(`\n${outWords.length} words, bpm ${beats?.bpm}, meter ${beats?.meter}`)
