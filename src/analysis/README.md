# `src/analysis` — music analysis (DSP)

Turns raw guitar audio into chords, notes, segments, key and tempo. Everything
here is browser-only: no servers, no models, no dependencies beyond `pitchy`
(McLeod pitch detection). The FFT is hand-written in `fft.ts`.

## Public API

```ts
// live.ts — cheap incremental pass, fed while recording
new LiveAnalyzer(onChord: (chord: ChordEvent) => void)
  .pushFrame(frame: AudioFrame): void
  .reset(): void

// index.ts — full refinement pass after recording stops
analyzeSession(pcm16k: Float32Array, onProgress?): Promise<SessionAnalysis>
```

`analyzeSession` **copies** the PCM before transferring it to the worker, so the
caller's `Float32Array` is never detached — the lyrics engine can use the same
buffer afterwards. If the worker can't be constructed or fails to boot within
15 s, the same pipeline runs on the main thread instead (lazily imported, so it
isn't in the main bundle for the normal path).

## Files

| File | Role |
| --- | --- |
| `constants.ts` | **Every tuning knob**, grouped by stage. Start here. |
| `fft.ts` | Radix-2 Cooley–Tukey FFT with reusable buffers + Hann window. |
| `chroma.ts` | Chromagram: spectrum → pitch salience → 12 pitch classes. |
| `chords.ts` | Chord vocabulary, template matching, smoothing, `ChordEvent` merge. |
| `key.ts` | Krumhansl–Schmuckler key estimation. |
| `tempo.ts` | Spectral-flux onset envelope + autocorrelation. |
| `melody.ts` | pitchy (MPM) pitch track → `NoteEvent`s. |
| `segmentation.ts` | RMS envelope → musical "ideas". |
| `pipeline.ts` | Pure orchestration: PCM → `JamSegment[]`. Runs anywhere. |
| `worker.ts` | Worker entry; owns nothing but the message loop. |
| `protocol.ts` | Worker message types. |
| `index.ts` | Main-thread client for the worker. |

Nearly everything is a pure function of its input, which is what makes the
pipeline testable without a browser: `runAnalysis(pcm, sampleRate, report)` is
synchronous and DOM-free.

## Algorithm overview

### 1. Segmentation (`segmentation.ts`)

A jam has no song boundaries, so the only reliable structural cue is the player
stopping.

1. RMS envelope at 50 ms hops.
2. Noise floor = 15th percentile of that envelope (relative, so it works in both
   a quiet and a noisy room).
3. A frame is "playing" if it is ≥ 8 dB above the floor (never below −58 dBFS).
4. Gaps shorter than 1.5 s are bridged — a pause inside a phrase is not a split.
5. Groups with less than 3 s of actual playing are discarded.
6. Edges are padded by 250 ms, clamped so neighbours can't overlap.

One deliberate guard: if that leaves nothing but the session does contain ≥ 1 s
of playing, a single segment spanning everything audible is returned rather than
an empty analysis.

### 2. Chromagram (`chroma.ts`)

Frame 4096 @ 16 kHz (256 ms), Hann window, hop 2048 (128 ms).

Mapping FFT bins straight onto pitch classes smears badly on guitar: a plucked
string puts real energy into its 3rd harmonic (a fifth) and 5th harmonic (a
major third) — exactly the notes that decide a chord's quality. So the mapping
goes through a **pitch salience** step instead. For every MIDI pitch in the
guitar's chord range, take the peak magnitude in a ±0.5 semitone window around
its fundamental *and its first 4 harmonics*, weighted `0.6^(h-1)`, and sum. A
real fundamental is reinforced by its own overtones; an overtone with no
fundamental beneath it stays weak. Saliences are then folded into 12 bins and
L2-normalised.

Two details that mattered a lot in tuning:

- **Fundamentals are capped at 700 Hz** (`CHROMA.maxFundamentalHz`). Above ~F5 a
  spectral peak is almost certainly somebody's overtone, not a fretted note.
  Letting high partials act as fundamentals was the single biggest source of
  spurious major-7ths. Melody detection uses the full range; only harmony is
  capped.
- **Log compression is gentle** (`log(1 + 0.05·m)`). Aggressive compression
  (γ = 100) flattened the chroma until every chord matched everything.

The pitch→bin table is precomputed once as flat typed arrays, so per-frame cost
is one FFT plus a few hundred reads.

### 3. Chord recognition (`chords.ts`)

Vocabulary: `maj`, `min`, `7`, `maj7`, `m7` × 12 roots = 60 chords, plus "no
chord" (label `-1`, never emitted as a symbol).

Templates are weighted rather than binary — root and third 1.0, fifth 0.7–0.8
(guitar overtones put energy there anyway), seventh 0.9 — then L2-normalised, so
the match score is a cosine similarity in 0..1. Four-note templates can absorb
noise that three-note templates can't, so each quality carries a small prior
(`maj`/`min` 1.0, `7`/`m7` 0.96, `maj7` 0.94); these were fitted on a bank of
synthesised guitar voicings.

Per segment: frame-wise argmax → mode filter over 5 frames (≈ 0.64 s) → runs
shorter than 300 ms absorbed into their longer neighbour → merge into
`ChordEvent`s with absolute times. Confidence is the mean score of the frames
that actually voted for the winning chord.

### 4. Key (`key.ts`)

Krumhansl–Kessler probe-tone profiles, Pearson correlation against all 24
rotations of the segment's loudness-weighted summed chroma. Confidence blends
the winning correlation with its margin over the runner-up (usually the relative
major/minor). Below r = 0.35 no key is reported.

### 5. Tempo (`tempo.ts`)

Spectral flux over 512-sample frames / 256-sample hops (62.5 Hz onset rate),
log-compressed, minus a 0.5 s moving average, half-wave rectified. Then
autocorrelation over lags corresponding to 60–180 BPM, weighted by a log-normal
prior centred on 120 BPM so the peak doesn't settle on a half- or double-time
multiple, with parabolic interpolation for sub-frame resolution.

`tempoBpm` is only set when the peak clears three gates (peak/zero-lag ratio,
peak-vs-mean salience, and the blended confidence). Jams are often rubato, and a
confidently wrong tempo is worse than none.

### 6. Melody (`melody.ts`)

pitchy's `PitchDetector.forFloat32Array(2048)`, hop 512 (32 ms). An RMS gate
skips silent frames before the detector is called at all.

The load-bearing constant is **clarity ≥ 0.9**. Strummed chords have no single
pitch and MPM scores them poorly; single-note lines score near 1. That threshold
is what keeps riffs and rejects chords — a strummed passage correctly yields
zero notes. The MIDI track is median-filtered (5 frames), then stable runs
(same rounded MIDI, within 0.5 semitones, ≥ 80 ms, tolerating one dropped
frame) merge into `NoteEvent`s. Confidence is the mean clarity.

### 7. Live analyzer (`live.ts`)

Runs on the main thread during recording, so it must stay cheap: a 500 ms
rolling window, re-analysed every 250 ms, is two 4096-point FFTs plus 60 dot
products — microseconds.

Hysteresis: a candidate must win **3 consecutive detections** (~750 ms) before it
becomes the stable chord. When the stable chord changes — or silence begins — the
previous one is finalised as a `ChordEvent` (`confidence` = mean match score) and
the callback fires. Nothing is emitted during silence; `"N.C."` is never
produced. `reset()` flushes any chord still in progress so the last chord of a
take isn't lost.

The live pass is a "am I being heard correctly?" feedback loop, not the
transcript — `analyzeSession` supersedes all of it.

## Tuning constants

All of them live in [`constants.ts`](./constants.ts), grouped as `SEGMENT`,
`CHROMA`, `CHORD`, `KEY`, `TEMPO`, `MELODY`, `LIVE`. Highlights:

| Constant | Value | Why |
| --- | --- | --- |
| `SEGMENT.minGapSec` | 1.5 s | Silence needed to split two ideas. |
| `SEGMENT.minActiveSec` | 3 s | Shorter ideas are dropped. |
| `SEGMENT.activeAboveFloorDb` | 8 dB | Above the 15th-percentile noise floor. |
| `CHROMA.frameSize` / `hopSize` | 4096 / 2048 | 256 ms / 128 ms at 16 kHz. |
| `CHROMA.maxFundamentalHz` | 700 | Harmony ceiling; stops overtone chords. |
| `CHROMA.logCompressionGamma` | 0.05 | Gentle; higher flattens the chroma. |
| `CHORD.minScore` | 0.62 | Frame-level; smoothing cleans up the rest. |
| `CHORD.minDurationSec` | 0.3 s | Blip suppression. |
| `TEMPO.minBpm` / `maxBpm` | 60 / 180 | Autocorrelation search range. |
| `MELODY.minClarity` | 0.9 | The polyphony rejector. Raise for fewer/safer notes. |
| `LIVE.stableDetections` | 3 | Anti-flicker hysteresis (~750 ms latency). |

## Performance

Measured on synthesised guitar audio, single-threaded Node:

| Input | Time |
| --- | --- |
| 46 s | ~0.23 s |
| 5 min | ~1.2 s |
| 30 min (~20 min of playing) | ~11 s |

Everything is O(n): FFT plans, windows, twiddle tables and the pitch→bin map are
built once and reused across every frame and every segment; nothing allocates
inside a frame loop. The FFT matches a naive DFT to 6.4e-7 (float32 precision).
