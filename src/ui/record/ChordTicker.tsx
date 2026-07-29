import { useEffect, useRef } from 'react'
import { useAppStore } from '../../state/store'
import { formatTime } from '../../types'

const MAX_CHIPS = 24

/** Live chord chips, oldest → newest, newest highlighted and auto-scrolled into view. */
export function ChordTicker() {
  const chords = useAppStore((s) => s.liveChords)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const count = chords.length

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [count])

  const visible = count > MAX_CHIPS ? chords.slice(count - MAX_CHIPS) : chords

  return (
    <section className="ticker" aria-label="Chords detected so far">
      <div className="ticker__head">
        <span className="eyebrow">Hearing</span>
        <span className="ticker__count tabular">
          {count} {count === 1 ? 'chord' : 'chords'}
        </span>
      </div>

      <div className="ticker__scroller" ref={scrollerRef}>
        {visible.length === 0 ? (
          <p className="ticker__empty">Listening for the first chord…</p>
        ) : (
          <ul className="ticker__list">
            {visible.map((chord, i) => {
              const latest = i === visible.length - 1
              return (
                <li
                  key={`${chord.startSec}-${chord.symbol}-${i}`}
                  className={`chordchip${latest ? ' chordchip--latest' : ''}`}
                  style={{ opacity: latest ? 1 : 0.45 + (0.55 * (i + 1)) / visible.length }}
                  title={`${chord.symbol} at ${formatTime(chord.startSec)}`}
                >
                  <span className="chordchip__symbol">{chord.symbol}</span>
                  <span className="chordchip__time tabular">{formatTime(chord.startSec)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
