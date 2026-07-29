/**
 * Whisper ASR worker. Owns the transformers.js pipeline so the main thread
 * never blocks on model download or inference.
 *
 * GitHub Pages can't send COOP/COEP headers, so SharedArrayBuffer (and with it
 * multi-threaded WASM) is unavailable — we pin numThreads to 1 and never rely
 * on threads. WebGPU is attempted first and we fall back to WASM.
 */
import {
  BaseStreamer,
  env,
  pipeline,
  type AutomaticSpeechRecognitionOutput,
  type AutomaticSpeechRecognitionPipeline,
  type TextStreamer,
} from '@huggingface/transformers'
import type { LyricWord, ModelProgress } from '../types'
import { formatTime } from '../types'
import {
  CHUNK_LENGTH_SEC,
  LYRICS_MODEL_DTYPE,
  LYRICS_MODEL_ID,
  LYRICS_SAMPLE_RATE,
  STRIDE_LENGTH_SEC,
} from './constants'
import { humanizeError } from './errors'
import { filterHallucinations } from './filter'
import { ModelLoadProgress, modelReadyProgress, type RawProgressEvent } from './progress'
import type { LyricsWorkerScope, WorkerRequest } from './protocol'

const ctx = self as unknown as LyricsWorkerScope

// Single-threaded WASM: no SharedArrayBuffer on GitHub Pages.
const onnx = env.backends.onnx
if (onnx.wasm) {
  onnx.wasm.numThreads = 1
  // We are already off the main thread; an extra proxy worker buys nothing.
  onnx.wasm.proxy = false
}

type Asr = AutomaticSpeechRecognitionPipeline

let asr: Asr | null = null

let asrDevice: 'webgpu' | 'wasm' | null = null
let loading: Promise<Asr> | null = null

function post(message: Parameters<LyricsWorkerScope['postMessage']>[0]): void {
  ctx.postMessage(message)
}

function reportProgress(id: number, progress: ModelProgress): void {
  post({ type: 'progress', id, progress })
}

async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!gpu) return false
    const adapter = await gpu.requestAdapter()
    return adapter != null
  } catch {
    return false
  }
}

async function createPipeline(device: 'webgpu' | 'wasm', id: number): Promise<Asr> {
  const tracker = new ModelLoadProgress()
  // Explicit type argument: inference over every supported task blows up TS.
  return await pipeline<'automatic-speech-recognition'>('automatic-speech-recognition', LYRICS_MODEL_ID, {
    device,
    dtype: LYRICS_MODEL_DTYPE,
    progress_callback: (event: RawProgressEvent) => {
      const next = tracker.update(event)
      if (next) reportProgress(id, next)
    },
  })
}

async function loadPipeline(id: number): Promise<Asr> {
  if (asr) return asr
  if (loading) return loading

  loading = (async () => {
    reportProgress(id, { status: 'Preparing speech model…', progress: -1 })
    let lastError: unknown = null

    if (await webgpuAvailable()) {
      try {
        const built = await createPipeline('webgpu', id)
        asrDevice = 'webgpu'
        asr = built
        return built
      } catch (err) {
        // WebGPU can fail at session creation on plenty of real machines.
        lastError = err
      }
    }

    try {
      const built = await createPipeline('wasm', id)
      asrDevice = 'wasm'
      asr = built
      return built
    } catch (err) {
      throw humanizeError(err ?? lastError, 'load')
    }
  })()

  try {
    return await loading
  } finally {
    loading = null
  }
}

/**
 * Counts pipeline windows and generated tokens so we can report transcription
 * progress: `generate()` calls `put()` per token and `end()` once per window.
 */
class WindowProgressStreamer extends BaseStreamer {
  private tokens = 0
  private windowsDone = 0

  constructor(
    private readonly totalWindows: number,
    private readonly onTick: (fraction: number) => void,
  ) {
    super()
  }

  put(_value: bigint[][]): void {
    this.tokens++
    this.emit()
  }

  end(): void {
    this.windowsDone++
    this.tokens = 0
    this.emit()
  }

  private emit(): void {
    // Within a window we can only guess; cap the partial so it never overtakes.
    const partial = Math.min(this.tokens / 100, 0.9)
    const done = Math.min(this.windowsDone + partial, this.totalWindows)
    this.onTick(done / this.totalWindows)
  }
}

/** Mirrors the windowing inside the ASR pipeline so we know how many passes to expect. */
function countWindows(sampleCount: number): number {
  const window = CHUNK_LENGTH_SEC * LYRICS_SAMPLE_RATE
  const stride = STRIDE_LENGTH_SEC * LYRICS_SAMPLE_RATE
  const jump = window - 2 * stride
  let offset = 0
  let windows = 0
  for (;;) {
    windows++
    if (offset + window >= sampleCount) break
    offset += jump
  }
  return Math.max(1, windows)
}

function toWords(output: AutomaticSpeechRecognitionOutput): LyricWord[] {
  const chunks = output.chunks ?? []
  const words: LyricWord[] = []
  for (const chunk of chunks) {
    const stamp = chunk.timestamp ?? []
    // Times from the pipeline are already absolute from the start of the PCM.
    words.push({
      startSec: stamp[0] as number,
      endSec: stamp[1] as number,
      text: String(chunk.text ?? ''),
    })
  }
  return words
}

async function runTranscription(
  id: number,
  audio: Float32Array,
  durationSec: number,
): Promise<LyricWord[]> {
  const transcriber = await loadPipeline(id)

  const totalWindows = countWindows(audio.length)
  let lastEmit = 0
  let lastFraction = 0

  const tick = (fraction: number) => {
    const clamped = Math.min(0.999, Math.max(lastFraction, fraction))
    lastFraction = clamped
    const now = Date.now()
    if (now - lastEmit < 200) return
    lastEmit = now
    reportProgress(id, {
      status: Number.isFinite(durationSec) && durationSec > 0
        ? `Transcribing lyrics — ${formatTime(clamped * durationSec)} of ${formatTime(durationSec)}`
        : 'Transcribing lyrics…',
      progress: clamped,
    })
  }

  reportProgress(id, { status: 'Transcribing lyrics…', progress: 0 })

  // BaseStreamer is all `generate()` needs (put/end); the config type names the
  // richer TextStreamer, hence the cast.
  const streamer = new WindowProgressStreamer(totalWindows, tick) as unknown as TextStreamer

  let output: AutomaticSpeechRecognitionOutput
  try {
    const result = await transcriber(audio, {
      chunk_length_s: CHUNK_LENGTH_SEC,
      stride_length_s: STRIDE_LENGTH_SEC,
      return_timestamps: 'word',
      streamer,
    })
    output = (Array.isArray(result) ? result[0] : result) as AutomaticSpeechRecognitionOutput
  } catch (err) {
    // A WebGPU session that builds but can't run: retry once on WASM.
    if (asrDevice === 'webgpu') {
      asr = null
      asrDevice = null
      const cpu = await loadPipeline(id)
      const retry = await cpu(audio, {
        chunk_length_s: CHUNK_LENGTH_SEC,
        stride_length_s: STRIDE_LENGTH_SEC,
        return_timestamps: 'word',
      })
      output = (Array.isArray(retry) ? retry[0] : retry) as AutomaticSpeechRecognitionOutput
    } else {
      throw humanizeError(err, 'transcribe')
    }
  }

  reportProgress(id, { status: 'Cleaning up transcript…', progress: 1 })
  return filterHallucinations(toWords(output), durationSec)
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  void (async () => {
    try {
      if (request.type === 'load') {
        await loadPipeline(request.id)
        reportProgress(request.id, modelReadyProgress())
        post({ type: 'loaded', id: request.id })
        return
      }
      const words = await runTranscription(
        request.id,
        request.audio,
        request.durationSec,
      )
      post({ type: 'transcribed', id: request.id, words })
    } catch (err) {
      const error = humanizeError(err, request.type === 'load' ? 'load' : 'transcribe')
      post({ type: 'error', id: request.id, message: error.message })
    }
  })()
})
