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

export const addSession = (rec: SessionRec) =>
  run<IDBValidKey>("sessions", "readwrite", (s) => s.add(rec));

export const listSessions = () =>
  run<SessionRec[]>("sessions", "readonly", (s) => s.getAll());

export const getProfile = () =>
  run<Profile | undefined>("kv", "readonly", (s) => s.get("profile"));

export const saveProfile = (p: Profile) =>
  run<IDBValidKey>("kv", "readwrite", (s) => s.put(p, "profile"));
