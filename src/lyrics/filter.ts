/**
 * Whisper hallucinates confidently on instrumental audio: "Thanks for
 * watching", "you", "[Music]", or the same word looped fifty times. A guitar
 * jam is mostly instrumental, so this post-filter is aggressive on purpose —
 * for this app, fewer words beats plausible-looking garbage.
 */
import type { LyricWord } from '../types'

/** Words further apart than this are treated as separate utterances. */
const ISLAND_GAP_SEC = 2

/** Word timings longer than this are bogus; clamp rather than trust them. */
const MAX_WORD_DURATION_SEC = 10

/** Same word this many times in a row => the whole run is a loop artefact. */
const REPEAT_RUN_LIMIT = 4

/** Same 2..5-word phrase this many times in a row => loop artefact. */
const NGRAM_LOOP_LIMIT = 3
const MAX_NGRAM = 5

/** A short island repeated at least this often across the take is boilerplate. */
const REPEATED_ISLAND_LIMIT = 3

/** Non-speech markers and musical glyphs Whisper emits for instrumental audio. */
const NON_SPEECH_CHARS = /[[\](){}<>♪♫🎵🎶]/u

/** Tokens made entirely of punctuation/symbols ("...", "-", "♪"). */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u

/**
 * Single-word utterances that are almost always hallucinated filler when they
 * stand alone over instrumental audio.
 */
const FILLER_WORDS = new Set([
  'a', 'ah', 'aha', 'and', 'applause', 'bye', 'em', 'er', 'foreign', 'ha',
  'haha', 'hello', 'hey', 'hi', 'hm', 'hmm', 'huh', 'i', 'inaudible', 'is',
  'it', 'laughter', 'mhm', 'mm', 'mmm', 'music', 'no', 'noise', 'o', 'oh',
  'ok', 'okay', 'ooh', 'right', 'silence', 'so', 'thank', 'thanks', 'the',
  'to', 'uh', 'um', 'well', 'yeah', 'yep', 'yes', 'you',
])

/** Exact phrases (normalised) that are pure Whisper boilerplate. */
const HALLUCINATION_PHRASES = new Set([
  'all rights reserved',
  'bye bye',
  'copyright',
  'dont forget to subscribe',
  'for more information visit',
  'good bye',
  'i love you all',
  'like and subscribe',
  'mm hmm',
  'oh my god',
  'okay bye',
  'please subscribe',
  'see you next time',
  'see you next video',
  'see you in the next video',
  'stay tuned',
  'thank you',
  'thank you all',
  'thank you bye',
  'thank you everyone',
  'thank you so much',
  'thank you very much',
  'thanks a lot',
  'thanks everyone',
  'the end',
  'to be continued',
  'welcome back',
  'you know',
])

/** Boilerplate families that come with variable tails. */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^(thanks|thank you)( so much| very much| all| again)?( for)? (watching|listening|joining)\b.*$/,
  /^(please )?(dont forget to )?(like( and| comment and)? )?subscribe\b.*$/,
  /^(subtitles?|captions?|transcript(ion)?|translation)( by| provided by| and translation by)\b.*$/,
  /^(www|http|https)[a-z0-9]*$/,
  /^[a-z0-9]+(com|org|net|info)$/,
  /^see you (in|on|at|next)\b.*$/,
  /^(this is|thats) (all|it) for (today|now)\b.*$/,
]

/** Lowercase, letters/digits/apostrophes only — for phrase matching. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function isBoilerplate(phrase: string): boolean {
  if (HALLUCINATION_PHRASES.has(phrase)) return true
  return HALLUCINATION_PATTERNS.some((re) => re.test(phrase))
}

function sanitize(word: LyricWord, durationSec?: number): LyricWord | null {
  const text = (word.text ?? '').trim()
  if (!text) return null

  // Bracketed / parenthesised non-speech markers and bare punctuation.
  if (NON_SPEECH_CHARS.test(text)) return null
  if (PUNCTUATION_ONLY.test(text)) return null

  const start = word.startSec
  let end = word.endSec
  // null / undefined / NaN timestamps: unusable, drop the word.
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  if (start < -0.05) return null

  const clampedStart = Math.max(0, start)
  if (end < clampedStart) end = clampedStart
  if (end - clampedStart > MAX_WORD_DURATION_SEC) {
    end = clampedStart + MAX_WORD_DURATION_SEC
  }

  if (durationSec !== undefined && Number.isFinite(durationSec)) {
    // Whisper likes to invent words past the end of the audio.
    if (clampedStart > durationSec + 0.5) return null
    if (end > durationSec) end = durationSec
  }

  const cleaned: LyricWord = { startSec: clampedStart, endSec: end, text }
  if (typeof word.confidence === 'number' && Number.isFinite(word.confidence)) {
    cleaned.confidence = word.confidence
  }
  return cleaned
}

/** Drop maximal runs of one repeated word (4+) — a classic decoder loop. */
function dropRepeatedWords(words: LyricWord[], keys: string[]): boolean[] {
  const keep = words.map(() => true)
  let i = 0
  while (i < words.length) {
    let j = i + 1
    while (j < words.length && keys[j] === keys[i]) j++
    if (j - i >= REPEAT_RUN_LIMIT) {
      for (let k = i; k < j; k++) keep[k] = false
    }
    i = j
  }
  return keep
}

/** Drop consecutive repeats of the same short phrase ("na na / na na / na na"). */
function dropRepeatedPhrases(keys: string[], keep: boolean[]): void {
  for (let n = MAX_NGRAM; n >= 2; n--) {
    let i = 0
    while (i + n <= keys.length) {
      if (!keep[i]) {
        i++
        continue
      }
      let reps = 1
      while (i + (reps + 1) * n <= keys.length) {
        let same = true
        for (let k = 0; k < n; k++) {
          if (keys[i + k] !== keys[i + reps * n + k]) {
            same = false
            break
          }
        }
        if (!same) break
        reps++
      }
      if (reps >= NGRAM_LOOP_LIMIT) {
        for (let k = i; k < i + reps * n; k++) keep[k] = false
        i += reps * n
      } else {
        i++
      }
    }
  }
}

interface Island {
  words: LyricWord[]
  phrase: string
}

function toIslands(words: LyricWord[], keys: string[]): Island[] {
  const islands: Island[] = []
  let current: LyricWord[] = []
  let currentKeys: string[] = []

  const flush = () => {
    if (current.length > 0) {
      islands.push({ words: current, phrase: currentKeys.join(' ') })
      current = []
      currentKeys = []
    }
  }

  for (let i = 0; i < words.length; i++) {
    const prev = current[current.length - 1]
    if (prev && words[i].startSec - prev.endSec > ISLAND_GAP_SEC) flush()
    current.push(words[i])
    currentKeys.push(keys[i])
  }
  flush()
  return islands
}

/**
 * Remove Whisper's instrumental-audio hallucinations from word-level output.
 * An entirely instrumental take should come back empty.
 *
 * @param words  Raw words with ABSOLUTE times, in order.
 * @param durationSec  Length of the audio, used to reject invented tails.
 */
export function filterHallucinations(
  words: LyricWord[],
  durationSec?: number,
): LyricWord[] {
  const cleaned: LyricWord[] = []
  for (const word of words) {
    const ok = sanitize(word, durationSec)
    if (ok) cleaned.push(ok)
  }
  cleaned.sort((a, b) => a.startSec - b.startSec)
  if (cleaned.length === 0) return []

  const keys = cleaned.map((w) => normalize(w.text))
  const keep = dropRepeatedWords(cleaned, keys)
  dropRepeatedPhrases(keys, keep)

  const survivors: LyricWord[] = []
  const survivorKeys: string[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (!keep[i] || keys[i] === '') continue
    survivors.push(cleaned[i])
    survivorKeys.push(keys[i])
  }
  if (survivors.length === 0) return []

  const islands = toIslands(survivors, survivorKeys)

  // Short islands that recur across the take are boilerplate, not lyrics.
  const islandCounts = new Map<string, number>()
  for (const island of islands) {
    islandCounts.set(island.phrase, (islandCounts.get(island.phrase) ?? 0) + 1)
  }

  const out: LyricWord[] = []
  for (const island of islands) {
    if (island.words.length === 1 && FILLER_WORDS.has(island.phrase)) continue
    if (isBoilerplate(island.phrase)) continue
    if (
      island.words.length <= 4 &&
      (islandCounts.get(island.phrase) ?? 0) >= REPEATED_ISLAND_LIMIT
    ) {
      continue
    }
    out.push(...island.words)
  }

  // Whatever's left is too thin to be real singing.
  if (out.length <= 2 && out.every((w) => FILLER_WORDS.has(normalize(w.text)))) {
    return []
  }

  return out
}
