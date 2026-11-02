import { PITCH_FPS } from '../audio/pitch'
import { beatAt, timeAt, type Beats } from '../audio/beats'

/** A sung note found in one voice's audio, in seconds, before it is put in time. */
export interface SungNote {
  start: number
  end: number
  /** MIDI pitch, with fractions (60 = middle C). */
  pitch: number
  /** The syllable sung on this note; null when the note carries on the syllable before (melisma). */
  text: string | null
  /** First syllable of its word, and whether more syllables of the word follow. */
  wordStart: boolean
  hyphen: boolean
  /** Index of the word in the voice, and the section and line it belongs to. */
  word: number
  section: number
  line: number
}

/** When a word is sung: `start` from the speech model, `end` where the model last hears it. */
export interface WordTime {
  text: string
  start: number
  end: number
  section: number
  line: number
}

const HOP = 1 / PITCH_FPS
/** How sure the pitch model must be (0..1) for a frame to count. */
const SURE = 0.3
const VOWELS = /[aeiouyåäöæø]+/gi

/** A rough split of a word into syllables (English and Swedish), enough to place text under notes. */
export function syllables(word: string): string[] {
  const core = word.replace(/[^\p{L}'’]/gu, '')
  if (!core) return [word]
  let groups = [...core.matchAll(VOWELS)].map((m) => [m.index!, m.index! + m[0].length])
  const low = core.toLowerCase()
  // A silent e at the end (love, come, face), but not -le (little).
  if (groups.length > 1 && low.endsWith('e') && groups.at(-1)![1] === core.length && groups.at(-1)![1] - groups.at(-1)![0] === 1 && !low.endsWith('le'))
    groups = groups.slice(0, -1)
  if (groups.length <= 1) return [word]
  const cuts: number[] = []
  for (let i = 0; i + 1 < groups.length; i++) {
    const cons = groups[i + 1][0] - groups[i][1]
    const between = low.slice(groups[i][1], groups[i + 1][0])
    // Two letters that make one sound stay together (some-thing, tea-cher).
    const pair = cons >= 2 && /^(th|ch|sh|ph|wh|ck)$/.test(between.slice(-2)) ? 2 : 0
    cuts.push(pair ? groups[i + 1][0] - 2 : cons > 1 ? groups[i][1] + Math.floor(cons / 2) : cons === 1 ? groups[i][1] : groups[i + 1][0])
  }
  const off = word.indexOf(core[0])
  const parts: string[] = []
  let prev = 0
  for (const c of cuts) {
    parts.push(word.slice(prev, off + c))
    prev = off + c
  }
  parts.push(word.slice(prev))
  return parts.filter(Boolean)
}

const midiOf = (hz: number) => (hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN)

function median(a: number[]): number {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Splits the pitch between t0 and t1 into steady notes: [start, end, pitch][]. */
function steadyNotes(m: Float32Array, t0: number, t1: number, minLen = 0.07, jump = 0.8): [number, number, number][] {
  const a = Math.max(0, Math.round(t0 / HOP))
  const b = Math.min(m.length, Math.round(t1 / HOP))
  if (b <= a) return []
  // A 70 ms median smooths vibrato and jitter.
  const x = new Float32Array(b - a)
  for (let i = a; i < b; i++) {
    if (Number.isNaN(m[i])) {
      x[i - a] = NaN
      continue
    }
    const w: number[] = []
    for (let k = Math.max(a, i - 3); k < Math.min(b, i + 4); k++) if (!Number.isNaN(m[k])) w.push(m[k])
    x[i - a] = w.length >= 3 ? median(w) : m[i]
  }
  const runs: { s: number; e: number; v: number[] }[] = []
  let cur: { s: number; e: number; v: number[] } | null = null
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (Number.isNaN(v)) {
      if (cur) runs.push(cur)
      cur = null
      continue
    }
    if (!cur) {
      cur = { s: i, e: i, v: [v] }
      continue
    }
    const med = median(cur.v.slice(-8))
    if (Math.abs(v - med) > jump) {
      // A new note only if the next frames agree, so one odd frame does not split a note.
      const ahead = Array.from(x.subarray(i, i + 6)).filter((y) => !Number.isNaN(y))
      if (ahead.length >= 5 && ahead.every((y) => Math.abs(y - med) > jump)) {
        runs.push(cur)
        cur = { s: i, e: i, v: [v] }
      }
      continue
    }
    cur.e = i
    cur.v.push(v)
  }
  if (cur) runs.push(cur)
  const notes: [number, number, number][] = []
  for (const r of runs) {
    if ((r.e - r.s + 1) * HOP < minLen) continue
    // The pitch of the steady middle, past any scoop at the start or fall at the end.
    const k = Math.floor(r.v.length / 5)
    notes.push([t0 + r.s * HOP, t0 + (r.e + 1) * HOP, median(r.v.length > 5 ? r.v.slice(k, r.v.length - k) : r.v)])
  }
  const merged: [number, number, number][] = []
  for (const n of notes) {
    const p = merged.at(-1)
    if (p && Math.round(p[2]) === Math.round(n[2]) && n[0] - p[1] < 0.12) p[1] = n[1]
    else merged.push(n)
  }
  return merged
}

/**
 * The notes of one voice: the pitch (Hz per 10 ms frame, 0 = no pitch) split into notes at the
 * words, and within words where the pitch moves, with each note given its syllable.
 */
export function findNotes(hz: Float32Array, words: WordTime[], spans: [number, number][], duration: number, conf?: Float32Array): SungNote[] {
  const loose = Float32Array.from(hz, midiOf)
  // Frames where the pitch model is unsure are mostly breath, consonants or the backing
  // track; they make up most of the stray notes. A word with no sure frames uses them anyway.
  const m = conf ? loose.map((v, i) => (conf[i] >= SURE ? v : NaN)) : loose
  // Most recordings are not tuned exactly to A = 440 Hz.
  const dev: number[] = []
  for (let i = 0; i < m.length; i += 3) if (!Number.isNaN(m[i])) dev.push(((m[i] + 0.5) % 1) - 0.5)
  const tune = median(dev) || 0
  for (let i = 0; i < m.length; i++) {
    m[i] -= tune
    if (m !== loose) loose[i] -= tune
  }
  const spanEnd = (t: number) => spans.find(([a, b]) => a - 0.05 <= t && t < b)?.[1] ?? t + 0.6
  const ws = words.filter((w) => Number.isFinite(w.start))
  const out: SungNote[] = []
  ws.forEach((w, i) => {
    const next = i + 1 < ws.length ? ws[i + 1].start : duration
    const t0 = Math.max(0, w.start - 0.06)
    const t1 = Math.min(next - 0.02, Math.max(spanEnd(w.start + 0.05), w.end + 0.3))
    let segs = steadyNotes(m, t0, t1)
    if (!segs.length && m !== loose) segs = steadyNotes(loose, t0, t1)
    if (!segs.length) return
    let syl = syllables(w.text)
    // One syllable per note while both last; more notes than syllables sing the last one on.
    if (syl.length > segs.length) syl = [...syl.slice(0, segs.length - 1), syl.slice(segs.length - 1).join('')]
    segs.forEach(([s, e, p], k) => {
      const text = k < syl.length ? syl[k] : null
      out.push({ start: round3(s), end: round3(e), pitch: Math.round(p * 100) / 100, text, wordStart: k === 0, hyphen: text != null && k + 1 < syl.length, word: i, section: w.section, line: w.line })
    })
  })
  return out
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const FIFTHS: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 }

export interface Key {
  /** Sharps (+) or flats (−) in the key signature. */
  fifths: number
  mode: 'major' | 'minor'
  tonic: number
  scale: Set<number>
}

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y) / a.length
  const mb = b.reduce((x, y) => x + y) / b.length
  let n = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? n / Math.sqrt(da * db) : 0
}

/** The key that fits how long each pitch class is sung, over all voices. */
export function findKey(voices: SungNote[][]): Key {
  const h = new Array(12).fill(0)
  for (const ns of voices) for (const n of ns) h[((Math.round(n.pitch) % 12) + 12) % 12] += n.end - n.start
  let best = { r: -2, tonic: 0, mode: 'major' as 'major' | 'minor' }
  for (let t = 0; t < 12; t++)
    for (const [mode, prof] of [
      ['major', MAJOR],
      ['minor', MINOR],
    ] as const) {
      const r = corr(
        h,
        prof.map((_, i) => prof[(i - t + 12) % 12]),
      )
      if (r > best.r) best = { r, tonic: t, mode }
    }
  const major = best.mode === 'major' ? best.tonic : (best.tonic + 3) % 12
  return { fifths: FIFTHS[major], mode: best.mode, tonic: best.tonic, scale: new Set([0, 2, 4, 5, 7, 9, 11].map((i) => (major + i) % 12)) }
}

/** A note ready for the score: MIDI pitch and place in sixteenths from the first beat. */
export interface ScoreNote extends SungNote {
  midi: number
  /** Start and end in grid steps (sixteenth notes) counted from the song's first beat. */
  a: number
  b: number
}

/**
 * Tidies the notes of one voice with rules that hold for any song: notes an octave off are
 * moved back, pitches just off the key are read as the key's note, short slides into a note and
 * vibrato read as notes are joined into the note they belong to.
 */
export function tidy(notes: SungNote[], key: Key): (SungNote & { midi: number })[] {
  if (!notes.length) return []
  const all = median(notes.map((n) => n.pitch))
  let out: (SungNote & { midi: number })[] = []
  notes.forEach((n, i) => {
    const ctx = notes
      .slice(Math.max(0, i - 6), i + 7)
      .map((x) => x.pitch)
      .filter((p) => Math.abs(p - all) < 10)
    const ref = ctx.length ? median(ctx) : all
    let p = n.pitch
    while (p - ref > 8.5) p -= 12
    while (ref - p > 8.5) p += 12
    if (Math.abs(p - ref) > 10) return
    let r = Math.round(p)
    if (!key.scale.has(((r % 12) + 12) % 12))
      for (const alt of [Math.floor(p), Math.ceil(p)])
        if (key.scale.has(((alt % 12) + 12) % 12) && Math.abs(alt - p) < 0.62) {
          r = alt
          break
        }
    out.push({ ...n, pitch: p, midi: r })
  })
  // Short blips (a scoop up to a note, a consonant) join the neighbour in the same word.
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const n = out[i]
      if (n.end - n.start >= 0.13) continue
      const nb: number[] = []
      if (i + 1 < out.length && out[i + 1].word === n.word && out[i + 1].start - n.end < 0.1) nb.push(i + 1)
      if (i > 0 && out[i - 1].word === n.word && n.start - out[i - 1].end < 0.1) nb.push(i - 1)
      if (!nb.length) continue
      const j = nb.reduce((x, y) => (Math.abs(out[y].midi - n.midi) < Math.abs(out[x].midi - n.midi) ? y : x))
      const m = { ...out[j] }
      if (j > i) {
        m.start = n.start
        if (n.text != null) {
          if (m.text == null) Object.assign(m, { text: n.text, wordStart: n.wordStart, hyphen: n.hyphen })
          else Object.assign(m, { text: n.text + m.text, wordStart: n.wordStart })
        }
      } else {
        m.end = n.end
        if (n.text != null) Object.assign(m, { text: (m.text ?? '') + n.text, hyphen: n.hyphen })
      }
      out[j] = m
      out.splice(i, 1)
      changed = true
      break
    }
  }
  // Stray notes: short, far from the notes on both sides (a leap there and straight back), as
  // when the pitch model briefly hears the backing or another voice. Its syllable, if any, moves
  // to the next note of the same word; a syllable with no other note keeps its note.
  const near = (x: { start: number; end: number }, y: { start: number; end: number }) => y.start - x.end < 0.3
  for (let i = 0; i < out.length; ) {
    const n = out[i]
    const nb = [i - 1, i + 1].filter((j) => j >= 0 && j < out.length && (j < i ? near(out[j], n) : near(n, out[j])))
    const stray = n.end - n.start < 0.25 && nb.length > 0 && nb.every((j) => Math.abs(out[j].pitch - n.pitch) >= 4.5)
    const heir = i + 1 < out.length && out[i + 1].word === n.word && out[i + 1].text == null ? i + 1 : -1
    if (stray && (n.text == null || heir >= 0)) {
      if (n.text != null) out[heir] = { ...out[heir], start: n.start, text: n.text, wordStart: n.wordStart, hyphen: n.hyphen }
      out.splice(i, 1)
      i = Math.max(0, i - 1)
    } else i++
  }
  // Vibrato read as notes: a-b-a with b a step away and short becomes one held a.
  for (let i = 0; i + 2 < out.length; ) {
    const [a, b, c] = [out[i], out[i + 1], out[i + 2]]
    if (a.word === b.word && b.word === c.word && a.midi === c.midi && Math.abs(b.midi - a.midi) <= 2 && b.end - b.start < 0.3 && b.text == null && c.text == null) {
      out[i] = { ...a, end: c.end }
      out.splice(i + 1, 2)
    } else i++
  }
  const res: typeof out = []
  for (const n of out) {
    const p = res.at(-1)
    if (p && p.word === n.word && p.midi === n.midi && n.start - p.end < 0.08 && n.text == null) res[res.length - 1] = { ...p, end: n.end }
    else res.push(n)
  }
  out = res
  return out
}

/** The beat the score counts in: the beat tracker sometimes hears eighths in a slow song. */
export function scoreBeats(b: Beats): Beats {
  if (b.bpm <= 110) return b
  const off = b.first % 2
  return { bpm: b.bpm / 2, times: b.times.filter((_, i) => i % 2 === off), meter: b.meter, first: Math.floor(b.first / 2) }
}

export const GRID = 4 // sixteenths per beat

/** Puts notes on the sixteenth grid of the song's beat. */
export function quantize(notes: (SungNote & { midi: number })[], beats: Beats): ScoreNote[] {
  const out: ScoreNote[] = []
  for (const n of notes) {
    let a = Math.round(beatAt(beats, n.start) * GRID)
    let b = Math.round(beatAt(beats, n.end) * GRID)
    const prev = out.at(-1)
    if (prev && a < prev.b) a = prev.b
    if (b <= a) b = a + 1
    out.push({ ...n, a, b })
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const [x, y] = [out[i], out[i + 1]]
    // Legato: a note lasts until the next one unless there is a real pause: more than a beat
    // within a lyric line, more than half a beat between lines.
    const sameLine = x.section === y.section && x.line === y.line
    if (y.a - x.b > 0 && y.a - x.b <= (sameLine ? GRID : GRID / 2)) x.b = y.a
    if (x.b > y.a) x.b = Math.max(x.a + 1, y.a)
  }
  return out
}

/** Seconds at a grid step, for following the audio in the score. */
export const stepTime = (beats: Beats, step: number) => timeAt(beats, step / GRID)
