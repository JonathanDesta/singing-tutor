import { useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { EXERCISES, pickRoot, type Exercise, type Range } from "../lib/exercises";
import { midiToName } from "../lib/notes";
import type { Profile } from "../lib/db";
import { ExerciseRunner } from "./ExerciseRunner";
import { RangeSetup } from "./RangeSetup";

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  profile: Profile | null;
  onProfileSaved: (p: Profile) => void;
};

export function Practice({
  engineRef,
  source,
  toneMidi,
  profile,
  onProfileSaved,
}: Props) {
  const [mode, setMode] = useState<"list" | "range">("list");
  const [current, setCurrent] = useState<Exercise | null>(null);

  const range: Range | null = profile
    ? { min: profile.rangeMin, max: profile.rangeMax }
    : null;

  if (mode === "range") {
    return (
      <RangeSetup
        engineRef={engineRef}
        source={source}
        toneMidi={toneMidi}
        onDone={(r) => {
          onProfileSaved({ rangeMin: r.min, rangeMax: r.max });
          setMode("list");
        }}
        onCancel={() => setMode("list")}
      />
    );
  }

  if (current) {
    return (
      <ExerciseRunner
        exercise={current}
        rootMidi={pickRoot(current, range)}
        engineRef={engineRef}
        source={source}
        toneMidi={toneMidi}
        onExit={() => setCurrent(null)}
      />
    );
  }

  return (
    <>
      <div className="banner">
        {range ? (
          <>
            <span>
              Your range: <strong>{midiToName(range.min)}–{midiToName(range.max)}</strong>{" "}
              — exercises are pitched to fit it.
            </span>
            <button className="secondary" onClick={() => setMode("range")}>
              Re-detect
            </button>
          </>
        ) : (
          <>
            <span>
              Detect your vocal range first so exercises sit comfortably in
              your voice. (You can practice without it — exercises will use a
              generic middle range.)
            </span>
            <button className="primary" onClick={() => setMode("range")}>
              Find my range
            </button>
          </>
        )}
      </div>

      <div className="cards">
        {EXERCISES.map((ex) => (
          <div className="card" key={ex.id}>
            <h3>{ex.name}</h3>
            <p>{ex.description}</p>
            <div className="meta">
              starts at {midiToName(pickRoot(ex, range))}
              {ex.span > 0 && ` · spans ${ex.span} semitones`}
            </div>
            <button className="primary" onClick={() => setCurrent(ex)}>
              Start
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
