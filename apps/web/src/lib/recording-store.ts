// Browser recordings waiting to be uploaded, kept in IndexedDB so a crashed
// tab, a reload, or a phone that kills Chrome mid-call loses at most the last
// few seconds. Audio arrives in chunks every few seconds while the call is up.

export interface StoredBrowserRecording {
  id: string;
  direction: 'inbound' | 'outbound';
  /** The other party's number. */
  counterpart: string;
  /** Outbound only: how to find the call if its SID was not known yet. */
  numberId: string | null;
  outboundIntentId: string | null;
  callSid: string | null;
  mimeType: string;
  startedAt: string;
  /** Null while recording. */
  endedAt: string | null;
  /** Last time a chunk arrived; an old one with no endedAt was cut off. */
  updatedAt: number;
  attempts: number;
  lastError: string | null;
}

export interface RecordingStore {
  put(recording: StoredBrowserRecording): Promise<void>;
  get(id: string): Promise<StoredBrowserRecording | null>;
  list(): Promise<StoredBrowserRecording[]>;
  addChunk(id: string, seq: number, data: Blob): Promise<void>;
  chunks(id: string): Promise<Blob[]>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'pstn-twilio-recordings';
const RECORDINGS = 'recordings';
const CHUNKS = 'chunks';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      db.createObjectStore(CHUNKS, { keyPath: ['id', 'seq'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function chunkRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

export const indexedDbRecordingStore: RecordingStore = {
  async put(recording) {
    const db = await openDb();
    const tx = db.transaction(RECORDINGS, 'readwrite');
    tx.objectStore(RECORDINGS).put(recording);
    await done(tx);
  },
  async get(id) {
    const db = await openDb();
    const row = await promisify(db.transaction(RECORDINGS).objectStore(RECORDINGS).get(id));
    return (row as StoredBrowserRecording | undefined) ?? null;
  },
  async list() {
    const db = await openDb();
    return (await promisify(
      db.transaction(RECORDINGS).objectStore(RECORDINGS).getAll(),
    )) as StoredBrowserRecording[];
  },
  async addChunk(id, seq, data) {
    const db = await openDb();
    const tx = db.transaction([CHUNKS, RECORDINGS], 'readwrite');
    tx.objectStore(CHUNKS).put({ id, seq, data });
    const recordings = tx.objectStore(RECORDINGS);
    const row = (await promisify(recordings.get(id))) as StoredBrowserRecording | undefined;
    if (row) recordings.put({ ...row, updatedAt: Date.now() });
    await done(tx);
  },
  async chunks(id) {
    const db = await openDb();
    const rows = (await promisify(
      db.transaction(CHUNKS).objectStore(CHUNKS).getAll(chunkRange(id)),
    )) as Array<{ seq: number; data: Blob }>;
    return rows.sort((a, b) => a.seq - b.seq).map((row) => row.data);
  },
  async remove(id) {
    const db = await openDb();
    const tx = db.transaction([CHUNKS, RECORDINGS], 'readwrite');
    tx.objectStore(CHUNKS).delete(chunkRange(id));
    tx.objectStore(RECORDINGS).delete(id);
    await done(tx);
  },
};

/** Same contract, in memory: for tests and browsers without IndexedDB. */
export function createMemoryRecordingStore(): RecordingStore {
  const recordings = new Map<string, StoredBrowserRecording>();
  const chunks = new Map<string, Map<number, Blob>>();
  return {
    async put(recording) {
      recordings.set(recording.id, { ...recording });
    },
    async get(id) {
      const row = recordings.get(id);
      return row ? { ...row } : null;
    },
    async list() {
      return [...recordings.values()].map((row) => ({ ...row }));
    },
    async addChunk(id, seq, data) {
      const forId = chunks.get(id) ?? new Map<number, Blob>();
      forId.set(seq, data);
      chunks.set(id, forId);
      const row = recordings.get(id);
      if (row) recordings.set(id, { ...row, updatedAt: Date.now() });
    },
    async chunks(id) {
      return [...(chunks.get(id) ?? new Map<number, Blob>()).entries()]
        .sort(([a], [b]) => a - b)
        .map(([, data]) => data);
    },
    async remove(id) {
      recordings.delete(id);
      chunks.delete(id);
    },
  };
}
