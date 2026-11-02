import { describe, expect, it } from 'vitest'
import { findKey, findNotes, quantize, scoreBeats, syllables, tidy, type SungNote } from './notes'
import { layout, toMusicXml } from './musicxml'

const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

describe('notes from pitch and words', () => {
  it('splits words into syllables', () => {
    expect(syllables('something')).toEqual(['so', 'me', 'thing'])
    expect(syllables('face')).toEqual(['face'])
    expect(syllables('replace')).toEqual(['rep', 'lace'])
    expect(syllables('Koppången,')).toEqual(['Kop', 'pån', 'gen,'])
  })

  it('finds a note per steady pitch and gives each its syllable', () => {
    // "Hel-lo": C for 0.5 s, then E for 0.5 s, then silence.
    const hz = new Float32Array(150)
    for (let i = 10; i < 60; i++) hz[i] = hzOf(60) * (1 + 0.003 * Math.sin(i))
    for (let i = 60; i < 110; i++) hz[i] = hzOf(64)
    const notes = findNotes(hz, [{ text: 'Hello', start: 0.1, end: 0.3, section: 0, line: 0 }], [[0.1, 1.1]], 1.5)
    expect(notes.map((n) => Math.round(n.pitch))).toEqual([60, 64])
    expect(notes.map((n) => n.text)).toEqual(['Hel', 'lo'])
    expect(notes[0].hyphen).toBe(true)
  })

  it('tidies octave slips and slides, then writes MusicXML in time', () => {
    const n = (start: number, end: number, pitch: number, text: string | null, word: number): SungNote => ({ start, end, pitch, text, wordStart: text != null, hyphen: false, word, section: 0, line: 0 })
    const raw = [n(0, 0.5, 60, 'a', 0), n(0.5, 0.58, 61.6, 'b', 1), n(0.58, 1, 62, null, 1), n(1, 1.5, 52, 'c', 2), n(1.5, 2, 64, 'd', 3)]
    const key = findKey([raw])
    const t = tidy(raw, key)
    expect(t.map((x) => x.midi)).toEqual([60, 62, 64, 64])
    expect(t[1].text).toBe('b')
    const beats = scoreBeats({ bpm: 100, times: [0, 0.5, 1, 1.5, 2, 2.5], meter: 4, first: 0 })
    const q = quantize(t, beats)
    expect(q.map((x) => [x.a, x.b])).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
      [12, 16],
    ])
    const xml = toMusicXml('Test', [{ name: 'Alt 2', notes: q }], key, 4, layout([q], 4, 0), new Set(['Alt 2']))
    expect(xml).toContain('<text>b</text>')
    expect((xml.match(/<measure /g) ?? []).length).toBe(1)
  })
})
