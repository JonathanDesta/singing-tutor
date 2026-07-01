import { useEffect, useRef, useState } from "react";
import { AudioEngine, type SourceKind } from "./audio/engine";
import { getProfile, saveProfile, type Profile } from "./lib/db";
import { midiToFreq, midiToName } from "./lib/notes";
import { FreeSing } from "./components/FreeSing";
import { Practice } from "./components/Practice";
import { Progress } from "./components/Progress";

type View = "practice" | "free" | "progress";

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();

  const [view, setView] = useState<View>("practice");
  const [source, setSource] = useState<SourceKind>("mic");
  const [toneMidi, setToneMidi] = useState(57); // A3, matches default exercise root
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    getProfile()
      .then((p) => setProfile(p ?? null))
      .catch(() => setProfile(null));
  }, []);

  // retune the shared test oscillator live (no-op when mic or stopped)
  useEffect(() => {
    engineRef.current?.setToneFreq(midiToFreq(toneMidi));
  }, [toneMidi]);

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
        <span className="phase">Phase 2 · practice &amp; scoring</span>
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
      {view === "free" && (
        <FreeSing engineRef={engineRef} source={source} toneMidi={toneMidi} />
      )}
      {view === "progress" && <Progress profile={profile} />}
    </div>
  );
}
