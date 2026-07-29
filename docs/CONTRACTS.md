# Module contracts

Every module is being built in parallel by a separate developer. This file is the
source of truth for what each module **must export** (exact paths and signatures),
so cross-module imports line up without coordination. Shared data types live in
`src/types.ts` — read it first. Do not modify `src/types.ts`, `src/state/store.ts`,
or files outside your module.

If you import from a sibling module that doesn't exist yet, that's expected —
code against the signatures below; the build is integrated at the end.

## src/audio (audio engine)

```ts
// src/audio/engine.ts
export interface AudioEngineEvents {
  onFrame?: (frame: AudioFrame) => void      // 16 kHz mono chunks, ~128 ms each
  onLevel?: (rms: number) => void            // 0..1, throttled to ~15 Hz
}
export class AudioEngine {
  constructor(events?: AudioEngineEvents)
  start(): Promise<void>                     // requests mic, starts MediaRecorder + frame stream
  stop(): Promise<RecordingResult>           // stops everything, releases the mic
  readonly state: 'idle' | 'recording'
  readonly startedAtMs: number               // epoch ms when start() resolved
}

// src/audio/wav.ts
export function encodeWav(pcm: Float32Array, sampleRate: number): Blob
```

## src/analysis (music analysis / DSP)

```ts
// src/analysis/live.ts — cheap incremental pass fed during recording
export class LiveAnalyzer {
  constructor(onChord: (chord: ChordEvent) => void)
  pushFrame(frame: AudioFrame): void
  reset(): void
}

// src/analysis/index.ts — full refinement pass after recording stops.
// Runs in a Web Worker internally; this is the main-thread client.
export function analyzeSession(
  pcm16k: Float32Array,
  onProgress?: (p: ModelProgress) => void,
): Promise<SessionAnalysis>
```

## src/lyrics (Whisper transcription)

```ts
// src/lyrics/engine.ts — transformers.js Whisper in a Web Worker.
export function isLyricsSupported(): boolean          // WASM/WebGPU availability check
export function preloadLyricsModel(
  onProgress?: (p: ModelProgress) => void,
): Promise<void>                                      // idempotent; downloads + caches model
export function transcribeLyrics(
  pcm16k: Float32Array,
  onProgress?: (p: ModelProgress) => void,
): Promise<LyricWord[]>                               // word times absolute from pcm start
```

## src/notation (lead sheets)

```ts
// src/notation/abc.ts
export function segmentToAbc(segment: JamSegment): string   // ABC notation source

// src/notation/render.ts — non-React, usable for PDF export
export function renderSegmentSvg(segment: JamSegment, widthPx: number): SVGSVGElement

// src/notation/LeadSheet.tsx — React component for the review view
export function LeadSheet(props: { segment: JamSegment }): JSX.Element
```

## src/export + src/storage

```ts
// src/export/pdf.ts
export function exportSessionPdf(session: JamSession): Promise<Blob>
// src/export/zip.ts
export function exportSessionZip(session: JamSession, audio: Blob): Promise<Blob>
// src/export/download.ts
export function downloadBlob(blob: Blob, filename: string): void
export function audioFilename(session: JamSession): string  // extension from mimeType
export function safeFilename(title: string, ext: string): string

// src/storage/db.ts — IndexedDB persistence
export function saveSession(session: JamSession, audio: Blob): Promise<void>  // upsert
export function loadSession(id: string): Promise<{ session: JamSession; audio: Blob } | null>
export function listSessions(): Promise<SessionSummary[]>                     // newest first
export function deleteSessionById(id: string): Promise<void>
```

## src/ui (views + theme)

Owns `src/ui/App.tsx`, `src/ui/theme.css`, and any components under `src/ui/`.
Reads state from `useAppStore` (src/state/store.ts) and calls actions from
`src/app/controller.ts` only. Imports `LeadSheet` from `../notation/LeadSheet`.

## Integration (src/app/controller.ts)

Wired last, by the integrator — glues all of the above together. UI calls it as
already typed in the scaffold.
