import { useEffect, useRef } from 'react'
import { useAppStore } from '../../state/store'

/**
 * Input level meter with a decaying peak marker. Driven by rAF straight from
 * the store so the fast level stream never triggers a React render.
 */
export function LevelMeter({ active }: { active: boolean }) {
  const fillRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    let smoothed = 0
    let peak = 0

    const tick = () => {
      const raw = active ? useAppStore.getState().inputLevel : 0
      const target = Math.min(1, Math.sqrt(Math.max(0, raw)) * 1.35)
      // Fast attack, slow release — reads like a real meter.
      smoothed += (target - smoothed) * (target > smoothed ? 0.5 : 0.12)
      peak = target > peak ? target : Math.max(smoothed, peak - 0.006)

      if (fillRef.current) fillRef.current.style.transform = `scaleX(${smoothed.toFixed(3)})`
      if (peakRef.current) peakRef.current.style.left = `${(peak * 100).toFixed(2)}%`
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return (
    <div className="levelmeter" aria-hidden="true">
      <div className="levelmeter__track">
        <div className="levelmeter__fill" ref={fillRef} />
        <div className="levelmeter__peak" ref={peakRef} />
      </div>
      <span className="levelmeter__label">Input</span>
    </div>
  )
}
