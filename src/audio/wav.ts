/**
 * Minimal WAV encoder — 16-bit signed PCM, mono, little-endian.
 *
 * Used for handing raw analysis audio to anything that speaks WAV
 * (downloads, ZIP exports, debugging) without pulling in a dependency.
 */

const WAV_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2
const NUM_CHANNELS = 1
const FORMAT_PCM = 1

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i) & 0x7f)
  }
}

/** Clamp to [-1, 1] and scale to a 16-bit signed integer. */
function toInt16(sample: number): number {
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

/**
 * Encode mono float samples (nominally -1..1) as a 16-bit PCM WAV blob.
 *
 * @param pcm Mono samples; values outside -1..1 are clipped.
 * @param sampleRate Sample rate in Hz (rounded to an integer for the header).
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const rate = Math.max(1, Math.round(sampleRate))
  const frameCount = pcm.length
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE
  const byteRate = rate * blockAlign
  const dataBytes = frameCount * BYTES_PER_SAMPLE

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  // "fmt " sub-chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, FORMAT_PCM, true)
  view.setUint16(22, NUM_CHANNELS, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true)

  // "data" sub-chunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < frameCount; i++) {
    view.setInt16(offset, toInt16(pcm[i]), true)
    offset += BYTES_PER_SAMPLE
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
