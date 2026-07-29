/**
 * Turns transformers.js / ONNX / network failures into messages a musician can
 * actually act on. Everything the module rejects with goes through here.
 */

export type LyricsPhase = 'load' | 'transcribe'

/** Error whose message is already user-facing — never re-wrapped. */
export class LyricsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LyricsError'
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return ''
}

/** Human-readable Error for anything that goes wrong loading or running Whisper. */
export function humanizeError(err: unknown, phase: LyricsPhase): LyricsError {
  if (err instanceof LyricsError) return err
  const raw = messageOf(err)
  const lower = raw.toLowerCase()

  const offline =
    typeof navigator !== 'undefined' && navigator.onLine === false

  if (
    offline ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('load failed') ||
    lower.includes('err_internet') ||
    lower.includes('unexpected token') // HTML error page instead of JSON
  ) {
    return new LyricsError(
      offline
        ? "Can't download the speech model while offline. Reconnect and try again — once downloaded it stays cached on this device."
        : "Couldn't download the speech model. Check your connection and try again — once downloaded it stays cached on this device.",
    )
  }

  if (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('could not locate')
  ) {
    return new LyricsError(
      'The speech model files could not be found on the Hugging Face Hub. Try again later.',
    )
  }

  if (
    lower.includes('webassembly') ||
    lower.includes('wasm') ||
    lower.includes('no available backend')
  ) {
    return new LyricsError(
      "This browser can't run the speech model (WebAssembly is unavailable or blocked). Lyrics transcription is disabled.",
    )
  }

  if (
    lower.includes('out of memory') ||
    lower.includes('oom') ||
    lower.includes('allocation')
  ) {
    return new LyricsError(
      'Ran out of memory while transcribing. Try a shorter session or close some other tabs.',
    )
  }

  const suffix = raw ? ` (${raw})` : ''
  return phase === 'load'
    ? new LyricsError(`Couldn't load the speech model${suffix}.`)
    : new LyricsError(`Lyrics transcription failed${suffix}.`)
}
