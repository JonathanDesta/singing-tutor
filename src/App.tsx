import { useEffect, useRef, useState } from "react";
import { AudioEngine, type SourceKind } from "./audio/engine";
import { getProfile, saveProfile, type Profile } from "./lib/db";
import {
  initSync,
  signIn,
  signOutUser,
  subscribeSync,
  type SyncState,
} from "./lib/sync";
import { midiToFreq, midiToName } from "./lib/notes";
import { FreeSing } from "./components/FreeSing";
import { Practice } from "./components/Practice";
import { Progress } from "./components/Progress";
import { Coach } from "./components/Coach";
import { Songs } from "./components/Songs";

type View = "practice" | "songs" | "coach" | "free" | "progress";

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();

  const [view, setView] = useState<View>("practice");
  const [source, setSource] = useState<SourceKind>("mic");
  const [toneMidi, setToneMidi] = useState(57); // A3, matches default exercise root
  const [toneVibrato, setToneVibrato] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sync, setSync] = useState<SyncState>({
    status: "disabled",
    user: null,
  });

  useEffect(() => {
    const loadProfile = () =>
      getProfile()
        .then((p) => setProfile(p ?? null))
        .catch(() => setProfile(null));
    loadProfile();
    initSync();
    const unsub = subscribeSync(setSync);
    window.addEventListener("data-synced", loadProfile);
    return () => {
      unsub();
      window.removeEventListener("data-synced", loadProfile);
    };
  }, []);

  // retune the shared test oscillator live (no-op when mic or stopped)
  useEffect(() => {
    engineRef.current?.setToneFreq(midiToFreq(toneMidi));
  }, [toneMidi]);

  useEffect(() => {
    engineRef.current?.setToneVibrato(toneVibrato);
  }, [toneVibrato]);

  // leaving a view always releases the mic/oscillator
  useEffect(() => {
    engineRef.current?.stop();
  }, [view]);

  function handleProfileSaved(p: Profile) {
    setProfile(p);
    saveProfile(p).catch(() => {
      // storage failure shouldn't block the UI; range still applies this session
    });
  }

  return (
    <div className="app">
      <header>
        <h1>Singing Tutor</h1>
        <span className="phase">Phase 5 · songs &amp; PWA</span>
        <div className="account">
          {sync.status === "disabled" ? (
            <span className="muted sync-off" title="Firebase not configured yet">
              sync off
            </span>
          ) : sync.user ? (
            <>
              <span className="muted">
                {sync.user.email}
                {sync.status === "syncing" && " · syncing…"}
                {sync.status === "synced" && " · synced ✓"}
                {sync.status === "error" && " · sync error"}
              </span>
              <button className="secondary" onClick={() => signOutUser()}>
                Sign out
              </button>
            </>
          ) : (
            <button className="secondary" onClick={() => signIn()}>
              Sign in to sync
            </button>
          )}
        </div>
      </header>

      <div className="controls topbar">
        <nav className="segmented nav">
          <button
            className={view === "practice" ? "on" : ""}
            onClick={() => setView("practice")}
          >
            Practice
          </button>
          <button
            className={view === "songs" ? "on" : ""}
            onClick={() => setView("songs")}
          >
            Songs
          </button>
          <button
            className={view === "coach" ? "on" : ""}
            onClick={() => setView("coach")}
          >
            Coach
          </button>
          <button
            className={view === "free" ? "on" : ""}
            onClick={() => setView("free")}
          >
            Free sing
          </button>
          <button
            className={view === "progress" ? "on" : ""}
            onClick={() => setView("progress")}
          >
            Progress
          </button>
        </nav>

        <div className="field">
          <label>Input</label>
          <div className="segmented">
            <button
              className={source === "mic" ? "on" : ""}
              onClick={() => setSource("mic")}
            >
              Microphone
            </button>
            <button
              className={source === "tone" ? "on" : ""}
              onClick={() => setSource("tone")}
            >
              Test tone
            </button>
          </div>
        </div>

        {source === "tone" && (
          <div className="field grow">
            <label>
              Tone: {midiToName(toneMidi)} ({midiToFreq(toneMidi).toFixed(1)} Hz)
              {"  "}
              <span className="chk">
                <input
                  type="checkbox"
                  checked={toneVibrato}
                  onChange={(e) => setToneVibrato(e.target.checked)}
                />{" "}
                vibrato
              </span>
            </label>
            <input
              type="range"
              min={36}
              max={84}
              value={toneMidi}
              onChange={(e) => setToneMidi(Number(e.target.value))}
            />
          </div>
        )}
      </div>

      {view === "practice" && (
        <Practice
          engineRef={engineRef}
          source={source}
          toneMidi={toneMidi}
          profile={profile}
          onProfileSaved={handleProfileSaved}
        />
      )}
      {view === "songs" && (
        <Songs
          engineRef={engineRef}
          source={source}
          toneMidi={toneMidi}
          profile={profile}
        />
      )}
      {view === "coach" && <Coach profile={profile} />}
      {view === "free" && (
        <FreeSing engineRef={engineRef} source={source} toneMidi={toneMidi} />
      )}
      {view === "progress" && <Progress profile={profile} />}
    </div>
  );
}
