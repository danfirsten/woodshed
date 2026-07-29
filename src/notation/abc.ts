/**
 * Jam segment -> ABC notation source.
 *
 * A jam is messy: tempo may be unknown, the melody may be missing entirely,
 * lyrics may be absent, chords may be sparse. This module always produces a
 * musically sensible, syntactically valid lead sheet for every combination.
 *
 * Strategy (see README of the module in the report):
 *   melody present            -> real note line, chord annotations, w: lyric lines
 *   no melody + lyrics        -> rhythm-slash anchors (one per word) carrying the words
 *   no melody + chords only   -> rhythm-slash rests carrying the chord symbols
 *   nothing at all            -> one empty bar
 *
 * Everything is quantised onto an eighth-note grid: 30/bpm seconds when a tempo
 * is known, a nominal 0.25 s otherwise (rubato). Meter is always 4/4 because
 * free meter renders badly in abcjs.
 */

import type { ChordEvent, JamSegment, KeyGuess, LyricWord, NoteEvent } from '../types'

/** We always write 4/4 with L:1/8, so a bar is 8 grid slots. */
const EIGHTHS_PER_BAR = 8
/** Bars per printed system — keeps lyric lines aligned and readable. */
const BARS_PER_LINE = 4
/** Hard cap so pathological input can never produce a thousand-bar page. */
const MAX_BARS = 64
/** Grid resolution used when the tempo is unknown (rubato jams). */
const NOMINAL_EIGHTH_SEC = 0.25
const MIN_BPM = 30
const MAX_BPM = 300
/** B4 — middle line of the treble staff; used for pitch-less anchors. */
const ANCHOR_MIDI = 71
const ANCHOR_ABC = 'B'
/** Note values (in eighths) that can be drawn as a single note head. */
const WRITABLE_DURATIONS = [8, 6, 4, 3, 2, 1]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render one jam segment as ABC notation source. Never throws. */
export function segmentToAbc(segment: JamSegment): string {
  try {
    return buildAbc(segment)
  } catch {
    // Absolute last resort: a valid, empty lead sheet.
    return emptyAbc(safeTitle(segment))
  }
}

// ---------------------------------------------------------------------------
// Grid model
// ---------------------------------------------------------------------------

type ElKind = 'note' | 'rest'

/** One element on the quantised grid. Elements tile [0, total) with no gaps. */
interface GridEl {
  kind: ElKind
  /** Start in grid slots (eighth notes) from the beginning of the segment. */
  start: number
  /** Duration in grid slots, always >= 1. */
  dur: number
  /** MIDI pitch — only for `note`. */
  midi?: number
  /**
   * Pre-spelled pitch, used for pitch-less anchors: their staff position is
   * arbitrary, so they must not pick up key-signature accidentals.
   */
  literal?: string
  /** Already-sanitised chord symbol to print above this element. */
  chord?: string
  /** Already-escaped lyric syllable to print under this element. */
  word?: string
}

function buildAbc(segment: JamSegment): string {
  const eighth = eighthSeconds(segment)
  const origin = Number.isFinite(segment.startSec) ? segment.startSec : 0
  const toSlot = (sec: number): number => {
    if (!Number.isFinite(sec)) return 0
    return Math.max(0, Math.round((sec - origin) / eighth))
  }

  const notes = usableNotes(segment.notes)
  const chords = usableChords(segment.chords)
  const words = usableWords(segment.lyrics)

  if (notes.length === 0 && chords.length === 0 && words.length === 0) {
    return emptyAbc(safeTitle(segment))
  }

  const key = resolveKey(segment.keyGuess)
  const spelling = buildSpelling(key)

  // Pitch-less charts (no melody) are drawn as rhythm slashes, which is what a
  // real lead sheet does when only the harmony matters.
  const rhythmStyle = notes.length === 0

  const els = rhythmStyle
    ? buildRhythmElements(chords, words, toSlot)
    : buildMelodyElements(notes, toSlot)

  if (els.length === 0) return emptyAbc(safeTitle(segment))

  attachChords(els, chords, toSlot)
  const hasWords = attachWords(els, words, toSlot)

  const body = serialize(els, key, spelling, hasWords)
  const headers = buildHeaders(segment, key, rhythmStyle)
  return [...headers, ...body].join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Input cleaning
// ---------------------------------------------------------------------------

function eighthSeconds(segment: JamSegment): number {
  const bpm = segment.tempoBpm
  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) {
    return 30 / Math.min(MAX_BPM, Math.max(MIN_BPM, bpm))
  }
  return NOMINAL_EIGHTH_SEC
}

function usableNotes(notes: readonly NoteEvent[] | undefined): NoteEvent[] {
  if (!Array.isArray(notes)) return []
  return notes
    .filter(
      (n): n is NoteEvent =>
        !!n &&
        Number.isFinite(n.startSec) &&
        Number.isFinite(n.midi) &&
        n.midi >= 12 &&
        n.midi <= 120,
    )
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
}

function usableChords(chords: readonly ChordEvent[] | undefined): ChordEvent[] {
  if (!Array.isArray(chords)) return []
  const sorted = chords
    .filter((c): c is ChordEvent => !!c && Number.isFinite(c.startSec) && !!sanitizeChord(c.symbol))
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
  // Collapse runs of the same symbol into one.
  const out: ChordEvent[] = []
  for (const c of sorted) {
    const prev = out[out.length - 1]
    if (prev && sanitizeChord(prev.symbol) === sanitizeChord(c.symbol)) {
      out[out.length - 1] = { ...prev, endSec: Math.max(prev.endSec, c.endSec) }
    } else {
      out.push(c)
    }
  }
  return out
}

function usableWords(words: readonly LyricWord[] | undefined): LyricWord[] {
  if (!Array.isArray(words)) return []
  return words
    .filter((w): w is LyricWord => !!w && Number.isFinite(w.startSec) && !!sanitizeLyric(w.text))
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
}

// ---------------------------------------------------------------------------
// Element construction
// ---------------------------------------------------------------------------

/** Melody: quantise notes, make them monophonic, fill the gaps with rests. */
function buildMelodyElements(notes: NoteEvent[], toSlot: (s: number) => number): GridEl[] {
  const raw: GridEl[] = []
  for (const n of notes) {
    const start = toSlot(n.startSec)
    const end = Math.max(start + 1, toSlot(Math.max(n.endSec, n.startSec)))
    raw.push({ kind: 'note', start, dur: end - start, midi: Math.round(n.midi) })
  }
  return finishElements(raw)
}

/**
 * No melody. Words (when present) become slash anchors so they have something
 * to sit under; otherwise the chord spans themselves are the rhythm.
 */
function buildRhythmElements(
  chords: ChordEvent[],
  words: LyricWord[],
  toSlot: (s: number) => number,
): GridEl[] {
  const raw: GridEl[] = []
  if (words.length > 0) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      const start = toSlot(w.startSec)
      const ownEnd = Math.max(start + 1, toSlot(Math.max(w.endSec, w.startSec)))
      const nextStart = i + 1 < words.length ? toSlot(words[i + 1].startSec) : Infinity
      const end = Math.min(ownEnd, Math.max(start + 1, nextStart), start + EIGHTHS_PER_BAR)
      raw.push({ kind: 'note', start, dur: end - start, midi: ANCHOR_MIDI, literal: ANCHOR_ABC })
    }
  } else {
    for (const c of chords) {
      const start = toSlot(c.startSec)
      const end = Math.max(start + 1, toSlot(Math.max(c.endSec, c.startSec)))
      raw.push({ kind: 'rest', start, dur: end - start })
    }
  }
  return finishElements(raw)
}

/**
 * Sort, de-overlap, pad to whole bars and fill every gap with a rest so the
 * result tiles [0, total) exactly.
 */
function finishElements(raw: GridEl[]): GridEl[] {
  const items = raw.filter((e) => e.dur > 0).sort((a, b) => a.start - b.start || a.dur - b.dur)

  // Make the line monophonic: truncate anything that runs into its successor.
  const mono: GridEl[] = []
  for (const el of items) {
    const prev = mono[mono.length - 1]
    if (prev) {
      if (el.start < prev.start + prev.dur) {
        const trimmed = el.start - prev.start
        if (trimmed <= 0) continue // fully shadowed — drop it
        prev.dur = trimmed
      }
    }
    mono.push({ ...el })
  }
  if (mono.length === 0) return []

  const contentEnd = mono.reduce((m, e) => Math.max(m, e.start + e.dur), 0)
  let bars = Math.ceil(contentEnd / EIGHTHS_PER_BAR)
  bars = Math.min(MAX_BARS, Math.max(1, bars))
  const total = bars * EIGHTHS_PER_BAR

  const out: GridEl[] = []
  let cursor = 0
  for (const el of mono) {
    if (el.start >= total) break
    if (el.start > cursor) out.push({ kind: 'rest', start: cursor, dur: el.start - cursor })
    const dur = Math.min(el.dur, total - el.start)
    if (dur <= 0) break
    out.push({ ...el, dur })
    cursor = el.start + dur
  }
  if (cursor < total) out.push({ kind: 'rest', start: cursor, dur: total - cursor })
  return out
}

// ---------------------------------------------------------------------------
// Chord + lyric attachment (monotone nearest-in-time matching)
// ---------------------------------------------------------------------------

function attachChords(els: GridEl[], chords: ChordEvent[], toSlot: (s: number) => number): void {
  if (chords.length === 0 || els.length === 0) return
  let p = 0
  for (const c of chords) {
    const slot = toSlot(c.startSec)
    while (p + 1 < els.length && distance(els[p + 1], slot) < distance(els[p], slot)) p++
    if (p >= els.length) break
    const symbol = sanitizeChord(c.symbol)
    if (!symbol) continue
    if (els[p].chord === undefined) els[p].chord = symbol
    // Only advance past an element once it carries a chord, so two chords never
    // collapse onto one note head.
    if (p + 1 < els.length) p++
  }
}

/**
 * Words only ever land on notes — a rest cannot carry a syllable in ABC.
 * @returns whether at least one word was placed.
 */
function attachWords(els: GridEl[], words: LyricWord[], toSlot: (s: number) => number): boolean {
  if (words.length === 0) return false
  const targets: number[] = []
  for (let i = 0; i < els.length; i++) {
    if (els[i].kind === 'note') targets.push(i)
  }
  if (targets.length === 0) return false

  let placed = false
  let p = 0
  for (const w of words) {
    const slot = toSlot(w.startSec)
    while (
      p + 1 < targets.length &&
      distance(els[targets[p + 1]], slot) < distance(els[targets[p]], slot)
    ) {
      p++
    }
    if (p >= targets.length) break
    const text = sanitizeLyric(w.text)
    if (!text) continue
    const el = els[targets[p]]
    if (el.word === undefined && el.kind === 'note') {
      el.word = text
      placed = true
    }
    if (p + 1 < targets.length) p++
  }
  return placed
}

function distance(el: GridEl, slot: number): number {
  if (slot >= el.start && slot < el.start + el.dur) return 0
  return slot < el.start ? el.start - slot : slot - (el.start + el.dur) + 1
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

interface KeyInfo {
  /** Value for the K: field, e.g. "Bb" or "F#m". */
  name: string
  /** Per-letter alteration implied by the key signature (-1, 0, +1). */
  alter: Record<string, number>
  /** Signed count: positive = sharps, negative = flats. */
  fifths: number
}

interface Spelling {
  letter: string
  alter: number
}

function serialize(
  els: GridEl[],
  key: KeyInfo,
  spelling: Map<number, Spelling>,
  hasWords: boolean,
): string[] {
  const total = els.reduce((m, e) => Math.max(m, e.start + e.dur), 0)
  const bars = Math.max(1, Math.ceil(total / EIGHTHS_PER_BAR))

  // Slice every element at bar lines so nothing straddles a bar.
  interface Piece {
    el: GridEl
    start: number
    dur: number
    first: boolean
    last: boolean
  }
  const perBar: Piece[][] = Array.from({ length: bars }, () => [])
  for (const el of els) {
    let cursor = el.start
    const end = el.start + el.dur
    while (cursor < end) {
      const bar = Math.floor(cursor / EIGHTHS_PER_BAR)
      if (bar >= bars) break
      const barEnd = (bar + 1) * EIGHTHS_PER_BAR
      const pieceEnd = Math.min(end, barEnd)
      perBar[bar].push({
        el,
        start: cursor,
        dur: pieceEnd - cursor,
        first: cursor === el.start,
        last: pieceEnd === end,
      })
      cursor = pieceEnd
    }
  }

  const lines: string[] = []
  for (let lineStart = 0; lineStart < bars; lineStart += BARS_PER_LINE) {
    const lineEnd = Math.min(bars, lineStart + BARS_PER_LINE)
    const music: string[] = []
    const lyrics: string[] = []

    for (let bar = lineStart; bar < lineEnd; bar++) {
      const acc = new Map<string, number>() // accidentals live until the bar line
      const barTokens: string[] = []
      let prevLen = 0
      let prevKind: ElKind | null = null
      for (const piece of perBar[bar]) {
        const chunks = splitDuration(piece.dur)
        let offset = 0
        for (let i = 0; i < chunks.length; i++) {
          const len = chunks[i]
          const slotInBar = (piece.start + offset) % EIGHTHS_PER_BAR
          offset += len
          const isFirstGlyph = piece.first && i === 0
          const isLastGlyph = piece.last && i === chunks.length - 1
          let token = ''
          if (isFirstGlyph && piece.el.chord) token += `"${piece.el.chord}"`
          if (piece.el.kind === 'note') {
            const pitch =
              piece.el.literal ??
              (piece.el.midi !== undefined ? pitchToAbc(piece.el.midi, key, spelling, acc) : 'B')
            token += pitch + lengthSuffix(len)
            if (!isLastGlyph) token += '-' // tie the split pieces back together
          } else {
            token += 'z' + lengthSuffix(len)
          }
          // Beam runs of eighth notes within a half bar; separate everything else.
          const spaced =
            barTokens.length > 0 &&
            (slotInBar % 4 === 0 ||
              len > 1 ||
              prevLen > 1 ||
              !!piece.el.chord ||
              piece.el.kind === 'rest' ||
              prevKind === 'rest')
          barTokens.push((spaced ? ' ' : '') + token)
          prevLen = len
          prevKind = piece.el.kind

          // The w: line consumes exactly one token per note *and* per rest.
          if (hasWords) {
            lyrics.push(isFirstGlyph && piece.el.word ? piece.el.word : '*')
          }
        }
      }
      music.push(barTokens.join(''))
      if (hasWords) lyrics.push('|')
    }

    const isLast = lineEnd >= bars
    lines.push(music.join(' | ') + (isLast ? ' |]' : ' |'))
    if (hasWords) {
      // Drop the trailing bar marker; it has nothing left to align to.
      const tokens = lyrics[lyrics.length - 1] === '|' ? lyrics.slice(0, -1) : lyrics
      if (tokens.some((t) => t !== '*' && t !== '|')) lines.push('w: ' + tokens.join(' '))
    }
  }
  return lines
}

/** Break an arbitrary slot count into note values that can actually be drawn. */
function splitDuration(slots: number): number[] {
  let left = Math.max(1, Math.round(slots))
  const out: number[] = []
  while (left > 0) {
    const next = WRITABLE_DURATIONS.find((d) => d <= left)
    if (next === undefined) break
    out.push(next)
    left -= next
  }
  return out.length > 0 ? out : [1]
}

function lengthSuffix(slots: number): string {
  return slots === 1 ? '' : String(slots)
}

// ---------------------------------------------------------------------------
// Pitch spelling
// ---------------------------------------------------------------------------

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']
const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

const MAJOR_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
}
const MINOR_FIFTHS: Record<string, number> = {
  A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7,
  D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7,
}
/** Enharmonic rescues for tonics that have no standard key signature. */
const TONIC_ALIASES: Record<string, string> = {
  'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb', 'E#': 'F', 'B#': 'C', Fb: 'E',
  Db: 'C#', Gb: 'F#', Cb: 'B',
}

function resolveKey(guess: KeyGuess | undefined): KeyInfo {
  const minor = guess?.mode === 'minor'
  const table = minor ? MINOR_FIFTHS : MAJOR_FIFTHS
  let tonic = normalizeTonic(guess?.tonic)
  if (tonic !== undefined && table[tonic] === undefined) {
    const alias = TONIC_ALIASES[tonic]
    tonic = alias !== undefined && table[alias] !== undefined ? alias : undefined
  }
  const resolved = tonic ?? (minor ? 'A' : 'C')
  const fifths = table[resolved] ?? 0

  const alter: Record<string, number> = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 }
  if (fifths > 0) for (let i = 0; i < fifths; i++) alter[SHARP_ORDER[i]] = 1
  if (fifths < 0) for (let i = 0; i < -fifths; i++) alter[FLAT_ORDER[i]] = -1

  return { name: resolved + (minor ? 'm' : ''), alter, fifths }
}

function normalizeTonic(tonic: string | undefined): string | undefined {
  if (typeof tonic !== 'string') return undefined
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*$/.exec(tonic)
  if (!m) return undefined
  const accidental = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]
  return m[1].toUpperCase() + accidental
}

/** pitch class -> preferred spelling in this key. */
function buildSpelling(key: KeyInfo): Map<number, Spelling> {
  const map = new Map<number, Spelling>()
  for (const letter of Object.keys(NATURAL_PC)) {
    const alter = key.alter[letter] ?? 0
    const pc = (((NATURAL_PC[letter] + alter) % 12) + 12) % 12
    if (!map.has(pc)) map.set(pc, { letter, alter })
  }
  const preferFlats = key.fifths < 0
  for (let pc = 0; pc < 12; pc++) {
    if (map.has(pc)) continue
    const neighbour = preferFlats ? map.get((pc + 1) % 12) : map.get((pc + 11) % 12)
    if (neighbour) {
      map.set(pc, {
        letter: neighbour.letter,
        alter: neighbour.alter + (preferFlats ? -1 : 1),
      })
    } else {
      // Should be unreachable; keep a sane default rather than crashing.
      map.set(pc, { letter: 'C', alter: pc })
    }
  }
  return map
}

function pitchToAbc(
  midi: number,
  key: KeyInfo,
  spelling: Map<number, Spelling>,
  acc: Map<string, number>,
): string {
  const clamped = Math.min(108, Math.max(21, Math.round(midi)))
  const pc = ((clamped % 12) + 12) % 12
  const sp = spelling.get(pc) ?? { letter: 'C', alter: 0 }
  // The natural pitch of the chosen letter fixes the printed octave.
  const naturalMidi = clamped - sp.alter
  const octave = Math.floor(naturalMidi / 12) - 1

  const stateKey = `${sp.letter}${octave}`
  const inForce = acc.has(stateKey) ? (acc.get(stateKey) as number) : (key.alter[sp.letter] ?? 0)
  let prefix = ''
  if (sp.alter !== inForce) {
    prefix = accidentalSymbol(sp.alter)
    acc.set(stateKey, sp.alter)
  }

  let body: string
  if (octave >= 5) {
    body = sp.letter.toLowerCase() + "'".repeat(Math.max(0, octave - 5))
  } else {
    body = sp.letter + ','.repeat(Math.max(0, 4 - octave))
  }
  return prefix + body
}

function accidentalSymbol(alter: number): string {
  if (alter >= 2) return '^^'
  if (alter === 1) return '^'
  if (alter === -1) return '_'
  if (alter <= -2) return '__'
  return '='
}

// ---------------------------------------------------------------------------
// Headers + escaping
// ---------------------------------------------------------------------------

function buildHeaders(segment: JamSegment, key: KeyInfo, rhythmStyle: boolean): string[] {
  const headers = ['X:1', `T:${safeTitle(segment)}`, 'M:4/4', 'L:1/8']
  const bpm = segment.tempoBpm
  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) {
    headers.push(`Q:1/4=${Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)))}`)
  }
  // `style=rhythm` draws slash note heads — the right look for a chart with no
  // real melody. Anything pitched keeps the normal head.
  headers.push(`K:${key.name}${rhythmStyle ? ' style=rhythm' : ''}`)
  return headers
}

function safeTitle(segment: JamSegment): string {
  const index = Number.isFinite(segment?.index) ? segment.index : 0
  const fallback = `Idea ${index + 1}`
  const raw = typeof segment?.label === 'string' ? segment.label : ''
  const cleaned = raw.replace(/[%\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback
}

/** Make a chord symbol safe to place inside an ABC "..." annotation. */
function sanitizeChord(symbol: string | undefined): string {
  if (typeof symbol !== 'string') return ''
  const cleaned = symbol
    .replace(/[\\"%\r\n]/g, '')
    // A leading ^ _ < > @ turns the string into a placement annotation.
    .replace(/^[\^_<>@]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 24)
}

/** Make a lyric syllable safe for a `w:` line. */
function sanitizeLyric(text: string | undefined): string {
  if (typeof text !== 'string') return ''
  const cleaned = text.replace(/[\\%\r\n]/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned
    .replace(/~/g, '\\~')
    .replace(/([-_*|])/g, '\\$1')
    // Whitespace separates syllables in a w: line; ~ prints as a space.
    .replace(/\s+/g, '~')
    .slice(0, 40)
}

function emptyAbc(title: string): string {
  return ['X:1', `T:${title}`, 'M:4/4', 'L:1/8', 'K:C', 'z8 |]'].join('\n') + '\n'
}
