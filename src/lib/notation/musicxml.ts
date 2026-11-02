import { GRID, type Key, type ScoreNote } from './notes'

const SHARP: [string, number][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]]
const FLAT: [string, number][] = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]
/** Note lengths in sixteenths that can be written as one note: type and dots. */
const TYPES: Record<number, [string, number]> = { 16: ['whole', 0], 12: ['half', 1], 8: ['half', 0], 6: ['quarter', 1], 4: ['quarter', 0], 3: ['eighth', 1], 2: ['eighth', 0], 1: ['16th', 0] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Splits a length in sixteenths into lengths that can be written (tied together). */
function pieces(len: number): number[] {
  const out: number[] = []
  for (const v of [16, 12, 8, 6, 4, 3, 2, 1])
    while (len >= v) {
      out.push(v)
      len -= v
    }
  return out
}

export interface ScoreLayout {
  /** Grid step where bar 1 starts, and steps per bar. */
  origin: number
  bar: number
  bars: number
}

/** Where the bars go: from the song's first downbeat, moved back whole bars so every note fits. */
export function layout(parts: ScoreNote[][], meter: number, firstBeat: number): ScoreLayout {
  const bar = meter * GRID
  const all = parts.flat()
  const start = Math.min(...all.map((n) => n.a), firstBeat * GRID)
  const end = Math.max(...all.map((n) => n.b), start + 1)
  let origin = firstBeat * GRID
  origin -= Math.ceil(Math.max(0, origin - start) / bar) * bar
  return { origin, bar, bars: Math.max(1, Math.ceil((end - origin) / bar)) }
}

/**
 * MusicXML for the chosen voices, one staff each, with lyrics under the voices in `withText`.
 * Bars from `lay`; key and time from the song.
 */
export function toMusicXml(title: string, parts: { name: string; notes: ScoreNote[] }[], key: Key, meter: number, lay: ScoreLayout, withText: Set<string>): string {
  const spell = key.fifths < 0 ? FLAT : SHARP
  const x: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    `<work><work-title>${esc(title)}</work-title></work>`,
    '<part-list>',
    ...parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`),
    '</part-list>',
  ]
  parts.forEach((p, pi) => {
    x.push(`<part id="P${pi + 1}">`)
    const notes = p.notes
    const text = withText.has(p.name)
    let k = 0
    for (let m = 0; m < lay.bars; m++) {
      const b0 = lay.origin + m * lay.bar
      const b1 = b0 + lay.bar
      x.push(`<measure number="${m + 1}">`)
      if (m === 0)
        x.push(
          `<attributes><divisions>${GRID}</divisions><key><fifths>${key.fifths}</fifths><mode>${key.mode}</mode></key><time><beats>${meter}</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`,
        )
      while (k < notes.length && notes[k].b <= b0) k++
      let cur = b0
      const ev: { a: number; b: number; n: ScoreNote | null }[] = []
      for (let j = k; j < notes.length && notes[j].a < b1; j++) {
        const n = notes[j]
        const a = Math.max(n.a, b0)
        const b = Math.min(n.b, b1)
        if (a > cur) ev.push({ a: cur, b: a, n: null })
        if (b > a) ev.push({ a, b, n })
        cur = Math.max(cur, b)
      }
      if (cur < b1) ev.push({ a: cur, b: b1, n: null })
      // Written notes and rests. Something that starts off the beat and runs over the middle of
      // the bar is split there (tied), as is usual in 4/4, so the bar can be read in two halves.
      const half = (meter % 2 ? meter : meter / 2) * GRID
      const items: { a: number; d: number; n: ScoreNote | null; first: boolean; last: boolean; whole: boolean }[] = []
      for (const e of ev) {
        const cuts = [e.a]
        const mid = b0 + Math.ceil((e.a - b0) / half) * half
        const nextBeat = b0 + Math.ceil((e.a - b0) / GRID) * GRID
        // A rest that starts off the beat first fills up to the beat.
        if (!e.n && nextBeat > e.a && nextBeat < e.b) cuts.push(nextBeat)
        if ((e.a - b0) % (e.n ? GRID : half) && mid < e.b && mid > cuts.at(-1)!) cuts.push(mid)
        cuts.push(e.b)
        for (let c = 0; c + 1 < cuts.length; c++) {
          let at = cuts[c]
          for (const d of pieces(cuts[c + 1] - at)) {
            items.push({ a: at, d, n: e.n, first: e.n ? at === e.n.a : false, last: e.n ? at + d === e.n.b : false, whole: !e.n && e.a === b0 && e.b === b1 })
            at += d
          }
        }
      }
      // Beams: eighths and sixteenths in the same beat are joined; sixteenths get a second beam.
      const beams: string[] = items.map(() => '')
      for (let i = 0; i < items.length; ) {
        const beat = Math.floor((items[i].a - b0) / GRID)
        let j = i
        while (j < items.length && items[j].n && items[j].d < GRID && Math.floor((items[j].a - b0) / GRID) === beat) j++
        if (j - i >= 2) {
          for (let k = i; k < j; k++) {
            let b = `<beam number="1">${k === i ? 'begin' : k === j - 1 ? 'end' : 'continue'}</beam>`
            if (items[k].d === 1) {
              const prev16 = k > i && items[k - 1].d === 1
              const next16 = k + 1 < j && items[k + 1].d === 1
              const kind = prev16 && next16 ? 'continue' : prev16 ? 'end' : next16 ? 'begin' : k === i ? 'forward hook' : 'backward hook'
              b += `<beam number="2">${kind}</beam>`
            }
            beams[k] = b
          }
        }
        i = Math.max(j, i + 1)
      }
      items.forEach((it, i) => {
        const [type, dots] = TYPES[it.d]
        if (!it.n) {
          x.push(it.whole ? `<note><rest measure="yes"/><duration>${it.d}</duration></note>` : `<note><rest/><duration>${it.d}</duration><type>${type}</type>${'<dot/>'.repeat(dots)}</note>`)
          return
        }
        const n = it.n
        const [step, alter] = spell[((n.midi % 12) + 12) % 12]
        const octave = Math.floor(n.midi / 12) - 1
        const tie = (it.first ? '' : '<tie type="stop"/>') + (it.last ? '' : '<tie type="start"/>')
        const tied = (it.first ? '' : '<tied type="stop"/>') + (it.last ? '' : '<tied type="start"/>')
        let lyric = ''
        if (text && it.first && n.text) {
          const syl = n.wordStart ? (n.hyphen ? 'begin' : 'single') : n.hyphen ? 'middle' : 'end'
          lyric = `<lyric number="1"><syllabic>${syl}</syllabic><text>${esc(n.text)}</text></lyric>`
        }
        x.push(
          `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${it.d}</duration>${tie}<type>${type}</type>${'<dot/>'.repeat(dots)}${beams[i]}${tied ? `<notations>${tied}</notations>` : ''}${lyric}</note>`,
        )
      })
      x.push('</measure>')
    }
    x.push('</part>')
  })
  x.push('</score-partwise>')
  return x.join('\n')
}
