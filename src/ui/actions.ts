/**
 * Small helpers for calling controller actions from the UI. Every controller
 * call can reject (mic denied, storage failure, export blew up), and the UI's
 * job is to surface that in the store's error slot rather than swallow it.
 */
import { useAppStore } from '../state/store'

export function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return `${fallback}: ${err.message}`
  if (typeof err === 'string' && err) return `${fallback}: ${err}`
  return fallback
}

/** Await a controller action; on failure write a friendly message to store.error. */
export async function runAction(
  fn: () => Promise<void> | void,
  fallback: string,
): Promise<boolean> {
  const { update } = useAppStore.getState()
  try {
    update({ error: null })
    await fn()
    return true
  } catch (err) {
    update({ error: describeError(err, fallback) })
    return false
  }
}
