/**
 * Tunables for the in-browser Whisper transcription pipeline.
 * Shared between the main-thread client (engine.ts) and the worker.
 */

/** ~40 MB (int8) English-only Whisper. Cached by transformers.js in the browser. */
export const LYRICS_MODEL_ID = 'Xenova/whisper-tiny.en'

/**
 * Quantised weights for BOTH devices, so a WebGPU -> WASM fallback reuses the
 * exact same cached files instead of re-downloading a different precision.
 */
export const LYRICS_MODEL_DTYPE = 'q8'

/** Whisper's native window. The pipeline slides this across long audio. */
export const CHUNK_LENGTH_SEC = 30

/** Overlap between consecutive windows, used to stitch word timings. */
export const STRIDE_LENGTH_SEC = 5

/** The analysis PCM rate Whisper expects (mirrors ANALYSIS_SAMPLE_RATE). */
export const LYRICS_SAMPLE_RATE = 16000
