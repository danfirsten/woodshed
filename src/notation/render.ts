/**
 * Non-React rendering of a jam segment to an SVG element.
 *
 * Used by the review UI (via LeadSheet) and by the PDF exporter, which
 * rasterises the returned node — so the SVG always carries explicit
 * width/height attributes.
 */

import abcjs from 'abcjs'
import type { AbcVisualParams } from 'abcjs'
import type { JamSegment } from '../types'
import { segmentToAbc } from './abc'

/** Horizontal breathing room left inside the staff area, in px. */
export const RENDER_PADDING = 10
const MIN_STAFF_WIDTH = 180
const DEFAULT_WIDTH = 720

/** Colours abcjs may emit that should follow the theme instead. */
const BLACKISH = /^(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i

/**
 * Rewrite hard-coded black fills/strokes to `currentColor` so the sheet is
 * legible in both light and dark themes. Safe to call on any SVG subtree.
 */
export function applyCurrentColor(root: SVGSVGElement): void {
  const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const node of nodes) {
    for (const attr of ['fill', 'stroke'] as const) {
      const value = node.getAttribute(attr)
      if (value && BLACKISH.test(value.trim())) node.setAttribute(attr, 'currentColor')
    }
    const styled = node as unknown as { style?: CSSStyleDeclaration }
    const style = styled.style
    if (style) {
      if (style.fill && BLACKISH.test(style.fill.trim())) style.fill = 'currentColor'
      if (style.stroke && BLACKISH.test(style.stroke.trim())) style.stroke = 'currentColor'
    }
  }
  // Elements abcjs leaves unpainted inherit black from the UA; make the whole
  // tree default to the surrounding text colour instead.
  if (!root.getAttribute('fill')) root.setAttribute('fill', 'currentColor')
  root.style.color = 'inherit'
}

/** abcjs render options shared by every call site. */
export function renderOptions(staffWidthPx: number): AbcVisualParams {
  return {
    staffwidth: staffWidthPx,
    // Explicitly *not* 'resize': responsive mode strips width/height, which the
    // PDF exporter needs.
    responsive: undefined,
    add_classes: true,
    paddingleft: RENDER_PADDING,
    paddingright: RENDER_PADDING,
    paddingtop: 4,
    paddingbottom: 12,
    foregroundColor: 'currentColor',
    selectTypes: false,
    dragging: false,
    format: { gchordfont: '"Helvetica,Arial,sans-serif" 13', vocalfont: '"Georgia,serif" 13' },
  }
}

/**
 * Render one segment and return a detached `<svg>` element.
 *
 * Rendering happens in a throwaway div. When a document body is available the
 * div is briefly parked off-screen so abcjs can measure real text metrics
 * (detached nodes make `getBBox` return 0 and abcjs falls back to estimates);
 * it is removed again before returning, so the caller always gets a detached
 * node it fully owns.
 */
export function renderSegmentSvg(segment: JamSegment, widthPx: number): SVGSVGElement {
  const width = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : DEFAULT_WIDTH
  const staffWidth = Math.max(MIN_STAFF_WIDTH, Math.round(width - RENDER_PADDING * 2))

  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.style.width = `${Math.round(width)}px`
  host.setAttribute('aria-hidden', 'true')

  const body = typeof document !== 'undefined' ? document.body : null
  if (body) body.appendChild(host)
  try {
    abcjs.renderAbc(host, segmentToAbc(segment), renderOptions(staffWidth))
    const svg = host.querySelector('svg')
    const result = svg instanceof SVGSVGElement ? svg : placeholderSvg(width)
    result.remove()
    finalizeSvg(result, width)
    return result
  } catch {
    const fallback = placeholderSvg(width)
    finalizeSvg(fallback, width)
    return fallback
  } finally {
    host.remove()
  }
}

/** Guarantee explicit pixel dimensions + theme-aware colours. */
export function finalizeSvg(svg: SVGSVGElement, fallbackWidth: number): SVGSVGElement {
  const viewBox = svg.getAttribute('viewBox')
  const parts = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number) : []
  const boxWidth = parts.length === 4 && parts[2] > 0 ? parts[2] : fallbackWidth
  const boxHeight = parts.length === 4 && parts[3] > 0 ? parts[3] : 120

  const width = numericAttr(svg, 'width') ?? boxWidth
  const height = numericAttr(svg, 'height') ?? boxHeight
  svg.setAttribute('width', String(Math.round(width)))
  svg.setAttribute('height', String(Math.round(height)))
  if (!viewBox) svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // Let CSS scale it down inside narrow containers without distorting.
  svg.style.maxWidth = '100%'
  svg.style.height = 'auto'
  applyCurrentColor(svg)
  return svg
}

function numericAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name)
  if (!raw) return null
  const value = parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Minimal stand-in used when abcjs produces nothing at all. */
function placeholderSvg(width: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  const height = 48
  svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${height}`)
  const text = document.createElementNS(ns, 'text')
  text.setAttribute('x', '8')
  text.setAttribute('y', '28')
  text.setAttribute('fill', 'currentColor')
  text.setAttribute('font-size', '13')
  text.textContent = 'Notation unavailable for this idea.'
  svg.appendChild(text)
  return svg
}
