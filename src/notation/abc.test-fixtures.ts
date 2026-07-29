/**
 * Hand-built JamSegments covering the data combinations `segmentToAbc` has to
 * survive. Not a test runner — these exist so the integrator (or a scratch
 * page) can eyeball every rendering path quickly:
 *
 *   import { NOTATION_FIXTURES } from './notation/abc.test-fixtures'
 *   NOTATION_FIXTURES.map(f => <LeadSheet key={f.id} segment={f} />)
 */

import type { ChordEvent, JamSegment, LyricWord, NoteEvent } from '../types'

function chord(startSec: number, endSec: number, symbol: string): ChordEvent {
  return { startSec, endSec, symbol, confidence: 0.8 }
}

function note(startSec: number, endSec: number, midi: number): NoteEvent {
  return { startSec, endSec, midi, confidence: 0.8 }
}

function word(startSec: number, endSec: number, text: string): LyricWord {
  return { startSec, endSec, text, confidence: 0.9 }
}

/** Everything present: tempo, key, melody, chords and lyrics. */
export const FIXTURE_FULL: JamSegment = {
  id: 'fx-full',
  index: 0,
  startSec: 10,
  endSec: 18,
  label: 'that dreamy riff',
  keyGuess: { tonic: 'G', mode: 'major', confidence: 0.72 },
  tempoBpm: 120, // eighth = 0.25 s
  chords: [chord(10, 12, 'G'), chord(12, 14, 'Em7'), chord(14, 16, 'Cmaj7'), chord(16, 18, 'D')],
  notes: [
    note(10, 10.5, 67),
    note(10.5, 11, 71),
    note(11, 12, 74),
    note(12, 12.5, 76),
    note(12.5, 13, 74),
    note(13, 14, 71),
    note(14, 15, 72),
    note(15, 16, 76),
    note(16, 17, 78), // F#5 — diatonic in G, no printed accidental
    note(17, 18, 74),
  ],
  lyrics: [
    word(10, 10.5, 'hold'),
    word(10.5, 11, 'the'),
    word(11, 12, 'line'),
    word(12, 13, 'tonight'),
    word(14, 15, "don't"),
    word(15, 16, 'let'),
    word(16, 17, 'go'),
  ],
}

/** Rubato: no tempo, melody only, no chords, no lyrics, minor key. */
export const FIXTURE_RUBATO_MELODY: JamSegment = {
  id: 'fx-rubato',
  index: 1,
  startSec: 30,
  endSec: 36,
  keyGuess: { tonic: 'A', mode: 'minor', confidence: 0.4 },
  tempoBpm: undefined, // falls back to the 0.25 s nominal eighth
  chords: [],
  notes: [
    note(30.0, 30.4, 69),
    note(30.4, 30.9, 72),
    note(30.9, 31.6, 76),
    note(31.6, 32.0, 75), // G#4 — raised 7th, needs an explicit accidental
    note(32.0, 33.1, 69),
    note(33.4, 34.0, 81),
    note(34.0, 35.2, 79),
  ],
  lyrics: [],
}

/** Strumming only: chords, no melody, no lyrics. Rendered as rhythm slashes. */
export const FIXTURE_CHORDS_ONLY: JamSegment = {
  id: 'fx-chords',
  index: 2,
  startSec: 0,
  endSec: 16,
  label: 'campfire loop',
  keyGuess: { tonic: 'D', mode: 'major', confidence: 0.9 },
  tempoBpm: 96,
  chords: [
    chord(0, 2.5, 'D'),
    chord(2.5, 5, 'A/C#'),
    chord(5, 7.5, 'Bm'),
    chord(7.5, 10, 'G'),
    chord(10, 12.5, 'D'),
    chord(12.5, 16, 'N.C.'),
  ],
  notes: [],
  lyrics: [],
}

/** Singing over strums: chords + lyrics, no pitch track. Words get anchors. */
export const FIXTURE_CHORDS_AND_LYRICS: JamSegment = {
  id: 'fx-words',
  index: 3,
  startSec: 5,
  endSec: 13,
  keyGuess: { tonic: 'Bb', mode: 'major', confidence: 0.55 },
  tempoBpm: undefined,
  chords: [chord(5, 8, 'Bb'), chord(8, 10.5, 'Gm7'), chord(10.5, 13, 'Eb "big"')],
  notes: [],
  lyrics: [
    word(5.0, 5.4, 'walking'),
    word(5.5, 5.9, 'down'),
    word(6.0, 6.4, 'the'),
    word(6.5, 7.4, 'road'),
    word(8.0, 8.6, 'again'),
    word(9.0, 9.4, 'well-worn'), // hyphen must be escaped in the w: line
    word(10.6, 11.4, 'shoes'),
    word(11.6, 12.6, 'oh my'), // internal space becomes a ~ inside one syllable
  ],
}

/** Degenerate: analysis found nothing. Must still produce a valid sheet. */
export const FIXTURE_EMPTY: JamSegment = {
  id: 'fx-empty',
  index: 4,
  startSec: 40,
  endSec: 42,
  chords: [],
  notes: [],
  lyrics: [],
}

/** Hostile input: overlapping notes, junk symbols, bad key, silly tempo. */
export const FIXTURE_MESSY: JamSegment = {
  id: 'fx-messy',
  index: 5,
  startSec: 0,
  endSec: 6,
  label: 'weird "one" 100% \\ raw',
  keyGuess: { tonic: 'D#', mode: 'major', confidence: 0.2 }, // no such key sig -> Eb
  tempoBpm: 4000, // clamped
  chords: [chord(0, 1, '"C"maj7'), chord(0.9, 2, 'N.C.'), chord(2, 3, ''), chord(3, 6, 'F#dim')],
  notes: [
    note(0, 1.2, 61),
    note(0.5, 1.0, 63), // overlaps the previous note
    note(1.2, 1.25, 66), // sub-grid duration
    note(2, 3, 200), // out of range, clamped
    note(3, 4.7, 58),
  ],
  lyrics: [word(0, 0.5, '*star*'), word(1, 1.5, 'a|b'), word(3, 4, '~tilde~')],
}

export const NOTATION_FIXTURES: JamSegment[] = [
  FIXTURE_FULL,
  FIXTURE_RUBATO_MELODY,
  FIXTURE_CHORDS_ONLY,
  FIXTURE_CHORDS_AND_LYRICS,
  FIXTURE_EMPTY,
  FIXTURE_MESSY,
]
