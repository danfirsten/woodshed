/**
 * transformers.js reports model loading progress per-file (config.json,
 * tokenizer.json, the ONNX weights, ...), each with its own byte counters.
 * This aggregates that stream into one monotonic ModelProgress for the UI.
 */
import type { ModelProgress } from '../types'

/**
 * Structurally compatible with transformers.js `ProgressInfo` (which the package
 * doesn't re-export from its entry point). Deliberately wide so any of the
 * initiate/download/progress/done/ready variants is assignable to it.
 */
export interface RawProgressEvent {
  status: string
  name?: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
  task?: string
  model?: string
}

const BYTES_PER_MB = 1024 * 1024

/** "12 of 40 MB" for big downloads, "1.5 of 4 MB" for small ones. */
function formatMbPair(loaded: number, total: number): string {
  const totalMb = total / BYTES_PER_MB
  const loadedMb = loaded / BYTES_PER_MB
  if (totalMb >= 10) {
    return `${Math.floor(loadedMb)} of ${Math.round(totalMb)}`
  }
  const round = (v: number) => String(Math.round(v * 10) / 10)
  return `${round(loadedMb)} of ${round(totalMb)}`
}

interface FileState {
  loaded: number
  total: number
  done: boolean
}

/** Aggregates per-file download events into a single 0..1 progress. */
export class ModelLoadProgress {
  private readonly files = new Map<string, FileState>()
  private lastFraction = 0
  private lastTotal = 0
  private lastStatus = ''

  /**
   * Feed one transformers.js progress event.
   * Returns a ModelProgress worth emitting, or null when nothing changed.
   */
  update(event: RawProgressEvent): ModelProgress | null {
    const key = `${event.name ?? ''}/${event.file ?? ''}`

    switch (event.status) {
      case 'initiate':
      case 'download': {
        if (!this.files.has(key)) {
          this.files.set(key, { loaded: 0, total: 0, done: false })
        }
        break
      }
      case 'progress': {
        const entry = this.files.get(key) ?? { loaded: 0, total: 0, done: false }
        const total = Number(event.total)
        const loaded = Number(event.loaded)
        if (Number.isFinite(total) && total > 0) entry.total = total
        if (Number.isFinite(loaded) && loaded >= 0) {
          entry.loaded = entry.total > 0 ? Math.min(loaded, entry.total) : loaded
        }
        this.files.set(key, entry)
        break
      }
      case 'done': {
        const entry = this.files.get(key) ?? { loaded: 0, total: 0, done: false }
        entry.done = true
        if (entry.total > 0) entry.loaded = entry.total
        this.files.set(key, entry)
        break
      }
      default:
        // 'ready' and anything unknown: nothing to aggregate.
        return null
    }

    return this.snapshot()
  }

  private snapshot(): ModelProgress | null {
    let loaded = 0
    let total = 0
    for (const file of this.files.values()) {
      if (file.total > 0) {
        loaded += file.loaded
        total += file.total
      }
    }

    let next: ModelProgress
    if (total > 0) {
      // Monotonic while the file set is stable; a newly discovered file grows
      // the denominator, and then an honest step back beats a stuck bar.
      if (total !== this.lastTotal) {
        this.lastTotal = total
        this.lastFraction = 0
      }
      const fraction = Math.min(0.99, Math.max(this.lastFraction, loaded / total))
      this.lastFraction = fraction
      next = {
        status: `Downloading speech model — ${formatMbPair(loaded, total)} MB`,
        progress: fraction,
      }
    } else {
      // Everything served from cache: no byte counters, so stay indeterminate.
      next = { status: 'Loading speech model…', progress: -1 }
    }

    if (next.status === this.lastStatus) return null
    this.lastStatus = next.status
    return next
  }
}

/** Final message once the pipeline is warm and ready to transcribe. */
export function modelReadyProgress(): ModelProgress {
  return { status: 'Speech model ready', progress: 1 }
}
