import { createContext, useContext } from 'react'
import type { Exercise } from './lib/exercises'

export interface LessonItem {
  songId: string
  voice: string
  ex: Exercise
}

/** A lesson that practises one section with one learning method. */
export interface LessonTarget {
  songId: string
  voice: string
  section: number
  level: number
}

export type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'settings' }
  | { name: 'song'; songId: string }
  | { name: 'lesson'; title: string; items: LessonItem[]; level?: LessonTarget }
  | { name: 'concert'; songId: string }
  /** `part` (a section of your voice) is looped from the start; `then` is where Dagens pass goes on to. */
  | { name: 'rehearsal'; songId: string; part?: number; then?: Screen }
  | { name: 'tune'; songId: string }
  | { name: 'read'; songId: string }
  /** The voices as notes (experiment). */
  | { name: 'notes'; songId: string }

export interface Nav {
  go: (s: Screen) => void
  /** Swap the current screen for another, so Back skips it. */
  replace: (s: Screen) => void
  back: () => void
}

export const NavContext = createContext<Nav>({ go: () => {}, replace: () => {}, back: () => {} })
export const useNav = () => useContext(NavContext)
