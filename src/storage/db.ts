/**
 * IndexedDB persistence for Woodshed sessions — no wrapper library.
 *
 * Database `woodshed` v1, two stores:
 *   sessions  keyPath 'id'          the JamSession as plain JSON
 *   audio     out-of-line keys      the recording Blob, keyed by session id
 *
 * Audio blobs live in their own store so the library listing can read every
 * session's metadata without ever pulling megabytes of audio into memory.
 */
import type { JamSession, SessionSummary } from '../types'

const DB_NAME = 'woodshed'
const DB_VERSION = 1
const SESSION_STORE = 'sessions'
const AUDIO_STORE = 'audio'

/** Cached connection promise — the DB is opened at most once per page. */
let dbPromise: Promise<IDBDatabase> | null = null

/** Save (or overwrite) a session and its audio together. */
export async function saveSession(session: JamSession, audio: Blob): Promise<void> {
  if (!session || typeof session.id !== 'string' || session.id.length === 0) {
    throw new Error('Cannot save a session without an id.')
  }

  const json = toPlainJson(session)
  const db = await openDb()
  const tx = beginTx(db, [SESSION_STORE, AUDIO_STORE], 'readwrite', 'save this session')
  const done = transactionDone(tx, 'save this session')

  try {
    tx.objectStore(SESSION_STORE).put(json)
    tx.objectStore(AUDIO_STORE).put(audio, session.id)
  } catch (err) {
    throw new Error(`Could not save this session: ${describe(err)}`)
  }

  await done
}

/** Load a session plus its audio. Returns null unless both are present. */
export async function loadSession(
  id: string,
): Promise<{ session: JamSession; audio: Blob } | null> {
  if (!id) return null

  const db = await openDb()
  const tx = beginTx(db, [SESSION_STORE, AUDIO_STORE], 'readonly', 'open this session')
  const done = transactionDone(tx, 'open this session')

  const sessionReq = request<JamSession | undefined>(
    tx.objectStore(SESSION_STORE).get(id),
    'open this session',
  )
  const audioReq = request<Blob | undefined>(
    tx.objectStore(AUDIO_STORE).get(id),
    'open this session',
  )

  // Awaiting everything together means no promise is left unhandled when one
  // of them fails.
  const [session, audio] = await Promise.all([sessionReq, audioReq, done])

  if (!session || !audio) return null
  return { session, audio }
}

/**
 * Every saved session as a lightweight summary, newest first.
 * Deliberately never touches the audio store.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const db = await openDb()
  const tx = beginTx(db, [SESSION_STORE], 'readonly', 'read your saved sessions')
  const done = transactionDone(tx, 'read your saved sessions')

  const [sessions] = await Promise.all([
    request<JamSession[]>(tx.objectStore(SESSION_STORE).getAll(), 'read your saved sessions'),
    done,
  ])

  return (sessions ?? [])
    .filter((s): s is JamSession => Boolean(s) && typeof s.id === 'string')
    .map(toSummary)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Remove a session and its audio. Deleting a missing id is a no-op. */
export async function deleteSessionById(id: string): Promise<void> {
  if (!id) return

  const db = await openDb()
  const tx = beginTx(db, [SESSION_STORE, AUDIO_STORE], 'readwrite', 'delete this session')
  const done = transactionDone(tx, 'delete this session')

  try {
    tx.objectStore(SESSION_STORE).delete(id)
    tx.objectStore(AUDIO_STORE).delete(id)
  } catch (err) {
    throw new Error(`Could not delete this session: ${describe(err)}`)
  }

  await done
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toSummary(session: JamSession): SessionSummary {
  return {
    id: session.id,
    title: session.title ?? 'Untitled jam',
    startedAt: Number.isFinite(session.startedAt) ? session.startedAt : 0,
    durationSec: Number.isFinite(session.durationSec) ? session.durationSec : 0,
    segmentCount: Array.isArray(session.segments) ? session.segments.length : 0,
  }
}

/**
 * Structured clone chokes on anything exotic that may have been attached to a
 * session upstream (proxies, class instances). The session is pure data by
 * contract, so round-tripping through JSON guarantees a storable object.
 */
function toPlainJson(session: JamSession): JamSession {
  try {
    return JSON.parse(JSON.stringify(session)) as JamSession
  } catch {
    throw new Error('This session contains data that cannot be saved.')
  }
}

/** Open (and cache) the database connection. */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(
        new Error(
          'This browser has no IndexedDB, so Woodshed cannot save your jams. Private browsing mode is the usual cause.',
        ),
      )
      return
    }

    let open: IDBOpenDBRequest
    try {
      open = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(new Error(`Could not open Woodshed's storage: ${describe(err)}`))
      return
    }

    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        // Out-of-line keys: the value is a raw Blob, keyed by session id.
        db.createObjectStore(AUDIO_STORE)
      }
    }

    open.onblocked = () => {
      reject(
        new Error(
          'Woodshed storage is blocked by another open tab. Close the other Woodshed tabs and try again.',
        ),
      )
    }

    open.onerror = () => {
      reject(new Error(`Could not open Woodshed's storage: ${describe(open.error)}`))
    }

    open.onsuccess = () => {
      const db = open.result
      // A newer tab wanting to upgrade must not be blocked by this connection.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
  }).catch((err: unknown) => {
    // Let the next call retry a failed open instead of caching the failure.
    dbPromise = null
    throw err instanceof Error ? err : new Error(describe(err))
  })

  return dbPromise
}

/**
 * Start a transaction, turning the browser's opaque failures (closed
 * connection, missing store) into something a user could act on.
 */
function beginTx(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  what: string,
): IDBTransaction {
  try {
    return db.transaction(stores, mode)
  } catch (err) {
    // A connection closed by a version change in another tab lands here.
    dbPromise = null
    throw new Error(`Could not ${what}: ${describe(err)}`)
  }
}

/** Promisify a single IDBRequest. */
function request<T>(req: IDBRequest<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error(`Could not ${what}: ${describe(req.error)}`))
  })
}

/** Resolves when the transaction commits, rejects if it aborts or errors. */
function transactionDone(tx: IDBTransaction, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error(`Could not ${what}: ${describe(tx.error)}`))
    tx.onabort = () =>
      reject(
        new Error(
          `Could not ${what}: ${describe(tx.error) || 'the browser cancelled the storage operation, which usually means it is out of space.'}`,
        ),
      )
  })
}

function describe(err: unknown): string {
  if (!err) return 'unknown storage error'
  if (err instanceof DOMException || err instanceof Error) {
    if (err.name === 'QuotaExceededError') {
      return 'the browser is out of storage space. Delete an older jam and try again.'
    }
    return err.message || err.name || 'unknown storage error'
  }
  return String(err)
}
