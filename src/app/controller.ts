/**
 * App controller — the orchestration layer between the UI and the
 * audio/analysis/lyrics/export/storage modules. The UI only ever calls
 * these functions; it never touches the engines directly.
 *
 * NOTE: the engine wiring here is completed during integration once the
 * feature modules land. The public API below is stable — UI code should
 * call these exactly as typed.
 */
import { useAppStore } from '../state/store'

/** Request mic access and start a new recording session. */
export async function startRecording(): Promise<void> {
  // Wired during integration: audio engine + live analyzer + timers.
  throw new Error('not wired yet')
}

/** Stop recording, run the refinement pass (analysis + lyrics), save, and open review. */
export async function stopRecording(): Promise<void> {
  throw new Error('not wired yet')
}

/** Open a saved session in the review view. */
export async function openSession(id: string): Promise<void> {
  throw new Error('not wired yet')
}

/** Delete a saved session and refresh the library list. */
export async function deleteSession(id: string): Promise<void> {
  throw new Error('not wired yet')
}

/** Rename the currently open session (persists). */
export async function renameSession(title: string): Promise<void> {
  throw new Error('not wired yet')
}

/** Rename a segment label within the open session (persists). */
export async function renameSegment(segmentId: string, label: string): Promise<void> {
  throw new Error('not wired yet')
}

/** Refresh the library list from storage. */
export async function refreshLibrary(): Promise<void> {
  throw new Error('not wired yet')
}

/** Download the lead sheet PDF for the open session. */
export async function exportPdf(): Promise<void> {
  throw new Error('not wired yet')
}

/** Download the session audio (original compressed recording). */
export async function exportAudio(): Promise<void> {
  throw new Error('not wired yet')
}

/** Download a ZIP: PDF + audio + session JSON. */
export async function exportZip(): Promise<void> {
  throw new Error('not wired yet')
}

/** Navigation helpers. */
export function goToRecord(): void {
  useAppStore.getState().update({ view: 'record', error: null })
}

export function goToLibrary(): void {
  useAppStore.getState().update({ view: 'library', error: null })
  void refreshLibrary().catch(() => {})
}
