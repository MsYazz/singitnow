import type { Section } from '../types'
import { splitLines } from './align'

/**
 * Lyric timing with a small speech model: the model gives, every 40 ms, how likely each
 * word piece is. Since we already know the words, we only need to find the most likely
 * moment for each of them, in order (CTC forced alignment).
 */
export const CTC_FRAME = 0.04
/** The model reports a word a little after it starts. */
const LAG = 0.1
/** How long before its PDF time a part may start, and how long after the next part's time it may go on. */
const EARLY = 12
const LATE = 15
/** A part begins before the next part's PDF time, give or take this much. */
const BEGIN_LATE = 1

export interface Vocab {
  pieces: Map<string, number>
  blank: number
}

export function makeVocab(tokens: string[]): Vocab {
  return { pieces: new Map(tokens.map((t, i) => [t, i])), blank: tokens.length - 1 }
}

const FOLD: Record<string, string> = { å: 'a', ä: 'a', ö: 'o', é: 'e', è: 'e', ü: 'u', ø: 'o', æ: 'a' }

export function words(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[åäöéèüøæ]/g, (c) => FOLD[c])
  return (t.match(/[a-z']+/g) ?? []).filter((w) => /[a-z]/.test(w))
}

/** Splits a word into the model's pieces, longest match first. */
export function tokenize(word: string, v: Vocab): number[] {
  const w = '▁' + word
  const out: number[] = []
  let i = 0
  while (i < w.length) {
    let j = w.length
    for (; j > i; j--) {
      const id = v.pieces.get(w.slice(i, j))
      if (id !== undefined) {
        out.push(id)
        break
      }
    }
    i = j > i ? j : i + 1
  }
  return out
}

/**
 * Most likely path through the tokens, in order. Returns, per token, the frame where it is
 * first heard and the frame where it is last heard. `lp` is [frames x vocab] log-probabilities.
 * `win`, if given, holds the first and last frame each token may be heard in. Returns null when
 * no path fits those windows.
 */
export function forceAlign(
  lp: Float32Array,
  frames: number,
  vocabSize: number,
  toks: number[],
  blank: number,
  win?: { lo: Int32Array; hi: Int32Array },
): { first: Int32Array; last: Int32Array } | null {
  const S = 2 * toks.length + 1
  const lab = new Int32Array(S)
  for (let s = 0; s < S; s++) lab[s] = s % 2 ? toks[(s - 1) >> 1] : blank
  const skip = new Uint8Array(S)
  for (let s = 2; s < S; s++) skip[s] = lab[s] !== blank && lab[s] !== lab[s - 2] ? 1 : 0
  const NEG = -1e30
  let dp = new Float64Array(S).fill(NEG)
  let nd = new Float64Array(S)
  const back = new Uint8Array(frames * S)
  const outside = (s: number, t: number) => win != null && s % 2 === 1 && (t < win.lo[(s - 1) >> 1] || t > win.hi[(s - 1) >> 1])
  dp[0] = lp[blank]
  if (S > 1 && !outside(1, 0)) dp[1] = lp[lab[1]]
  for (let t = 1; t < frames; t++) {
    const row = t * vocabSize
    for (let s = 0; s < S; s++) {
      let best = dp[s]
      let k = 0
      if (s > 0 && dp[s - 1] > best) {
        best = dp[s - 1]
        k = 1
      }
      if (skip[s] && dp[s - 2] > best) {
        best = dp[s - 2]
        k = 2
      }
      nd[s] = outside(s, t) ? NEG : best + lp[row + lab[s]]
      back[t * S + s] = k
    }
    const tmp = dp
    dp = nd
    nd = tmp
  }
  let s = S > 1 && dp[S - 2] > dp[S - 1] ? S - 2 : S - 1
  if (dp[s] <= NEG / 2) return null
  const first = new Int32Array(toks.length).fill(-1)
  const last = new Int32Array(toks.length).fill(-1)
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2) {
      const k = (s - 1) >> 1
      first[k] = t
      if (last[k] < 0) last[k] = t
    }
    s -= back[t * S + s]
  }
  return { first, last }
}

/** Sounds rather than words ("Oh…", "Ah, ah-ah", "Mm", "La la"). */
const VOCALISE = /^(o+h*|wo+h?|a+h*|u+h*|e+h|h?m+|wh?oa+h?|(la)+|(na)+|(da)+|doo+|ha)$/

/** Whether some part was timed outside the window around its PDF time that the fine-sync now keeps to. */
export function drifted(sections: Section[]): boolean {
  return sections.some((s, si) => {
    if (s.start == null || s.pdfStart == null) return false
    const next = sections.slice(si + 1).find((x) => x.pdfStart != null && x.pdfStart > s.pdfStart!)?.pdfStart
    return s.start < s.pdfStart - EARLY || (next != null && (s.start > next + BEGIN_LATE || (s.end != null && s.end > next + LATE)))
  })
}

/** A line with only sounds. The speech model does not know them well, so the pauses in the voice time them better. */
export function isVocalise(text: string): boolean {
  const w = words(text)
  return w.length > 0 && w.every((x) => VOCALISE.test(x))
}

/**
 * Sets line (and section) times from the speech model's output. Lines without any
 * recognisable word keep the times they had. Parts with only sounds such as "Oh…" are
 * placed at the pauses in the voice between the words around them.
 */
export function applyCtc(sections: Section[], lp: Float32Array, frames: number, vocabSize: number, v: Vocab, spans: [number, number][] = []): Section[] {
  const toks: number[] = []
  const owner: [number, number][] = []
  sections.forEach((s, si) =>
    s.lines.forEach((l, li) => {
      for (const w of words(l.text))
        for (const t of tokenize(w, v)) {
          toks.push(t)
          owner.push([si, li])
        }
    }),
  )
  const out = structuredClone(sections)
  if (!toks.length) return out
  // Each part is sung near the time its PDF gives: it begins between a little before its own time and
  // the next part's time, and ends at the latest a little after the next part's time. Without this,
  // a word the model hears badly can be pulled far from its place.
  const lo = new Int32Array(toks.length)
  const hi = new Int32Array(toks.length)
  const at = (t: number) => Math.round(t / CTC_FRAME)
  owner.forEach(([si], k) => {
    const begins = k === 0 || owner[k - 1][0] !== si
    const own = sections.slice(0, si + 1).findLast((x) => x.pdfStart != null)?.pdfStart
    const next = sections.slice(si + 1).find((x) => x.pdfStart != null && x.pdfStart > (own ?? -1))?.pdfStart
    lo[k] = own != null ? Math.max(0, at(own - EARLY)) : 0
    hi[k] = next != null ? at(next + (begins ? BEGIN_LATE : LATE)) : frames
  })
  const { first, last } = forceAlign(lp, frames, vocabSize, toks, v.blank, { lo, hi }) ?? forceAlign(lp, frames, vocabSize, toks, v.blank)!
  const r2 = (x: number) => Math.round(x * 100) / 100
  // First and last token of every line.
  const range = new Map<string, [number, number]>()
  owner.forEach(([si, li], k) => {
    const key = `${si}:${li}`
    const cur = range.get(key)
    if (first[k] < 0) return
    if (!cur) range.set(key, [first[k], last[k]])
    else cur[1] = last[k]
  })
  const spanEnd = (t: number) => spans.find((sp) => sp[0] - 0.05 <= t && t < sp[1])?.[1]
  const flat: { si: number; li: number }[] = []
  out.forEach((s, si) => s.lines.forEach((_, li) => flat.push({ si, li })))
  /** How far each line's last sung word reaches, before it is cut at the next line. */
  const reach: (number | undefined)[] = []
  flat.forEach(({ si, li }, k) => {
    const rg = range.get(`${si}:${li}`)
    if (!rg) return
    const line = out[si].lines[li]
    line.start = r2(Math.max(0, rg[0] * CTC_FRAME - LAG))
    const lastHeard = rg[1] * CTC_FRAME
    let end = Math.max(lastHeard + 0.4, spanEnd(lastHeard) ?? 0)
    reach[k] = end
    const next = flat[k + 1] && range.get(`${flat[k + 1].si}:${flat[k + 1].li}`)
    if (next) end = Math.min(end, next[0] * CTC_FRAME - LAG)
    line.end = r2(Math.max(end, line.start + 0.3))
  })
  // A part with only sounds ("Oh…", "Ah, ah") is placed at the pauses in the voice between the words
  // before and after it, since the model hardly knows such sounds. The model still took part above,
  // so that the words around the part do not drift into it.
  out.forEach((s, si) => {
    if (!s.lines.length || !s.lines.every((l) => isVocalise(l.text))) return
    const k = flat.findIndex((x) => x.si === si)
    const e = k + s.lines.length - 1
    const prev = k > 0 ? out[flat[k - 1].si].lines[flat[k - 1].li] : null
    const next = e + 1 < flat.length ? out[flat[e + 1].si].lines[flat[e + 1].li] : null
    // Not long before the time in the PDF either, like the first timing.
    const lo = Math.max(k > 0 ? (reach[k - 1] ?? prev?.end ?? 0) : 0, s.pdfStart != null ? s.pdfStart - 6 : 0)
    const hi = next?.start != null ? next.start - 0.05 : Infinity
    const r = splitLines(spans, lo, hi, s.lines)
    if (r)
      s.lines.forEach((l, i) => {
        l.start = r2(r.bounds[i][0])
        l.end = r2(r.bounds[i][1])
      })
    else {
      // Keep the first timing from the pauses.
      const orig = sections[si].lines
      if (orig.some((l) => l.start == null)) return
      s.lines.forEach((l, i) => {
        l.start = orig[i].start
        l.end = orig[i].end
      })
    }
    if (prev?.end != null && reach[k - 1] != null) prev.end = r2(Math.max(prev.end, Math.min(reach[k - 1]!, s.lines[0].start! - 0.05)))
    if (prev?.end != null && prev.end > s.lines[0].start!) prev.end = r2(Math.max(prev.start ?? 0, s.lines[0].start! - 0.05))
  })
  for (const s of out) {
    if (!s.lines.length) continue
    s.start = s.lines[0].start ?? s.start
    s.end = s.lines.at(-1)!.end ?? s.end
  }
  return out
}

/**
 * When each word is sung, found line by line inside the line times the fine-sync gave: `start`
 * is where the model first hears the word, `end` where it last hears it (often early, since the
 * model hears a word in a short burst). Words it cannot place get NaN.
 */
export function wordTimes(sections: Section[], lp: Float32Array, frames: number, vocabSize: number, v: Vocab): { text: string; start: number; end: number; section: number; line: number }[] {
  const out: { text: string; start: number; end: number; section: number; line: number }[] = []
  sections.forEach((sec, si) =>
    sec.lines.forEach((line, li) => {
      const raw = line.text.split(/\s+/).filter((w) => words(w).length)
      if (line.start == null || line.end == null) {
        raw.forEach((w) => out.push({ text: w, start: NaN, end: NaN, section: si, line: li }))
        return
      }
      const toks: number[] = []
      const owner: number[] = []
      raw.forEach((w, wi) => words(w).forEach((x) => tokenize(x, v).forEach((t) => (toks.push(t), owner.push(wi)))))
      const f0 = Math.max(0, Math.floor((line.start - 0.3) / CTC_FRAME))
      const f1 = Math.min(frames, Math.ceil((line.end + 0.3) / CTC_FRAME))
      const al = toks.length && f1 > f0 ? forceAlign(lp.subarray(f0 * vocabSize, f1 * vocabSize), f1 - f0, vocabSize, toks, v.blank) : null
      raw.forEach((w, wi) => {
        let a = Infinity
        let b = -1
        owner.forEach((o, k) => {
          if (o !== wi || !al || al.first[k] < 0) return
          a = Math.min(a, al.first[k])
          b = Math.max(b, al.last[k])
        })
        const ok = Number.isFinite(a) && b >= 0
        out.push({ text: w, start: ok ? (f0 + a) * CTC_FRAME : NaN, end: ok ? (f0 + b + 1) * CTC_FRAME : NaN, section: si, line: li })
      })
    }),
  )
  return out
}
