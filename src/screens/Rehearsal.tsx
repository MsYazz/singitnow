import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { Mixer, unlockAudio } from '../lib/audio/engine'
import { shortVoice, sortVoices, pickVoice } from '../lib/names'
import { useSettings } from '../settings'
import { refineVoice } from '../lib/refine'
import { markHeard, playedThrough } from '../lib/learn'
import { withAllVoices } from '../lib/merge'
import { LineText, OthersText, TopBar, fmt, othersVoices } from '../components/ui'
import type { Line } from '../lib/types'
import { barLoop, stepBy, subdivisions, type Beats } from '../lib/audio/beats'
import { useNav, type Screen } from '../nav'

interface Track {
  id: string
  label: string
  short: string
  voice?: string
}

type Loop = { from: number; to: number; label: string } | null

export default function Rehearsal({ songId, part, then }: { songId: string; part?: number; then?: Screen }) {
  const nav = useNav()
  const { settings } = useSettings()
  const song = useLiveQuery(() => db.songs.get(songId), [songId])
  const mixer = useRef(new Mixer()).current
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [loop, setLoop] = useState<Loop>(null)
  const [showMixer, setShowMixer] = useState(false)
  const [hideText, setHideText] = useState(false)
  const [refining, setRefining] = useState<number | null>(null)
  const [trimming, setTrimming] = useState(false)

  const tracks: Track[] = useMemo(() => {
    if (!song) return []
    const vs = sortVoices(Object.keys(song.voices))
    const out: Track[] = vs.map((v) => ({ id: song.voices[v].audioFileId, label: v, short: shortVoice(v), voice: v }))
    if (song.allaFileId) out.push({ id: song.allaFileId, label: 'ALLA', short: 'ALLA' })
    if (song.musikFileId) out.push({ id: song.musikFileId, label: 'Musik', short: 'Musik' })
    return out
  }, [song])

  const own = tracks.find((x) => x.voice === pickVoice(song?.voices ?? {}, settings.voices)) ?? tracks[0]

  useEffect(() => {
    if (!tracks.length) return
    const init: Record<string, number> = {}
    for (const tr of tracks) init[tr.id] = tr.id === own?.id ? 1 : 0
    setLevels(init)
    for (const [id, v] of Object.entries(init)) mixer.setLevel(id, v)
    mixer
      .setTracks(tracks.map((x) => x.id))
      .then(() => setReady(true))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    const off = mixer.onChange(() => setPlaying(mixer.playing))
    return () => {
      off()
      mixer.stop()
    }
  }, [tracks, own?.id, mixer])

  // Dagens pass opens on the part to learn, looped and in view, ready to play.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !ready || !song || part == null || !own?.voice) return
    started.current = true
    const ownSecs = song.voices[own.voice]?.sections
    const merged = withAllVoices(song, own.voice)
    const mi = ownSecs?.[part] ? merged.findIndex((x) => x.lines === ownSecs[part].lines) : -1
    if (mi < 0) return
    const st = merged[mi].start ?? merged[mi].pdfStart ?? 0
    const en = merged[mi].end ?? st + 10
    const pl = partLoop(song.beats, st, en)
    setLoop({ ...pl, label: `Del ${mi + 1}` })
    mixer.seek(pl.from)
    requestAnimationFrame(() => document.getElementById(`del-${mi}`)?.scrollIntoView({ block: 'center' }))
  }, [ready, song, part, own?.voice, mixer])

  // A part of your voice counts as rehearsed once it has been played through without a jump:
  // from before it starts to its end, as a looped part or as the song plays on.
  const run = useRef<{ from: number; last: number } | null>(null)
  useEffect(() => {
    const secs = own?.voice ? song?.voices[own.voice]?.sections : undefined
    if (!playing || !secs || !own?.voice) {
      run.current = null
      return
    }
    const r = run.current
    if (!r || t < r.last - 0.05 || t > r.last + 1) {
      run.current = { from: t, last: t }
      return
    }
    for (const i of playedThrough(secs, r.from, r.last, t)) void markHeard(songId, own.voice, i)
    r.last = t
  }, [t, playing, song, own?.voice, songId])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      setT(mixer.time)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mixer])

  if (!song) return null

  const setLevel = (id: string, v: number) => {
    setLevels((l) => ({ ...l, [id]: v }))
    mixer.setLevel(id, v)
  }
  const solo = (id: string) => {
    for (const tr of tracks) setLevel(tr.id, tr.id === id ? 1 : 0)
  }
  const soloed = tracks.filter((x) => (levels[x.id] ?? 0) > 0)
  const soloId = soloed.length === 1 ? soloed[0].id : null

  // Show the lyrics of the loudest voice that has lyrics.
  const textVoice = [...tracks].filter((x) => x.voice).sort((a, b) => (levels[b.id] ?? 0) - (levels[a.id] ?? 0))[0]
  const lyricVoice = (textVoice && (levels[textVoice.id] ?? 0) > 0 ? textVoice.voice : own?.voice) ?? Object.keys(song.voices)[0]
  // Every voice's PDF together, so the parts where the shown voice rests show what the others sing.
  const sections = withAllVoices(song, lyricVoice)

  const play = async (from: number, l: Loop = loop) => {
    unlockAudio()
    if (l) await mixer.play({ from: Math.max(l.from, Math.min(from, l.to - 0.1)), to: l.to, loop: true })
    else await mixer.play({ from })
  }
  const toggle = () => (playing ? mixer.stop() : void play(loop ? loop.from : t))
  const loopIt = ({ from, to }: { from: number; to: number }, label: string) => {
    // A second tap on what is already looping turns the loop off and lets the song play on.
    if (loop?.label === label) return clearLoop()
    if (loop?.label !== label) setTrimming(false)
    const l = { from: Math.max(0, from), to, label }
    setLoop(l)
    void play(l.from, l)
  }
  const clearLoop = () => {
    setLoop(null)
    setTrimming(false)
    if (playing) void mixer.play({ from: mixer.time })
  }

  // The looped line's own section in the shown voice (the merged list also holds the others' rests).
  const ownTrack = song.voices[lyricVoice]
  const ownIndex = (si: number) => (ownTrack ? ownTrack.sections.findIndex((x) => x.lines === sections[si].lines) : -1)

  /**
   * Moves the start or end of a line one step (a subdivision of the beat, or a quarter second when
   * the beat is unknown), saves it, and loops the line again with the new times.
   */
  const trim = async (si: number, li: number, field: 'start' | 'end', d: -1 | 1) => {
    const k = ownIndex(si)
    if (k < 0 || !ownTrack) return
    const secs = structuredClone(ownTrack.sections)
    const line = secs[k].lines[li]
    const st = secs[k].start ?? secs[k].pdfStart ?? 0
    const before = { start: line.start ?? st, end: line.end ?? st + 4 }
    const v = song.beats ? stepBy(song.beats, before[field], d) : Math.round((before[field] + d * 0.25) * 100) / 100
    if (field === 'start' ? v >= before.end - 0.2 || v < 0 : v <= before.start + 0.2) return
    line.start = before.start
    line.end = before.end
    line[field] = v
    if (li === 0) secs[k].start = line.start
    if (li === secs[k].lines.length - 1) secs[k].end = line.end
    await db.songs.update(songId, (x) => {
      if (x.voices[lyricVoice]) x.voices[lyricVoice].sections = secs
    })
    const l = { ...lineLoop(song.beats, line.start!, line.end!), label: `${si}:${li}` }
    setLoop(l)
    // A new start is heard at once; a new end is heard just before it.
    void play(field === 'start' ? l.from : Math.max(l.from, l.to - 2.5), l)
  }

  return (
    <>
      <TopBar
        title={`Stämrep · ${song.title}`}
        right={
          <span className="flex gap-1.5">
            <button className="rounded-full bg-brand-100 px-3 py-1.5 text-sm font-extrabold text-brand-700" onClick={() => nav.go({ name: 'notes', songId })}>
              Noter
            </button>
            <button className="rounded-full bg-brand-100 px-3 py-1.5 text-sm font-extrabold text-brand-700" onClick={() => setHideText((h) => !h)}>
              {hideText ? 'Visa text' : 'Dölj text'}
            </button>
          </span>
        }
      />
      <main className="flex-1 px-4 pb-64">
        {err && <p className="rounded-2xl bg-warm-100 p-3 text-sm font-semibold">{err}</p>}
        {then && (
          <div className="mb-3 rounded-2xl bg-brand-600 p-4 text-white">
            <p className="text-xs font-black tracking-wide uppercase opacity-80">Dagens pass · steg 1 av 2</p>
            <p className="mt-1 font-bold">
              {loop ? `Lyssna på ${loop.label.toLowerCase()} och sjung med. Den loopas tills du går vidare.` : 'Lyssna på din stämma och sjung med.'}
            </p>
            <button className="mt-3 w-full rounded-xl bg-white py-2.5 font-black text-brand-700" onClick={() => nav.replace(then)}>
              Vidare till textträning →
            </button>
          </div>
        )}
        {song.voices[lyricVoice] && song.voices[lyricVoice].timing !== 'speech' && (
          <button
            className="mb-3 w-full rounded-2xl bg-brand-50 p-3 text-left text-sm"
            disabled={refining !== null}
            onClick={async () => {
              setRefining(0)
              try {
                await refineVoice(song, lyricVoice, setRefining)
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              } finally {
                setRefining(null)
              }
            }}
          >
            <span className="font-bold text-brand-700">
              {refining === null ? `Texten för ${lyricVoice} är ungefärligt synkad. Tryck här för att finsynka.` : `Finsynkar texten för ${lyricVoice}… ${Math.round(refining * 100)} %`}
            </span>
          </button>
        )}
        <div className="space-y-4">
          {sections.map((s, si) => {
            if (!s.lines.length && !s.rest && !s.note && !s.others.length) return null
            const st = s.start ?? s.pdfStart ?? 0
            const en = s.end ?? st + 10
            const inSec = t >= st - 0.3 && t < en + 0.5
            const lp = loop?.label.match(/^(\d+):(\d+)$/)
            const loopedLine = lp && Number(lp[1]) === si && s.lines[Number(lp[2])] ? Number(lp[2]) : null
            return (
              <section key={si} id={`del-${si}`} className={`card transition ${inSec && playing ? 'border-brand-400' : ''}`}>
                <div className="mb-2 flex items-center gap-2">
                  <button className="text-xs font-black tracking-wide text-brand-600 uppercase" onClick={() => loopIt(partLoop(song.beats, st, en), `Del ${si + 1}`)}>
                    🔁 Del {si + 1} · {fmt(st).replace(/\.\d$/, '')}
                  </button>
                  {s.rest && (
                    <span className="text-xs text-gray-400">
                      tyst{othersVoices(s.others).length > 0 && ` (${othersVoices(s.others).join(', ')})`}
                    </span>
                  )}
                  {s.note && <span className="text-xs text-gray-400 italic">{s.note}</span>}
                  {loopedLine != null && ownIndex(si) >= 0 && (
                    <button
                      className={`ml-auto grid h-8 w-8 place-items-center rounded-full ${trimming ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700'}`}
                      aria-label="Justera radens tider"
                      aria-pressed={trimming}
                      onClick={() => setTrimming((x) => !x)}
                    >
                      <TrimIcon />
                    </button>
                  )}
                </div>
                {trimming && loopedLine != null && ownIndex(si) >= 0 && (
                  <TrimPanel line={s.lines[loopedLine]} step={stepName(song.beats)} onTrim={(field, d) => void trim(si, loopedLine, field, d)} />
                )}
                {!hideText &&
                  s.lines.map((l, li) => {
                    const on = playing && t >= (l.start ?? 0) - 0.1 && t < (l.end ?? 0) + 0.2
                    const looped = loop && loop.label === `${si}:${li}`
                    return (
                      <button
                        key={li}
                        className={`block w-full rounded-lg px-1 py-1 text-left text-lg transition ${on ? 'bg-brand-100 font-extrabold text-brand-700' : ''} ${looped ? 'ring-2 ring-brand-400' : ''}`}
                        onClick={() => loopIt(lineLoop(song.beats, l.start ?? st, l.end ?? en), `${si}:${li}`)}
                      >
                        <LineText line={l} />
                      </button>
                    )
                  })}
                {!hideText && s.others.length > 0 && (
                  <OthersText others={s.others} labels={s.lines.length > 0} className={s.lines.length ? 'mt-2 px-1 text-base text-gray-400' : undefined} />
                )}
                {hideText && <p className="text-gray-400">{s.lines.length} rader</p>}
              </section>
            )
          })}
        </div>
        <p className="mt-4 text-center text-xs text-gray-500">Tryck på en rad för att loopa den, eller på "Del" för hela formdelen.</p>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-xl rounded-t-3xl border-t-2 border-brand-100 bg-white px-4 pt-3 pb-[max(env(safe-area-inset-bottom),14px)] shadow-[0_-8px_24px_rgba(76,29,149,0.08)]">
        <div className="mb-3 flex flex-wrap justify-center gap-1.5" role="group" aria-label="Solo">
          {tracks.map((tr) => (
            <button
              key={tr.id}
              aria-pressed={soloId === tr.id}
              className={`min-w-12 rounded-xl px-2.5 py-2 text-sm font-black transition ${soloId === tr.id ? 'bg-brand-600 text-white shadow-[0_3px_0_#4c1d95]' : (levels[tr.id] ?? 0) > 0 ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500'}`}
              onClick={() => solo(tr.id)}
            >
              {tr.short}
            </button>
          ))}
          <button className={`rounded-xl px-2.5 py-2 text-sm font-black ${showMixer ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-500'}`} onClick={() => setShowMixer((m) => !m)} aria-label="Mixer">
            🎚️
          </button>
        </div>
        {showMixer && (
          <div className="mb-3 space-y-1.5">
            {tracks.map((tr) => (
              <label key={tr.id} className="flex items-center gap-3 text-sm font-bold">
                <span className="w-14">{tr.short}</span>
                <input type="range" min={0} max={1} step={0.05} value={levels[tr.id] ?? 0} onChange={(e) => setLevel(tr.id, Number(e.target.value))} className="flex-1 accent-brand-600" />
              </label>
            ))}
            <p className="text-xs text-gray-400">Varje stämfil har kompet inbakat, så kompet blir starkare när du mixar flera.</p>
            {song.beats && (
              <p className="text-xs text-gray-400">
                Tempo {Math.round(song.beats.bpm)} slag/min i {song.beats.meter}/4-takt. Looparna är hela takter.
              </p>
            )}
          </div>
        )}
        <input
          type="range"
          min={0}
          max={song.duration}
          step={0.1}
          value={Math.min(t, song.duration)}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (loop) setLoop(null)
            if (playing) void mixer.play({ from: v })
            else mixer.seek(v)
          }}
          className="w-full accent-brand-600"
          aria-label="Position"
        />
        <div className="flex items-center gap-2">
          <span className="w-12 text-xs font-bold text-gray-500 tabular-nums">{fmt(t).replace(/\.\d$/, '')}</span>
          <button className="grid h-11 w-11 place-items-center rounded-full bg-brand-50 text-lg" aria-label="5 sekunder bakåt" onClick={() => void play(Math.max(0, t - 5), null)}>
            ↺
          </button>
          <button className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-2xl text-white shadow-[0_4px_0_#4c1d95] disabled:opacity-40" disabled={!ready} onClick={toggle} aria-label={playing ? 'Pausa' : 'Spela'}>
            {playing ? '❚❚' : '▶'}
          </button>
          {loop ? (
            <button className="flex-1 truncate rounded-full bg-brand-100 px-3 py-2 text-sm font-extrabold text-brand-700" onClick={clearLoop}>
              🔁 Loopar {loop.label.includes(':') ? 'raden' : loop.label.toLowerCase()} ✕
            </button>
          ) : (
            <span className="flex-1 text-center text-xs text-gray-400">{ready ? 'Ingen loop' : 'Laddar ljudet…'}</span>
          )}
        </div>
      </div>
    </>
  )
}

/** A dashed line with arrows either way: move where a line starts or ends. */
function TrimIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <rect x="11" y="1" width="2" height="4" rx="1" />
      <rect x="11" y="7" width="2" height="4" rx="1" />
      <rect x="11" y="13" width="2" height="4" rx="1" />
      <rect x="11" y="19" width="2" height="4" rx="1" />
      <path d="M9 7.5v9L3.5 12zM15 7.5v9l5.5-4.5z" />
    </svg>
  )
}

function TrimPanel({ line, step: size, onTrim }: { line: Line; step: string; onTrim: (field: 'start' | 'end', d: -1 | 1) => void }) {
  const step = (field: 'start' | 'end', d: -1 | 1, label: string) => (
    <button className="rounded-lg bg-white px-3 py-1.5 font-black text-brand-700 shadow-[0_2px_0_#d6c4ff]" aria-label={label} onClick={() => onTrim(field, d)}>
      {d < 0 ? '−' : '+'}
    </button>
  )
  return (
    <div className="mb-2 space-y-2 rounded-2xl bg-brand-50 p-3 text-sm">
      {(['start', 'end'] as const).map((f) => (
        <div key={f} className="flex items-center gap-2">
          <span className="w-10 text-xs font-bold text-gray-500">{f === 'start' ? 'Start' : 'Slut'}</span>
          {step(f, -1, f === 'start' ? 'Börja tidigare' : 'Sluta tidigare')}
          <span className="w-16 text-center font-bold tabular-nums">{fmt(line[f])}</span>
          {step(f, 1, f === 'start' ? 'Börja senare' : 'Sluta senare')}
        </div>
      ))}
      <p className="text-xs text-gray-500">Flytta raden {size} i taget. Ändringen sparas direkt och loopen spelar om.</p>
    </div>
  )
}

/** A loop around a line: whole bars on the song's beat when it is known, else a little air either side. */
function lineLoop(b: Beats | null | undefined, start: number, end: number) {
  return b ? barLoop(b, start - 0.25, end + 0.1) : { from: Math.max(0, start - 0.3), to: end + 0.4 }
}

/** A loop around a whole part, in whole bars when the beat is known. */
function partLoop(b: Beats | null | undefined, start: number, end: number) {
  return b ? barLoop(b, start - 0.6, end + 0.1) : { from: Math.max(0, start - 0.8), to: end + 0.6 }
}

/** What one trim step is, in words. */
function stepName(b: Beats | null | undefined) {
  if (!b) return 'en kvarts sekund'
  return subdivisions(b) === 4 ? 'en sextondel' : 'en åttondel'
}
