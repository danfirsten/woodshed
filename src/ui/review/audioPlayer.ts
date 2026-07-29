import { createContext, useContext } from 'react'

export interface AudioPlayerApi {
  /** Move playback to an absolute session time (seconds) and optionally play. */
  seekTo: (sec: number, play?: boolean) => void
  /** True once there is an audio element with a source attached. */
  ready: boolean
}

const NOOP: AudioPlayerApi = { seekTo: () => {}, ready: false }

export const AudioPlayerContext = createContext<AudioPlayerApi>(NOOP)

export function useAudioPlayer(): AudioPlayerApi {
  return useContext(AudioPlayerContext)
}
