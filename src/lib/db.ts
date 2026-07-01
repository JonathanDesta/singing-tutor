export type SessionRec = {
  date: string; // ISO
  exerciseId: string;
  exerciseName: string;
  rootMidi: number;
  score: number; // 0..100
  segments: { label: string; score: number; avgCents: number | null }[];
};

export type Profile = { rangeMin: number; rangeMax: number };

const DB_NAME = "singing-tutor";

/**
 * Write notifications let the sync layer mirror local writes to the cloud
 * without this module knowing anything about Firebase.
 */
export type WriteEvent =
  | { kind: "session"; value: SessionRec }
  | { kind: "kv"; key: string; value: unknown };

let writeListener: ((e: WriteEvent) => void) | null = null;

export function setWriteListener(l: ((e: WriteEvent) => void) | null): void {
  writeListener = l;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const tx = db.transaction(store, mode);
    const req = op(tx.objectStore(store));
    req.onsuccess = () => res(req.result as T);
    req.onerror = () => rej(req.error);
    tx.oncomplete = () => db.close();
  });
}

export const addSession = async (rec: SessionRec) => {
  const key = await run<IDBValidKey>("sessions", "readwrite", (s) => s.add(rec));
  writeListener?.({ kind: "session", value: rec });
  return key;
};

export const listSessions = () =>
  run<SessionRec[]>("sessions", "readonly", (s) => s.getAll());

export const getProfile = () =>
  run<Profile | undefined>("kv", "readonly", (s) => s.get("profile"));

export const saveProfile = async (p: Profile) => {
  const key = await run<IDBValidKey>("kv", "readwrite", (s) => s.put(p, "profile"));
  writeListener?.({ kind: "kv", key: "profile", value: p });
  return key;
};

export const getKV = <T>(key: string) =>
  run<T | undefined>("kv", "readonly", (s) => s.get(key));

export const setKV = async (key: string, value: unknown) => {
  const k = await run<IDBValidKey>("kv", "readwrite", (s) => s.put(value, key));
  writeListener?.({ kind: "kv", key, value });
  return k;
};
