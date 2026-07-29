/**
 * React wrapper around the abcjs renderer for the review view.
 *
 * Re-renders when the segment or the available width changes, and degrades to
 * a plain chord/lyric card if abcjs chokes on the input.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JamSegment } from '../types'
import { segmentToAbc } from './abc'
import { RENDER_PADDING, applyCurrentColor, finalizeSvg, renderOptions } from './render'
import abcjs from 'abcjs'

const MIN_STAFF_WIDTH = 180
const DEFAULT_WIDTH = 720

export function LeadSheet(props: { segment: JamSegment }): JSX.Element {
  const { segment } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const paperRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [failed, setFailed] = useState(false)

  const abc = useMemo(() => segmentToAbc(segment), [segment])

  // Track the container width so the staff fills whatever space the UI gives us.
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const measure = (): void => {
      const next = node.clientWidth || node.getBoundingClientRect().width
      if (next > 0) setWidth((prev) => (Math.abs(prev - next) > 1 ? next : prev))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const paper = paperRef.current
    if (!paper) return
    const usable = width > 0 ? width : DEFAULT_WIDTH
    const staffWidth = Math.max(MIN_STAFF_WIDTH, Math.round(usable - RENDER_PADDING * 2))

    paper.innerHTML = ''
    try {
      abcjs.renderAbc(paper, abc, renderOptions(staffWidth))
      const svg = paper.querySelector('svg')
      if (!(svg instanceof SVGSVGElement)) throw new Error('abcjs produced no SVG')
      finalizeSvg(svg, usable)
      applyCurrentColor(svg)
      setFailed(false)
    } catch {
      paper.innerHTML = ''
      setFailed(true)
    }
  }, [abc, width])

  return (
    <div className="leadsheet" ref={containerRef}>
      <div className="leadsheet-paper" ref={paperRef} hidden={failed} />
      {failed ? <LeadSheetFallback segment={segment} /> : null}
    </div>
  )
}

/** Plain-text rescue view: chord chips plus the lyric line. */
function LeadSheetFallback(props: { segment: JamSegment }): JSX.Element {
  const { segment } = props
  const chords = (segment.chords ?? []).map((c) => c?.symbol).filter((s): s is string => !!s)
  const lyrics = (segment.lyrics ?? [])
    .map((w) => w?.text)
    .filter((t): t is string => !!t)
    .join(' ')

  return (
    <div className="leadsheet-fallback">
      <p className="leadsheet-fallback-note">Couldn’t engrave this idea — here’s what we heard.</p>
      {chords.length > 0 ? (
        <ul className="leadsheet-chips">
          {chords.map((symbol, i) => (
            <li className="leadsheet-chip" key={`${symbol}-${i}`}>
              {symbol}
            </li>
          ))}
        </ul>
      ) : null}
      {lyrics ? <p className="leadsheet-lyrics">{lyrics}</p> : null}
      {chords.length === 0 && !lyrics ? <p className="leadsheet-lyrics">(no notation yet)</p> : null}
    </div>
  )
}

export default LeadSheet
