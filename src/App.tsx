import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, dbBlocked } from './lib/db'
import { getSettings, saveSettings, type Settings } from './lib/learn'
import { readDriveParam } from './lib/sources'
import { NavContext, type Screen } from './nav'
import { SettingsContext } from './settings'
import Home from './screens/Home'
import Setup from './screens/Setup'
import SongPath from './screens/SongPath'
import Lesson from './screens/Lesson'
import Rehearsal from './screens/Rehearsal'
import SettingsScreen from './screens/SettingsScreen'
import Tune from './screens/Tune'
import Concert from './screens/Concert'
import ChoirRead from './screens/ChoirRead'
import Notes from './screens/Notes'

export default function App() {
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [slow, setSlow] = useState(false)
  // Songs only noted from Drive count too: they are downloaded when first opened.
  const songCount = useLiveQuery(async () => (await db.songs.count()) + (await db.pending.count()), [])

  useEffect(() => {
    void (async () => {
      try {
        // Opened from a shared link with the choir's Drive folder: remember the folder.
        const drive = readDriveParam()
        if (drive && drive !== (await getSettings()).driveUrl) await saveSettings({ driveUrl: drive })
        setSettings(await getSettings())
      } catch (e) {
        setLoadErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      }
    })()
    // The phone's storage can be held by the app in another tab. Say so instead of loading forever.
    const t = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(t)
  }, [])

  // Each screen gets a browser history entry, so the phone's back button steps back in the app.
  useEffect(() => {
    const onPop = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const nav = useMemo(
    () => ({
      go: (s: Screen) => {
        setStack((st) => [...st, s])
        history.pushState({ singitnow: true }, '')
        window.scrollTo(0, 0)
      },
      replace: (s: Screen) => {
        setStack((st) => [...st.slice(0, -1), s])
        window.scrollTo(0, 0)
      },
      // Going back through history keeps the app and the browser in step; popstate pops the screen.
      back: () => {
        if (history.state?.singitnow) history.back()
        else setStack((st) => (st.length > 1 ? st.slice(0, -1) : st))
      },
    }),
    [],
  )

  const settingsCtx = useMemo(
    () => ({
      settings: settings!,
      reload: async () => setSettings(await getSettings()),
    }),
    [settings],
  )

  if (!settings || songCount === undefined) {
    if (!loadErr && !slow) return <div className="grid h-full place-items-center text-brand-600">Laddar…</div>
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 pt-16 text-center">
        <p className="text-5xl">🎶</p>
        <p className="text-xl font-black">Appen kommer inte åt sitt minne just nu</p>
        <p className="text-gray-600">
          Oftast beror det på att appen är öppen i en annan flik eller ett annat fönster. Stäng alla flikar med SingItNow, och öppna sedan appen igen.
        </p>
        <button className="btn-primary w-full" onClick={() => location.reload()}>
          Försök igen
        </button>
        {(loadErr || dbBlocked()) && <p className="text-xs text-gray-400">{loadErr || 'Databasen väntar på en annan flik.'}</p>}
      </main>
    )
  }

  const screen = stack.at(-1)!
  const needsSetup = songCount === 0 || !settings.voices.length
  let body: React.ReactNode
  if (needsSetup && screen.name !== 'settings') body = <Setup />
  else
    switch (screen.name) {
      case 'home':
        body = <Home />
        break
      case 'setup':
        body = <Setup />
        break
      case 'settings':
        body = <SettingsScreen />
        break
      case 'song':
        body = <SongPath songId={screen.songId} />
        break
      case 'lesson':
        body = <Lesson key={`${stack.length}:${screen.title}`} title={screen.title} items={screen.items} level={screen.level} />
        break
      case 'rehearsal':
        body = <Rehearsal songId={screen.songId} part={screen.part} then={screen.then} />
        break
      case 'tune':
        body = <Tune songId={screen.songId} />
        break
      case 'concert':
        body = <Concert songId={screen.songId} />
        break
      case 'notes':
        body = <Notes key={screen.songId} songId={screen.songId} />
        break
      case 'read':
        body = <ChoirRead key={screen.songId} songId={screen.songId} />
        break
    }

  return (
    <NavContext.Provider value={nav}>
      <SettingsContext.Provider value={settingsCtx}>
        <div className="mx-auto flex min-h-full max-w-xl flex-col pb-[env(safe-area-inset-bottom)]">{body}</div>
      </SettingsContext.Provider>
    </NavContext.Provider>
  )
}
