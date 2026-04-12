import { atom } from 'jotai'

export type SessionUser = {
  id: string
}

export const sessionReadyAtom = atom(false)
export const currentUserAtom = atom<SessionUser | null>(null)
