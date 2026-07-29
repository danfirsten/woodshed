/**
 * Every tuning knob in the analysis module lives here so the behaviour of the
 * DSP can be adjusted from one place. Values are chosen for 16 kHz mono guitar
 * audio recorded in a room (see README.md for the reasoning behind each group).
 */

/** Lowest fundamental we care about — a whole step below standard low E (82.4 Hz). */
export const MIN_PITCH_HZ = 70
/**
 * Highest fundamental we care about — a little above the 24th fret high E.
 * Chord/key work uses a lower ceiling (`CHROMA.maxFundamentalHz`) because chord
 * voicings live much further down; this bound is for melody.
 */
export const MAX_PITCH_HZ = 2000

/* ---------------------------------------------------------------- segmentation */

export const SEGMENT = {
  /** RMS envelope hop/window, seconds. */
  hopSec: 0.05,
  windowSec: 0.05,
  /** Percentile of the RMS envelope treated as the room's noise floor. */
  noiseFloorPercentile: 0.15,
  /** Playing must be this many dB above the noise floor to count as active. */
  activeAboveFloorDb: 8,
  /** Absolute lower bound on the active threshold (guards against a silent room). */
  minActiveDb: -58,
  /** A pause must last at least this long to split two musical ideas. */
  minGapSec: 1.5,
  /** Ideas with less actual playing than this are discarded. */
  minActiveSec: 3,
  /** Breathing room added to each side of a segment. */
  padSec: 0.25,
  /** Fallback single-segment mode needs at least this much playing in the session. */
  fallbackMinActiveSec: 1,
} as const

/* ------------------------------------------------------------------ chromagram */

export const CHROMA = {
  /** Offline analysis frame: 4096 @ 16 kHz = 256 ms, hop 2048 = 128 ms. */
  frameSize: 4096,
  hopSize: 2048,
  /** Harmonics summed into each pitch's salience (weights below). */
  harmonics: 4,
  /** Weight of harmonic h is harmonicRolloff^(h-1). */
  harmonicRolloff: 0.6,
  /** Half-width of the bin window collected around each harmonic, in semitones. */
  binWindowSemitones: 0.5,
  /** Chord/key work only considers fundamentals up to here: above ~F5 a peak is
   *  almost certainly somebody's overtone, not a note being fretted. */
  maxFundamentalHz: 700,
  /** Harmonics above this frequency are hiss, not guitar. */
  maxHarmonicHz: 5000,
  /** Magnitudes are log-compressed as log(1 + gamma·m) before pitch mapping. */
  logCompressionGamma: 0.05,
} as const

/* -------------------------------------------------------------------- chords */

export const CHORD = {
  /** Frames quieter than this (relative to the segment's peak RMS) are "no chord". */
  silenceRatio: 0.06,
  /** Minimum cosine similarity for a frame to be labelled with a chord. */
  minScore: 0.62,
  /** Odd window (in frames) of the mode filter applied to the frame-wise labels. */
  smoothingFrames: 5,
  /** Chord events shorter than this are dropped as detection blips. */
  minDurationSec: 0.3,
  /** Small preference for triads over 7th chords (they have fewer notes to match). */
  qualityPrior: {
    maj: 1,
    min: 1,
    '7': 0.96,
    maj7: 0.94,
    m7: 0.96,
  },
} as const

/* ------------------------------------------------------------------------ key */

export const KEY = {
  /** Below this correlation the key guess is dropped entirely. */
  minCorrelation: 0.35,
} as const

/* ---------------------------------------------------------------------- tempo */

export const TEMPO = {
  /** Onset envelope STFT: 512 @ 16 kHz = 32 ms, hop 256 = 16 ms (62.5 Hz rate). */
  frameSize: 512,
  hopSize: 256,
  /** Search range for the autocorrelation peak. */
  minBpm: 60,
  maxBpm: 180,
  /** Log-normal prior centred here keeps the peak from landing on a half/double. */
  priorCenterBpm: 120,
  /** Width of that prior, in octaves. */
  priorWidthOctaves: 0.9,
  /** Peak must be this many times the mean autocorrelation in the search range. */
  minPeakSalience: 1.35,
  /** ...and this fraction of the zero-lag energy. */
  minPeakRatio: 0.18,
  /** Below this confidence we report no tempo at all (rubato jams). */
  minConfidence: 0.45,
  /** Segments shorter than this can't support a tempo estimate. */
  minSegmentSec: 4,
} as const

/* --------------------------------------------------------------------- melody */

export const MELODY = {
  /** pitchy window: 2048 @ 16 kHz = 128 ms, hop 512 = 32 ms. */
  frameSize: 2048,
  hopSize: 512,
  /** MPM clarity floor — this is what rejects polyphonic (strummed) frames. */
  minClarity: 0.9,
  /** Ignore frames below this RMS outright (cheap gate before the pitch detector). */
  minRms: 0.005,
  /** Detected fundamentals outside this range are guitar-implausible
   *  (a 24-fret high E is 1319 Hz). */
  minHz: MIN_PITCH_HZ,
  maxHz: MAX_PITCH_HZ * 0.7,
  /** Odd window of the median filter applied to the MIDI pitch track. */
  medianFrames: 5,
  /** A note must hold this long to be emitted. */
  minDurationSec: 0.08,
  /** Frames may deviate this far (semitones) from the run's pitch and still belong. */
  maxDeviationSemitones: 0.5,
  /** A run survives this many consecutive dropped frames without being cut. */
  maxGapFrames: 1,
} as const

/* ----------------------------------------------------------------------- live */

export const LIVE = {
  /** Length of audio each live detection looks at. */
  windowSec: 0.5,
  /** How much new audio triggers the next detection. */
  strideSec: 0.25,
  /** Live chroma frame/hop, seconds (frame is rounded to a power of two at
   *  runtime). 256 ms matches the offline frame: the extra frequency resolution
   *  at the bottom of the guitar's range is what keeps live chords honest. */
  frameSec: 0.256,
  frameHopSec: 0.128,
  /** A candidate must win this many consecutive detections before it is accepted. */
  stableDetections: 3,
  /** Absolute RMS below which the live window counts as silence. */
  silenceRms: 0.008,
  /** Minimum template score for a live detection to name a chord. Stricter than
   *  the offline pass: there is no smoothing downstream to clean up a bad call. */
  minScore: 0.68,
  /** Live chords shorter than this are not worth showing. */
  minDurationSec: 0.35,
} as const
