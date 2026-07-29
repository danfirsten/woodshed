import { useEffect, useRef } from 'react'
import { useAppStore } from '../../state/store'
import { useThemeMode } from '../theme'

/** How many level samples of history the scroller keeps. */
const BARS = 150
/** One sample every ~60 ms → ~9 s of visible history. */
const SAMPLE_MS = 60

/** Perceptual curve — mic RMS is small and bunched up near zero. */
function shape(level: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, level)) * 1.35)
}

/**
 * Scrolling waveform history drawn from store.inputLevel on rAF.
 * Deliberately reads the store imperatively (getState) so the 60 Hz level
 * stream never re-renders React.
 */
export function WaveformCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const levels = useRef<Float32Array>(new Float32Array(BARS))
  const head = useRef(0)
  const { resolved } = useThemeMode()

  useEffect(() => {
    if (active) {
      levels.current.fill(0)
      head.current = 0
    }
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const styles = getComputedStyle(canvas)
    const accent = styles.getPropertyValue('--accent').trim() || '#c6761a'
    const quiet = styles.getPropertyValue('--line').trim() || '#e8dcc7'

    let width = 0
    let height = 0
    let raf = 0
    let lastSample = 0

    const measure = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const slot = width / BARS
      const barW = Math.max(1.5, slot * 0.58)
      const mid = height / 2
      const maxH = height * 0.92

      for (let i = 0; i < BARS; i++) {
        const v = levels.current[(head.current + i) % BARS]
        const age = i / (BARS - 1)
        const h = Math.max(2, shape(v) * maxH)
        const x = i * slot + (slot - barW) / 2
        ctx.globalAlpha = v > 0.0005 ? 0.22 + 0.78 * age : 0.18
        ctx.fillStyle = v > 0.0005 ? accent : quiet
        const r = Math.min(barW / 2, h / 2)
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, mid - h / 2, barW, h, r)
        } else {
          ctx.rect(x, mid - h / 2, barW, h)
        }
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const tick = (now: number) => {
      if (now - lastSample >= SAMPLE_MS) {
        lastSample = now
        levels.current[head.current] = useAppStore.getState().inputLevel
        head.current = (head.current + 1) % BARS
        draw()
      }
      raf = requestAnimationFrame(tick)
    }

    measure()
    draw()

    const ro = new ResizeObserver(() => {
      measure()
      draw()
    })
    ro.observe(canvas)

    if (active) raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [active, resolved])

  return (
    <canvas
      ref={canvasRef}
      className="waveform__canvas"
      role="img"
      aria-label="Live waveform history of your playing"
    />
  )
}
