/**
 * Minimal in-place radix-2 Cooley–Tukey FFT.
 *
 * There is no FFT dependency in the project, and the whole analysis pass is
 * spectral, so this is the one piece of maths everything else stands on. The
 * class owns its scratch buffers and twiddle tables: construct one per frame
 * size and reuse it across every frame of a session (a 30 minute session runs
 * ~100k transforms, so per-frame allocation is not an option).
 */
export class FFT {
  readonly size: number
  /** Real part of the last transform (length `size`). */
  readonly re: Float32Array
  /** Imaginary part of the last transform (length `size`). */
  readonly im: Float32Array

  private readonly cosTable: Float32Array
  private readonly sinTable: Float32Array
  private readonly reverse: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two ≥ 2 (got ${size})`)
    }
    this.size = size
    this.re = new Float32Array(size)
    this.im = new Float32Array(size)

    // Twiddle factors for the forward transform: e^(-2πik/N).
    const half = size >> 1
    this.cosTable = new Float32Array(half)
    this.sinTable = new Float32Array(half)
    for (let k = 0; k < half; k++) {
      const angle = (-2 * Math.PI * k) / size
      this.cosTable[k] = Math.cos(angle)
      this.sinTable[k] = Math.sin(angle)
    }

    // Bit-reversal permutation table.
    const bits = Math.log2(size) | 0
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | ((i >>> b) & 1)
      }
      this.reverse[i] = r
    }
  }

  /**
   * Transform a real-valued signal. `input` is read from `offset` for `size`
   * samples; anything past the end of `input` is treated as zero (so the tail
   * of a buffer is zero-padded rather than skipped). Results land in
   * `this.re` / `this.im`.
   */
  forwardReal(input: Float32Array, offset = 0): void {
    const { size, re, im, reverse } = this
    const available = Math.max(0, Math.min(size, input.length - offset))
    for (let i = 0; i < size; i++) {
      const src = reverse[i]
      re[i] = src < available ? input[offset + src] : 0
      im[i] = 0
    }
    this.transform()
  }

  /**
   * Transform a real-valued signal multiplied element-wise by `window`
   * (which must have length `size`). Saves a pass over the data compared with
   * windowing into a scratch buffer first.
   */
  forwardWindowed(input: Float32Array, offset: number, window: Float32Array): void {
    const { size, re, im, reverse } = this
    const available = Math.max(0, Math.min(size, input.length - offset))
    for (let i = 0; i < size; i++) {
      const src = reverse[i]
      re[i] = src < available ? input[offset + src] * window[src] : 0
      im[i] = 0
    }
    this.transform()
  }

  /** Butterfly passes over the already bit-reversed `re`/`im` buffers. */
  private transform(): void {
    const { size, re, im, cosTable, sinTable } = this
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const step = size / len
      for (let base = 0; base < size; base += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cosTable[k]
          const wi = sinTable[k]
          const a = base + j
          const b = a + half
          const br = re[b]
          const bi = im[b]
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }

  /**
   * Write the magnitude spectrum of the last transform into `out`, which must
   * have length `size / 2 + 1` (bins 0..Nyquist; the rest is the mirror image).
   */
  magnitudes(out: Float32Array): void {
    const { re, im } = this
    const bins = (this.size >> 1) + 1
    for (let k = 0; k < bins; k++) {
      out[k] = Math.hypot(re[k], im[k])
    }
  }
}

/** Periodic Hann window of the given length. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return w
}

/** Largest power of two ≤ `n` (minimum 2). */
export function floorPow2(n: number): number {
  let p = 2
  while (p * 2 <= n) p *= 2
  return p
}
