import type { Auth, User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import { firebaseConfig, firebaseEnabled } from "./firebase-config";
import {
  addSession,
  listSessions,
  getKV,
  setKV,
  setWriteListener,
  type SessionRec,
  type WriteEvent,
} from "./db";

export type SyncStatus =
  | "disabled" // no Firebase config committed yet
  | "signed-out"
  | "syncing"
  | "synced"
  | "error";

export type SyncState = { status: SyncStatus; user: User | null };

// Firebase is loaded dynamically so the (large) SDK costs nothing until a
// real config is committed and initSync actually runs.
type Fb = {
  auth: Auth;
  db: Firestore;
  authMod: typeof import("firebase/auth");
  fsMod: typeof import("firebase/firestore");
};

let fb: Fb | null = null;
let state: SyncState = { status: "disabled", user: null };
let importing = false; // suppress push-back while importing remote data
const subscribers = new Set<(s: SyncState) => void>();

function setState(next: Partial<SyncState>): void {
  state = { ...state, ...next };
  for (const fn of subscribers) fn(state);
}

export function subscribeSync(fn: (s: SyncState) => void): () => void {
  subscribers.add(fn);
  fn(state);
  return () => subscribers.delete(fn);
}

/** Singleton KV keys that mirror to the user's Firestore doc. */
const KV_KEYS = [
  "profile",
  "goal",
  "program",
  "last-feedback",
  "customSongs",
  "coach-chat",
  "coach-log",
  "songStyles",
];

const sessionKey = (s: SessionRec) => `${s.date}|${s.exerciseId}`;

async function fullSync(user: User): Promise<void> {
  if (!fb) return;
  const { db, fsMod } = fb;
  const userDoc = fsMod.doc(db, "users", user.uid);

  // --- singletons: the active device wins; missing locally -> pull remote
  const snap = await fsMod.getDoc(userDoc);
  const remote = (snap.exists() ? snap.data() : {}) as Record<string, unknown>;
  const toPush: Record<string, unknown> = {};
  importing = true;
  try {
    for (const key of KV_KEYS) {
      const local = await getKV(key);
      if (local !== undefined) {
        toPush[key] = local;
      } else if (remote[key] !== undefined) {
        await setKV(key, remote[key]);
      }
    }
  } finally {
    importing = false;
  }
  if (Object.keys(toPush).length > 0) {
    await fsMod.setDoc(userDoc, toPush, { merge: true });
  }

  // --- sessions: union across devices, keyed by (date, exerciseId)
  const remoteSnap = await fsMod.getDocs(
    fsMod.collection(db, "users", user.uid, "sessions"),
  );
  const remoteSessions = remoteSnap.docs.map((d) => d.data() as SessionRec);
  const localSessions = await listSessions();
  const localKeys = new Set(localSessions.map(sessionKey));
  const remoteKeys = new Set(remoteSessions.map(sessionKey));

  importing = true;
  try {
    for (const r of remoteSessions) {
      if (!localKeys.has(sessionKey(r))) await addSession(r);
    }
  } finally {
    importing = false;
  }

  const missing = localSessions.filter((l) => !remoteKeys.has(sessionKey(l)));
  // Firestore batches cap at 500 writes; chunk to stay well under
  for (let i = 0; i < missing.length; i += 400) {
    const batch = fsMod.writeBatch(db);
    for (const l of missing.slice(i, i + 400)) {
      batch.set(fsMod.doc(fsMod.collection(db, "users", user.uid, "sessions")), l);
    }
    await batch.commit();
  }
}

function pushWrite(e: WriteEvent): void {
  if (!fb || !state.user || importing) return;
  const { db, fsMod } = fb;
  const uid = state.user.uid;
  if (e.kind === "session") {
    fsMod
      .setDoc(fsMod.doc(fsMod.collection(db, "users", uid, "sessions")), e.value)
      .catch(() => {
        // offline or rules issue — next fullSync reconciles
      });
  } else if (KV_KEYS.includes(e.key)) {
    fsMod
      .setDoc(fsMod.doc(db, "users", uid), { [e.key]: e.value }, { merge: true })
      .catch(() => {});
  }
}

export async function initSync(): Promise<void> {
  if (!firebaseEnabled) return;
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
  ]);
  const app = initializeApp(firebaseConfig);
  fb = { auth: authMod.getAuth(app), db: fsMod.getFirestore(app), authMod, fsMod };
  setState({ status: "signed-out" });
  setWriteListener(pushWrite);

  authMod.onAuthStateChanged(fb.auth, async (user) => {
    if (!user) {
      setState({ status: "signed-out", user: null });
      return;
    }
    setState({ status: "syncing", user });
    try {
      await fullSync(user);
      setState({ status: "synced" });
      window.dispatchEvent(new Event("data-synced"));
    } catch (err) {
      console.error("sync failed", err);
      setState({ status: "error" });
    }
  });
}

export function isSignedIn(): boolean {
  return state.user !== null;
}

/** Deletes the signed-in user's entire cloud copy. No-op when signed out. */
export async function clearCloudData(): Promise<void> {
  if (!fb || !state.user) return;
  const { db, fsMod } = fb;
  const uid = state.user.uid;
  const snap = await fsMod.getDocs(fsMod.collection(db, "users", uid, "sessions"));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = fsMod.writeBatch(db);
    for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  await fsMod.deleteDoc(fsMod.doc(db, "users", uid));
}

export async function signIn(): Promise<void> {
  if (!fb) return;
  await fb.authMod.signInWithPopup(fb.auth, new fb.authMod.GoogleAuthProvider());
}

export async function signOutUser(): Promise<void> {
  if (!fb) return;
  await fb.authMod.signOut(fb.auth);
}
