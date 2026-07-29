/**
 * PDF export — turns a JamSession into a printable lead-sheet booklet.
 *
 * Layout (A4 portrait, points):
 *   page 1   header block (title, when, duration, idea count) + an index of
 *            every segment
 *   then     one section per segment: heading + rasterized lead sheet
 *            (+ lyrics as plain text when present)
 *   footer   on every page, filled in on a second pass once the page count
 *            is known.
 *
 * The lead sheet comes back from the notation module as a live SVG element, so
 * we rasterize it to PNG on a canvas before handing it to jsPDF (jsPDF has no
 * native SVG support without extra plugins).
 */
import { jsPDF } from 'jspdf'
import { formatTime, type JamSegment, type JamSession } from '../types'
import { renderSegmentSvg } from '../notation/render'

/** Page margin in pt (A4 is 595.28 x 841.89 pt). */
const MARGIN = 48
/** Reserve for the footer, inside the bottom margin. */
const FOOTER_BASELINE_FROM_BOTTOM = 26
/** Nominal CSS pixel width we ask the notation module to render at. */
const SHEET_RENDER_WIDTH = 1400
/** Canvas oversampling so the sheet stays crisp when printed. */
const RASTER_SCALE = 2
/** Give up on a single sheet rather than hanging the whole export. */
const IMAGE_TIMEOUT_MS = 15_000

/** Build the session PDF. Never throws for a single bad segment. */
export async function exportSessionPdf(session: JamSession): Promise<Blob> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true })

  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const contentW = pageW - MARGIN * 2
  const contentBottom = pageH - MARGIN
  const maxContentH = contentBottom - MARGIN

  let y = MARGIN

  /** Move to a fresh page when `needed` pt won't fit below the cursor. */
  const ensureSpace = (needed: number): void => {
    if (y + needed > contentBottom) {
      doc.addPage()
      y = MARGIN
    }
  }

  /** Draw wrapped text, paginating line by line. Returns the new cursor. */
  const writeLines = (
    text: string,
    opts: { size: number; bold?: boolean; leading: number; gray?: number; width?: number },
  ): void => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal')
    doc.setFontSize(opts.size)
    doc.setTextColor(opts.gray ?? 20)
    const lines = doc.splitTextToSize(text, opts.width ?? contentW) as string[]
    for (const line of lines) {
      ensureSpace(opts.leading)
      doc.text(line, MARGIN, y + opts.size * 0.8)
      y += opts.leading
    }
  }

  const rule = (gap = 10): void => {
    ensureSpace(gap * 2)
    y += gap
    doc.setDrawColor(210)
    doc.setLineWidth(0.6)
    doc.line(MARGIN, y, MARGIN + contentW, y)
    y += gap
  }

  const title = cleanText(session.title) || 'Untitled jam'
  const segments = session.segments ?? []

  // ---- Header block -------------------------------------------------------
  writeLines(title, { size: 22, bold: true, leading: 27 })
  y += 4

  const started = new Date(session.startedAt)
  const when = Number.isFinite(session.startedAt) ? started.toLocaleString() : 'Unknown date'
  writeLines(`Recorded ${when}`, { size: 10.5, leading: 15, gray: 95 })
  writeLines(
    `${formatTime(session.durationSec)} total · ${segments.length} ${
      segments.length === 1 ? 'idea' : 'ideas'
    }`,
    { size: 10.5, leading: 15, gray: 95 },
  )

  rule(12)

  // ---- Index --------------------------------------------------------------
  writeLines('Ideas in this jam', { size: 12, bold: true, leading: 18 })
  y += 2

  if (segments.length === 0) {
    writeLines('No musical ideas were detected in this session.', {
      size: 10.5,
      leading: 15,
      gray: 95,
    })
  } else {
    for (let i = 0; i < segments.length; i++) {
      writeLines(indexLine(segments[i], i), { size: 10, leading: 14.5, gray: 55 })
    }
  }

  // ---- One section per segment -------------------------------------------
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    // Keep a heading from stranding itself at the very bottom of a page.
    ensureSpace(96)
    rule(14)

    writeLines(segmentTitle(segment, i), { size: 14, bold: true, leading: 20 })
    writeLines(segmentSubtitle(segment), { size: 10, leading: 15, gray: 95 })
    y += 6

    try {
      const sheet = await renderSheetPng(segment)
      let drawW = contentW
      let drawH = (sheet.height / sheet.width) * contentW

      // A very tall sheet gets scaled down to a single full page.
      if (drawH > maxContentH) {
        const factor = maxContentH / drawH
        drawH = maxContentH
        drawW = drawW * factor
      }
      if (y + drawH > contentBottom) {
        doc.addPage()
        y = MARGIN
      }

      doc.addImage(sheet.dataUrl, 'PNG', MARGIN, y, drawW, drawH, undefined, 'FAST')
      y += drawH + 8
    } catch {
      writeLines('(could not render notation)', { size: 10, leading: 16, gray: 130 })
    }

    const lyrics = lyricsText(segment)
    if (lyrics) {
      y += 4
      writeLines('Lyrics', { size: 10.5, bold: true, leading: 15, gray: 60 })
      writeLines(lyrics, { size: 10.5, leading: 15 })
    }

    y += 6
  }

  // ---- Footers (second pass — page count is only known now) ---------------
  const totalPages = doc.getNumberOfPages()
  const footerLeft = truncate(`Woodshed · ${title}`, 72)
  const footerY = pageH - FOOTER_BASELINE_FROM_BOTTOM
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(140)
    doc.setDrawColor(225)
    doc.setLineWidth(0.5)
    doc.line(MARGIN, footerY - 11, MARGIN + contentW, footerY - 11)
    doc.text(footerLeft, MARGIN, footerY)
    doc.text(`Page ${p} of ${totalPages}`, MARGIN + contentW, footerY, { align: 'right' })
  }

  return doc.output('blob')
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** "Idea 1" or the user's label. */
function segmentTitle(segment: JamSegment, position: number): string {
  const label = cleanText(segment.label ?? '')
  return label || `Idea ${ordinal(segment, position)}`
}

function ordinal(segment: JamSegment, position: number): number {
  return Number.isFinite(segment.index) ? segment.index + 1 : position + 1
}

function timeRange(segment: JamSegment): string {
  return `${formatTime(segment.startSec)} – ${formatTime(segment.endSec)}`
}

function keyLabel(segment: JamSegment): string | null {
  const key = segment.keyGuess
  return key && key.tonic ? `${key.tonic} ${key.mode}` : null
}

function tempoLabel(segment: JamSegment): string | null {
  const bpm = segment.tempoBpm
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0
    ? `${Math.round(bpm)} BPM`
    : null
}

/** "Idea 1 · 0:00 – 1:24 · A minor · 92 BPM" */
function indexLine(segment: JamSegment, position: number): string {
  return [segmentTitle(segment, position), timeRange(segment), keyLabel(segment), tempoLabel(segment)]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** The heading's second line — everything but the name. */
function segmentSubtitle(segment: JamSegment): string {
  return [timeRange(segment), keyLabel(segment), tempoLabel(segment)]
    .filter((part): part is string => Boolean(part))
    .join('  ·  ')
}

function lyricsText(segment: JamSegment): string {
  const words = segment.lyrics ?? []
  return words
    .map((w) => String(w.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanText(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// SVG -> PNG rasterization
// ---------------------------------------------------------------------------

interface RasterizedSheet {
  dataUrl: string
  /** CSS-pixel dimensions of the source SVG (used for aspect ratio). */
  width: number
  height: number
}

/** Render one segment's lead sheet and rasterize it onto a white canvas. */
async function renderSheetPng(segment: JamSegment): Promise<RasterizedSheet> {
  if (typeof document === 'undefined') {
    throw new Error('Lead sheets can only be rendered in a browser window.')
  }

  const svg = renderSegmentSvg(segment, SHEET_RENDER_WIDTH)
  if (!svg) throw new Error('The notation renderer returned nothing for this idea.')

  const { width, height } = normalizeSvgSize(svg, SHEET_RENDER_WIDTH)
  const source = new XMLSerializer().serializeToString(svg)
  const image = await loadImage(svgDataUrl(source))

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * RASTER_SCALE))
  canvas.height = Math.max(1, Math.round(height * RASTER_SCALE))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser would not give us a 2D canvas for the lead sheet.')

  // The sheet may draw with `currentColor` / transparent background — paint
  // white first so nothing disappears into the PDF page.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return { dataUrl: canvas.toDataURL('image/png'), width, height }
}

/**
 * Make sure the SVG carries explicit width/height (and a viewBox) so it
 * rasterizes at a predictable size once detached from the document.
 */
function normalizeSvgSize(svg: SVGSVGElement, fallbackWidth: number): {
  width: number
  height: number
} {
  let width = parseLength(svg.getAttribute('width'))
  let height = parseLength(svg.getAttribute('height'))

  const viewBox = parseViewBox(svg.getAttribute('viewBox'))
  if ((!width || !height) && viewBox) {
    width = width || viewBox.width
    height = height || viewBox.height
  }

  if (!width || !height) {
    const measured = measureInDocument(svg)
    width = width || measured.width
    height = height || measured.height
  }

  if (!width) width = fallbackWidth
  if (!height) height = Math.round(fallbackWidth * 0.35)

  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  if (!viewBox) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  // Standalone SVG has no page stylesheet: pin the ink colour `currentColor`
  // resolves against, and undo any responsive sizing (the notation module ships
  // `max-width:100%;height:auto`, which would fight the explicit size above).
  const style = svg.getAttribute('style') ?? ''
  svg.setAttribute(
    'style',
    `${style};width:${width}px;height:${height}px;max-width:none;color:#111111;background:transparent`,
  )

  return { width, height }
}

function parseLength(value: string | null): number {
  if (!value) return 0
  const trimmed = value.trim()
  if (trimmed.endsWith('%')) return 0
  const n = Number.parseFloat(trimmed)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function parseViewBox(value: string | null): { width: number; height: number } | null {
  if (!value) return null
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [, , width, height] = parts
  return width > 0 && height > 0 ? { width, height } : null
}

/** Last-resort sizing: drop a clone off-screen and ask the layout engine. */
function measureInDocument(svg: SVGSVGElement): { width: number; height: number } {
  if (typeof document === 'undefined' || !document.body) return { width: 0, height: 0 }
  const host = document.createElement('div')
  host.setAttribute(
    'style',
    'position:absolute;left:-99999px;top:0;width:2000px;height:2000px;visibility:hidden;pointer-events:none',
  )
  const clone = svg.cloneNode(true) as SVGSVGElement
  host.appendChild(clone)
  document.body.appendChild(host)
  try {
    const box = clone.getBBox()
    const rect = clone.getBoundingClientRect()
    return {
      width: Math.ceil(Math.max(box.x + box.width, rect.width)) || 0,
      height: Math.ceil(Math.max(box.y + box.height, rect.height)) || 0,
    }
  } catch {
    return { width: 0, height: 0 }
  } finally {
    host.remove()
  }
}

/** UTF-8 safe `data:` URL for an SVG source string. */
function svgDataUrl(source: string): string {
  const withHeader = source.startsWith('<?xml') ? source : `<?xml version="1.0" encoding="UTF-8"?>${source}`
  return `data:image/svg+xml;base64,${utf8ToBase64(withHeader)}`
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => {
      img.src = ''
      reject(new Error('Timed out while drawing the lead sheet.'))
    }, IMAGE_TIMEOUT_MS)
    img.onload = () => {
      clearTimeout(timer)
      resolve(img)
    }
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('The lead sheet image could not be decoded.'))
    }
    img.decoding = 'sync'
    img.src = src
  })
}
