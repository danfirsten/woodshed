# 🎸 Woodshed

**Just play. Woodshed writes it down.**

Woodshed is a browser-only companion for guitar jam sessions. Hit record, play and
sing whatever comes to you, and when you stop, Woodshed hands back:

- **A timestamped lead sheet** — your jam is split into musical "ideas" by natural
  pauses, and each idea gets its chords, key, tempo, melody (when you play single-note
  lines), and lyrics, rendered as sheet music.
- **Live chord detection while you play** — see the chords appear as you jam.
- **The full audio recording** — so you can always check what you actually played.
- **Downloads** — the lead sheet as a PDF, the audio file, or one ZIP with everything
  (PDF + audio + raw session data).
- **A session library** — every jam is saved locally in your browser (IndexedDB),
  titled by date and time until you rename it.

Everything runs in your browser. No accounts, no API keys, no servers — audio never
leaves your machine. Lyrics are transcribed locally by a small Whisper speech model
(~40 MB, downloaded once and cached).

## Running locally

```bash
npm install
npm run dev
```

## Deploying

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`.
One-time setup: in the repo's **Settings → Pages**, set the source to **GitHub Actions**.

## How it works

| Piece | Approach |
| --- | --- |
| Recording | `MediaRecorder` (full-quality opus) + `AudioWorklet` PCM tap, resampled to 16 kHz mono for analysis |
| Segmentation | RMS envelope + adaptive silence threshold splits the jam into ideas |
| Chords | FFT chromagram → chord-template matching with temporal smoothing (live + refined passes) |
| Key / tempo | Krumhansl-Schmuckler profiles / onset-flux autocorrelation |
| Melody | McLeod pitch method ([pitchy](https://github.com/ianprime0509/pitchy)), high-clarity frames only |
| Lyrics | [transformers.js](https://github.com/huggingface/transformers.js) Whisper (tiny.en) in a Web Worker, word-level timestamps |
| Notation | Lead sheets generated as ABC and rendered with [abcjs](https://github.com/paulrosen/abcjs) |
| Export | jsPDF + fflate, assembled entirely client-side |

## Tips for good transcriptions

- Use it somewhere reasonably quiet; the mic hears everything.
- Chord detection loves clean, ringing chords; melody detection kicks in when you
  play single-note lines.
- Leave a beat of silence between ideas — that's how Woodshed knows where one idea
  ends and the next begins.
