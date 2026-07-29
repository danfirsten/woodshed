/**
 * Woodshed audio engine.
 *
 * One `start()` gives you two things at once from a single mic stream:
 *   1. a full-quality compressed recording via MediaRecorder (the thing we keep), and
 *   2. a live stream of mono 16 kHz PCM frames for analysis, plus the whole
 *      session's 16 kHz PCM accumulated in memory for the post-session pass.
 *
 * Raw PCM is captured with an AudioWorklet (ScriptProcessorNode fallback). The
 * worklet only ships raw Float32 blocks to the main thread; downmix + resample
 * happen here so the worklet stays trivial and the processor source can be
 * embedded as a string (loaded via a Blob URL, which sidesteps Vite asset-path
 * problems under the GitHub Pages `/woodshed/` base).
 */
import { ANALYSIS_SAMPLE_RATE, type AudioFrame, type RecordingResult } from '../types'

export interface AudioEngineEvents {
  /** 16 kHz mono chunks, ~128 ms each. */
  onFrame?: (frame: AudioFrame) => void
  /** 0..1, throttled to ~15 Hz. */
  onLevel?: (rms: number) => void
}

/** Samples per emitted AudioFrame — 2048 @ 16 kHz = 128 ms. */
const FRAME_SAMPLES = 2048

/** ~15 Hz level updates. */
const LEVEL_INTERVAL_MS = 1000 / 15

/** Ask MediaRecorder for a chunk every second so long sessions stay incremental. */
const RECORDER_TIMESLICE_MS = 1000

/** Initial growable-PCM capacity: 30 s @ 16 kHz. */
const INITIAL_PCM_CAPACITY = ANALYSIS_SAMPLE_RATE * 30

/** How long to let a final worklet flush land before tearing the graph down. */
const FLUSH_GRACE_MS = 60

const WORKLET_PROCESSOR_NAME = 'woodshed-capture'

/** MediaRecorder container preferences, best first. */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
]

/**
 * AudioWorkletProcessor source. Buffers each channel to a fixed block so we
 * post ~47 messages/s at 48 kHz instead of ~375, then transfers the buffers.
 * A 'flush' message from the main thread emits any partial block on stop.
 */
const CAPTURE_PROCESSOR_SOURCE = `
const BLOCK = 1024
class WoodshedCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffers = null
    this._fill = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this._flush(this._fill)
    }
  }
  _flush(len) {
    if (!this._buffers || len <= 0) return
    const channels = []
    const transfer = []
    for (let c = 0; c < this._buffers.length; c++) {
      const out = this._buffers[c].slice(0, len)
      channels.push(out)
      transfer.push(out.buffer)
    }
    this._fill = 0
    this.port.postMessage({ channels: channels }, transfer)
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    if (!this._buffers || this._buffers.length !== input.length) {
      this._buffers = []
      for (let c = 0; c < input.length; c++) this._buffers.push(new Float32Array(BLOCK))
      this._fill = 0
    }
    const frames = input[0].length
    let read = 0
    while (read < frames) {
      const take = Math.min(BLOCK - this._fill, frames - read)
      for (let c = 0; c < input.length; c++) {
        this._buffers[c].set(input[c].subarray(read, read + take), this._fill)
      }
      this._fill += take
      read += take
      if (this._fill === BLOCK) this._flush(BLOCK)
    }
    return true
  }
}
registerProcessor(${JSON.stringify(WORKLET_PROCESSOR_NAME)}, WoodshedCaptureProcessor)
`

interface CaptureMessage {
  channels: Float32Array[]
}

function isCaptureMessage(data: unknown): data is CaptureMessage {
  if (typeof data !== 'object' || data === null) return false
  const channels = (data as { channels?: unknown }).channels
  return Array.isArray(channels) && channels.every((c) => c instanceof Float32Array)
}

/** First MediaRecorder mime type the browser admits to supporting, if any. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const supported = MediaRecorder.isTypeSupported
  if (typeof supported !== 'function') return undefined
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      // Some browsers throw on odd strings; just try the next one.
    }
  }
  return undefined
}

/** Turn a getUserMedia rejection into something worth showing a human. */
function micError(cause: unknown): Error {
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause
      ? String((cause as { name: unknown }).name)
      : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new Error(
        'Microphone access was denied. Allow microphone access for this site in your browser settings, then try again.',
      )
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new Error('No microphone was found. Plug one in or select an input device, then try again.')
    case 'NotReadableError':
    case 'TrackStartError':
      return new Error(
        'Your microphone is busy or unavailable. Close other apps or tabs using it, then try again.',
      )
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new Error('Your microphone does not support the requested settings. Try a different input device.')
    default: {
      const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : ''
      return new Error(`Could not start the microphone${detail}. Check your browser's microphone permissions.`)
    }
  }
}

type Phase = 'idle' | 'starting' | 'recording' | 'stopping'

export class AudioEngine {
  private readonly events: AudioEngineEvents

  private phase: Phase = 'idle'
  private startedAt = 0
  private startedAtPerf = 0

  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private sink: GainNode | null = null

  private recorder: MediaRecorder | null = null
  private recorderChunks: Blob[] = []
  private recorderStopped: Promise<void> = Promise.resolve()
  private mimeType = ''

  /** Growable 16 kHz mono accumulator for the whole session. */
  private pcm = new Float32Array(0)
  private pcmLength = 0
  private emittedSamples = 0

  /** Resampler state, continuous across capture blocks. */
  private srcRate = 0
  private srcConsumed = 0
  private prevSample = 0
  private outCount = 0

  private lastLevelAt = 0

  constructor(events: AudioEngineEvents = {}) {
    this.events = events
  }

  /** 'recording' between a resolved start() and stop(); 'idle' otherwise. */
  get state(): 'idle' | 'recording' {
    return this.phase === 'recording' ? 'recording' : 'idle'
  }

  /** Epoch ms when start() resolved; 0 before the first successful start. */
  get startedAtMs(): number {
    return this.startedAt
  }

  /**
   * Request the mic and begin recording.
   *
   * @throws Error with a human-readable message if the mic is unavailable.
   */
  async start(): Promise<void> {
    if (this.phase !== 'idle') {
      throw new Error('Recording is already in progress.')
    }
    this.phase = 'starting'
    this.resetCapture()

    let stream: MediaStream
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Microphone capture is not available in this browser. It requires a secure page (https or localhost).',
        )
      }
      // Music, not speech: every "helpful" DSP stage would wreck the signal.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
        video: false,
      })
    } catch (cause) {
      this.phase = 'idle'
      throw cause instanceof Error && cause.message.startsWith('Microphone capture is not available')
        ? cause
        : micError(cause)
    }

    this.stream = stream
    try {
      await this.setupGraph(stream)
      this.setupRecorder(stream)
    } catch (cause) {
      await this.teardown()
      this.phase = 'idle'
      throw cause instanceof Error
        ? cause
        : new Error('Could not start recording. Your browser may not support audio capture.')
    }

    this.startedAt = Date.now()
    this.startedAtPerf = performance.now()
    this.lastLevelAt = 0
    this.phase = 'recording'
  }

  /**
   * Stop everything, release the mic, and return the session's audio.
   * Safe to call once per successful start(); throws otherwise.
   */
  async stop(): Promise<RecordingResult> {
    if (this.phase !== 'recording') {
      throw new Error('Not currently recording.')
    }
    this.phase = 'stopping'

    // Ask the worklet for its partial block before the graph goes away.
    this.workletNode?.port.postMessage('flush')

    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // Already stopping — the onstop promise still settles below.
      }
    }
    await this.recorderStopped
    await new Promise<void>((resolve) => {
      setTimeout(resolve, FLUSH_GRACE_MS)
    })

    const wallClockSec = Math.max(0, (performance.now() - this.startedAtPerf) / 1000)
    await this.teardown()

    const mimeType = this.mimeType || 'audio/webm'
    const blob = new Blob(this.recorderChunks, { type: mimeType })
    const pcm16k = this.pcm.slice(0, this.pcmLength)
    const durationSec = pcm16k.length > 0 ? pcm16k.length / ANALYSIS_SAMPLE_RATE : wallClockSec

    this.recorderChunks = []
    this.pcm = new Float32Array(0)
    this.pcmLength = 0
    this.phase = 'idle'

    return { blob, mimeType, durationSec, pcm16k }
  }

  // ---------------------------------------------------------------- setup

  private resetCapture(): void {
    this.pcm = new Float32Array(INITIAL_PCM_CAPACITY)
    this.pcmLength = 0
    this.emittedSamples = 0
    this.srcConsumed = 0
    this.prevSample = 0
    this.outCount = 0
    this.recorderChunks = []
    this.recorderStopped = Promise.resolve()
    this.mimeType = ''
  }

  private async setupGraph(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.srcRate = ctx.sampleRate
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    this.source = ctx.createMediaStreamSource(stream)

    // Muted sink: some browsers only pull a node that reaches the destination.
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    this.sink = sink

    const canUseWorklet = typeof AudioWorkletNode !== 'undefined' && typeof ctx.audioWorklet?.addModule === 'function'
    if (canUseWorklet) {
      try {
        await this.setupWorklet(ctx)
      } catch {
        this.setupScriptProcessor(ctx)
      }
    } else {
      this.setupScriptProcessor(ctx)
    }
  }

  private async setupWorklet(ctx: AudioContext): Promise<void> {
    const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR_SOURCE], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (isCaptureMessage(event.data)) this.handleChannels(event.data.channels)
    }
    this.workletNode = node
    this.source?.connect(node)
    if (this.sink) node.connect(this.sink)
  }

  private setupScriptProcessor(ctx: AudioContext): void {
    // Deprecated, but it is the only capture path in older browsers.
    const node = ctx.createScriptProcessor(4096, 2, 1)
    node.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer
      const channels: Float32Array[] = []
      for (let c = 0; c < input.numberOfChannels; c++) {
        channels.push(input.getChannelData(c).slice())
      }
      this.handleChannels(channels)
    }
    this.scriptNode = node
    this.source?.connect(node)
    if (this.sink) node.connect(this.sink)
  }

  private setupRecorder(stream: MediaStream): void {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Recording is not supported in this browser (MediaRecorder is unavailable).')
    }
    const preferred = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream)
    } catch {
      recorder = new MediaRecorder(stream)
    }

    this.mimeType = recorder.mimeType || preferred || 'audio/webm'
    this.recorder = recorder
    this.recorderStopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => resolve()
    })
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.recorderChunks.push(event.data)
    }
    recorder.start(RECORDER_TIMESLICE_MS)
    // Chrome reports the real container only after start() in some versions.
    if (recorder.mimeType) this.mimeType = recorder.mimeType
  }

  // -------------------------------------------------------------- capture

  private handleChannels(channels: Float32Array[]): void {
    if (this.phase === 'idle' || channels.length === 0) return
    const mono = downmix(channels)
    if (mono.length === 0) return
    this.emitLevel(mono)
    this.resampleInto16k(mono)
    this.emitFrames()
  }

  private emitLevel(block: Float32Array): void {
    const onLevel = this.events.onLevel
    if (!onLevel) return
    const now = performance.now()
    if (now - this.lastLevelAt < LEVEL_INTERVAL_MS) return
    this.lastLevelAt = now
    let sum = 0
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
    const rms = Math.sqrt(sum / block.length)
    onLevel(rms > 1 ? 1 : rms < 0 ? 0 : rms)
  }

  /** Linear-interpolation resample from ctx.sampleRate to ANALYSIS_SAMPLE_RATE. */
  private resampleInto16k(block: Float32Array): void {
    const ratio = this.srcRate / ANALYSIS_SAMPLE_RATE
    const start = this.srcConsumed
    const end = start + block.length

    this.ensureCapacity(this.pcmLength + Math.ceil(block.length / ratio) + 4)
    const out = this.pcm

    // Global source index i maps to: block[i - start], or prevSample at i === start - 1.
    for (;;) {
      const t = this.outCount * ratio
      const i0 = Math.floor(t)
      const i1 = i0 + 1
      if (i1 >= end) break
      const s0 = i0 < start ? this.prevSample : block[i0 - start]
      const s1 = block[i1 - start]
      out[this.pcmLength++] = s0 + (s1 - s0) * (t - i0)
      this.outCount++
    }

    this.prevSample = block[block.length - 1]
    this.srcConsumed = end
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.pcm.length) return
    let capacity = Math.max(this.pcm.length || INITIAL_PCM_CAPACITY, 1)
    while (capacity < needed) capacity *= 2
    const grown = new Float32Array(capacity)
    grown.set(this.pcm.subarray(0, this.pcmLength))
    this.pcm = grown
  }

  private emitFrames(): void {
    const onFrame = this.events.onFrame
    if (!onFrame) {
      this.emittedSamples = this.pcmLength
      return
    }
    while (this.pcmLength - this.emittedSamples >= FRAME_SAMPLES) {
      const from = this.emittedSamples
      const samples = this.pcm.slice(from, from + FRAME_SAMPLES)
      this.emittedSamples = from + FRAME_SAMPLES
      onFrame({
        samples,
        sampleRate: ANALYSIS_SAMPLE_RATE,
        timeSec: from / ANALYSIS_SAMPLE_RATE,
      })
    }
  }

  // ------------------------------------------------------------- teardown

  private async teardown(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      try {
        this.workletNode.port.close()
      } catch {
        // Ignore: port may already be closed.
      }
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null
      this.scriptNode.disconnect()
      this.scriptNode = null
    }
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (this.sink) {
      this.sink.disconnect()
      this.sink = null
    }

    if (this.recorder) {
      this.recorder.ondataavailable = null
      this.recorder.onstop = null
      this.recorder.onerror = null
      if (this.recorder.state !== 'inactive') {
        try {
          this.recorder.stop()
        } catch {
          // Ignore: nothing left to stop.
        }
      }
      this.recorder = null
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }

    if (this.ctx) {
      const ctx = this.ctx
      this.ctx = null
      if (ctx.state !== 'closed') {
        try {
          await ctx.close()
        } catch {
          // Ignore: context may already be closing.
        }
      }
    }
  }
}

/** Average all channels into a single mono block. */
function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0]
  if (channels.length === 1) return first
  const length = first.length
  const mono = new Float32Array(length)
  let used = 0
  for (const channel of channels) {
    if (channel.length !== length) continue
    for (let i = 0; i < length; i++) mono[i] += channel[i]
    used++
  }
  if (used > 1) {
    for (let i = 0; i < length; i++) mono[i] /= used
  }
  return mono
}
