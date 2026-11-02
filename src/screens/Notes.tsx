import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { db } from '../lib/db'
import { Mixer, unlockAudio } from '../lib/audio/engine'
import { beatAt } from '../lib/audio/beats'
import { findKey, GRID, quantize, scoreBeats, stepTime, tidy } from '../lib/notation/notes'
import { layout, toMusicXml } from '../lib/notation/musicxml'
import { NOTES_VERSION, transcribeVoice } from '../lib/notation/transcribe'
import { useSettings } from '../settings'
import { pickVoice } from '../lib/names'
import { TopBar } from '../components/ui'

const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm font-extrabold ${on ? 'bg-brand-600 text-white' : 'bg-brand-100 text-brand-700'}`

/**
 * Noter (experiment): the voices written out as notes from their audio. Turn voices on and off,
 * choose whose text is shown, and play along with the bar marked.
 */
export default function Notes({ songId }: { songId: string }) {
  const { settings } = useSettings()
  const song = useLiveQuery(() => db.songs.get(songId), [songId])
  const voices = useMemo(() => (song ? Object.keys(song.voices).sort() : []), [song])
  const mine = song ? (pickVoice(song.voices, settings.voices) ?? voices[0]) : ''
  const [shown, setShown] = useState<Set<string> | null>(null)
  const [textVoice, setTextVoice] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ voice: string; share: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [bar, setBar] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const mark = useRef<HTMLDivElement>(null)
  const osmd = useRef<OpenSheetMusicDisplay | null>(null)
  const mixer = useRef(new Mixer()).current

  const ready = voices.filter((v) => song?.voices[v].notes && song.voices[v].notesV === NOTES_VERSION)
  const missing = voices.filter((v) => !ready.includes(v))
  const on = shown ?? new Set(voices)
  const text = textVoice ?? mine
  const visible = ready.filter((v) => on.has(v))

  // Everything the score needs, from the notes of the voices that are written out.
  const score = useMemo(() => {
    if (!song?.beats || !ready.length) return null
    const beats = scoreBeats(song.beats)
    const raw = ready.map((v) => song.voices[v].notes!)
    const key = findKey(raw)
    const parts = ready.map((v) => ({ name: v, notes: quantize(tidy(song.voices[v].notes!, key), beats) }))
    const lay = layout(
      parts.map((p) => p.notes),
      beats.meter,
      beats.first,
    )
    return { beats, key, parts, lay }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, ready.join('|')])

  const xml = useMemo(() => {
    if (!score || !song || !visible.length) return null
    return toMusicXml(
      song.title,
      score.parts.filter((p) => on.has(p.name)),
      score.key,
      score.beats.meter,
      score.lay,
      new Set([text]),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score, visible.join('|'), text])

  useEffect(() => {
    if (!xml || !box.current) return
    let gone = false
    void (async () => {
      const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay')
      if (gone || !box.current) return
      osmd.current ??= new OpenSheetMusicDisplay(box.current, { autoResize: true, backend: 'svg', drawTitle: false, drawPartNames: true, drawCredits: false, drawMeasureNumbers: true })
      await osmd.current.load(xml)
      if (gone) return
      osmd.current.Zoom = window.innerWidth < 600 ? 0.6 : 0.8
      osmd.current.render()
    })()
    return () => {
      gone = true
    }
  }, [xml])

  // Mark the bar being played.
  useEffect(() => {
    const el = mark.current
    const o = osmd.current
    if (!el) return
    if (bar == null || !o) {
      el.style.display = 'none'
      return
    }
    const col = o.GraphicSheet?.MeasureList?.[bar]?.filter(Boolean)
    if (!col?.length) return
    const u = 10 * o.Zoom
    const top = col[0].PositionAndShape
    const bottom = col.at(-1)!.PositionAndShape
    const x = top.AbsolutePosition.x * u
    const y = (top.AbsolutePosition.y + top.BorderTop) * u
    const h = (bottom.AbsolutePosition.y + bottom.BorderBottom) * u - y
    Object.assign(el.style, { display: 'block', left: `${x}px`, top: `${y - 4}px`, width: `${top.Size.width * u}px`, height: `${h + 8}px` })
    if (playing) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [bar, playing])

  useEffect(() => {
    if (!playing || !score) return
    const id = window.setInterval(() => {
      const step = beatAt(score.beats, mixer.time) * GRID
      setBar(Math.floor((step - score.lay.origin) / score.lay.bar))
      if (!mixer.playing) setPlaying(false)
    }, 100)
    return () => clearInterval(id)
  }, [playing, score, mixer])

  useEffect(() => () => mixer.stop(), [mixer])

  if (!song) return null

  const write = async (list: string[]) => {
    setErr(null)
    try {
      for (const v of list) {
        setBusy({ voice: v, share: 0 })
        const fresh = await db.songs.get(songId)
        if (!fresh) return
        await transcribeVoice(fresh, v, (share) => setBusy({ voice: v, share }))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const play = async (fromBar: number) => {
    if (!score) return
    unlockAudio()
    const ids = visible.map((v) => song.voices[v].audioFileId)
    await mixer.setTracks(ids.length ? ids : [song.allaFileId ?? ''])
    const from = Math.max(0, stepTime(score.beats, score.lay.origin + fromBar * score.lay.bar) - 0.1)
    await mixer.play({ from })
    setPlaying(true)
  }

  // Tap a bar to play from it.
  const onTap = (e: React.MouseEvent) => {
    const o = osmd.current
    if (!o?.GraphicSheet || !box.current) return
    const r = box.current.getBoundingClientRect()
    const u = 10 * o.Zoom
    const px = (e.clientX - r.left) / u
    const py = (e.clientY - r.top) / u
    const list = o.GraphicSheet.MeasureList
    for (let m = 0; m < list.length; m++)
      for (const g of list[m] ?? []) {
        if (!g) continue
        const p = g.PositionAndShape
        const x0 = p.AbsolutePosition.x
        const y0 = p.AbsolutePosition.y + p.BorderTop
        if (px >= x0 && px <= x0 + p.Size.width && py >= y0 - 2 && py <= p.AbsolutePosition.y + p.BorderBottom + 3) {
          setBar(m)
          void play(m)
          return
        }
      }
  }

  return (
    <>
      <TopBar
        title={
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-black tracking-wide text-brand-600 uppercase">Noter · test</span>
            <span className="truncate">{song.title}</span>
          </span>
        }
        right={
          score && (
            <button
              className="rounded-full bg-brand-600 px-3 py-1.5 text-sm font-extrabold text-white"
              onClick={() => {
                if (playing) {
                  mixer.stop()
                  setPlaying(false)
                } else void play(bar ?? 0)
              }}
            >
              {playing ? '■ Stoppa' : '▶ Spela'}
            </button>
          )
        }
      />
      <main className="space-y-3 px-4 pb-16">
        {err && <p className="rounded-2xl bg-warm-100 p-3 text-sm font-semibold">{err}</p>}
        {!song.beats && <p className="rounded-2xl bg-warm-100 p-3 text-sm">Låten saknar takt (Musik-filen behövs för att lägga noterna i takt).</p>}
        {missing.length > 0 && (
          <div className="rounded-2xl bg-brand-50 p-3 text-sm">
            {busy ? (
              <p>
                Skriver ut {busy.voice}… {Math.round(busy.share * 100)} %
              </p>
            ) : (
              <>
                <p className="mb-2">
                  Appen lyssnar på stämfilerna och skriver ut tonerna. Det tar ungefär en halv minut per stämma. Inte skrivna än: {missing.join(', ')}.
                </p>
                <button className="btn-primary w-full" onClick={() => void write(missing.includes(mine) ? [mine, ...missing.filter((v) => v !== mine)] : missing)}>
                  Skriv ut noter
                </button>
              </>
            )}
          </div>
        )}
        {ready.length > 0 && (
          <>
            <div>
              <p className="mb-1 text-xs font-bold text-gray-500">Stämmor</p>
              <div className="flex flex-wrap gap-2">
                {ready.map((v) => (
                  <button
                    key={v}
                    aria-pressed={on.has(v)}
                    className={chip(on.has(v))}
                    onClick={() => {
                      const s = new Set(on)
                      if (s.has(v)) s.delete(v)
                      else s.add(v)
                      setShown(s)
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-bold text-gray-500">Text under</p>
              <div className="flex flex-wrap gap-2" role="radiogroup">
                {ready.map((v) => (
                  <button key={v} role="radio" aria-checked={text === v} className={chip(text === v)} onClick={() => setTextVoice(v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-gray-500">Utskrivet automatiskt från ljudet, så en del toner kan vara fel. Tryck på en takt för att spela därifrån.</p>
          </>
        )}
        <div className="relative overflow-x-auto rounded-2xl bg-white" onClick={onTap}>
          <div ref={box} />
          <div ref={mark} className="pointer-events-none absolute hidden rounded-md bg-brand-400/20 ring-2 ring-brand-400" />
        </div>
      </main>
    </>
  )
}
