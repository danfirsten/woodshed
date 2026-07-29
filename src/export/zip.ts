/**
 * ZIP export — one archive with everything from a jam:
 *
 *   {title}.pdf     the lead-sheet booklet
 *   {title}.webm    the original recording (extension follows the MIME type)
 *   session.json    the full JamSession, pretty-printed
 *   README.txt      a short note explaining the above
 *
 * Uses fflate's async (worker-backed) `zip` so a long recording doesn't lock
 * up the UI thread while it compresses.
 */
import { zip, type AsyncZippable } from 'fflate'
import type { JamSession } from '../types'
import { audioFilename, safeFilename } from './download'
import { exportSessionPdf } from './pdf'

/** Deflate level for text-ish payloads. */
const TEXT_LEVEL = 6

export async function exportSessionZip(session: JamSession, audio: Blob): Promise<Blob> {
  const pdfBlob = await exportSessionPdf(session)

  const pdfName = safeFilename(session.title, 'pdf')
  const audioName = audioFilename(session)
  const mtime = Number.isFinite(session.startedAt) ? new Date(session.startedAt) : new Date()

  const files: AsyncZippable = {
    [pdfName]: [await blobBytes(pdfBlob), { level: TEXT_LEVEL, mtime }],
    // Opus/AAC audio is already compressed — deflating it just burns CPU.
    [audioName]: [await blobBytes(audio), { level: 0, mtime }],
    'session.json': [encodeText(JSON.stringify(session, null, 2)), { level: TEXT_LEVEL, mtime }],
    'README.txt': [encodeText(readmeText(session, pdfName, audioName)), { level: TEXT_LEVEL, mtime }],
  }

  const archive = await zipAsync(files)
  return new Blob([archive], { type: 'application/zip' })
}

/** Promise wrapper around fflate's callback-style async zip. */
function zipAsync(files: AsyncZippable): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    zip(files, { level: TEXT_LEVEL }, (err, data) => {
      if (err) {
        reject(new Error(`Could not build the ZIP archive: ${err.message}`))
        return
      }
      resolve(data)
    })
  })
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function readmeText(session: JamSession, pdfName: string, audioName: string): string {
  const when = Number.isFinite(session.startedAt)
    ? new Date(session.startedAt).toLocaleString()
    : 'an unknown date'
  return [
    `${session.title} — jammed on ${when}.`,
    `${pdfName} is the lead sheet booklet, ${audioName} is the original recording, and session.json has the raw chords, notes, and lyrics if you want to load them somewhere else.`,
    `Made with Woodshed, entirely in your browser. Exported ${new Date().toLocaleString()}.`,
    '',
  ].join('\n')
}
