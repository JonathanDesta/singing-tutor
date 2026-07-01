import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { usePitchLoop } from "../audio/usePitchLoop";
import { PitchTrace, type TracePoint } from "./PitchTrace";
import { midiToFreq, midiToName } from "../lib/notes";

const TRACE_RETENTION_MS = 10000;

type Reading = { freq: number; midi: number; clarity: number };

const TARGET_CHOICES: number[] = [];
for (let m = 36; m <= 84; m++) TARGET_CHOICES.push(m); // C2..C6

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
};

export function FreeSing({ engineRef, source, toneMidi }: Props) {
  const pointsRef = useRef<TracePoint[]>([]);
  const lastUpdateRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [targetMidi, setTargetMidi] = useState(60); // C4
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePitchLoop(engineRef, running, (f) => {
    const pts = pointsRef.current;
    pts.push({ t: f.now, midi: f.midi });
    while (pts.length > 0 && pts[0].t < f.now - TRACE_RETENTION_MS) pts.shift();
    if (f.midi !== null && f.freq !== null) {
      if (f.now - lastUpdateRef.current > 100) {
        setReading({ freq: f.freq, midi: f.midi, clarity: f.clarity });
        lastUpdateRef.current = f.now;
      }
    } else if (f.now - lastUpdateRef.current > 500) {
      setReading(null);
      lastUpdateRef.current = f.now;
    }
  });

  useEffect(
    () => () => {
      engineRef.current?.stop();
    },
    [engineRef],
  );

  async function handleStart() {
    setError(null);
    try {
      await engineRef.current?.start(source, midiToFreq(toneMidi));
      pointsRef.current = [];
      setRunning(true);
    } catch {
      setError(
        source === "mic"
          ? "Microphone access failed. Check browser permissions and try again."
          : "Audio failed to start.",
      );
    }
  }

  async function handleStop() {
    setRunning(false);
    setReading(null);
    await engineRef.current?.stop();
  }

  const centsVsTarget = reading ? (reading.midi - targetMidi) * 100 : null;
  const centsVsNearest = reading
    ? (reading.midi - Math.round(reading.midi)) * 100
    : null;

  return (
    <>
      <div className="controls">
        <div className="field">
          <label>Target note</label>
          <select
            value={targetMidi}
            onChange={(e) => setTargetMidi(Number(e.target.value))}
          >
            {TARGET_CHOICES.map((m) => (
              <option key={m} value={m}>
                {midiToName(m)}
              </option>
            ))}
          </select>
        </div>
        <button
          className="primary"
          onClick={running ? handleStop : handleStart}
        >
          {running ? "Stop" : "Start"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <PitchTrace pointsRef={pointsRef} targetMidi={targetMidi} />

      <div className="readout">
        {reading && centsVsTarget !== null && centsVsNearest !== null ? (
          <>
            <div className="note">{midiToName(reading.midi)}</div>
            <div className="detail">
              {reading.freq.toFixed(1)} Hz · {centsVsNearest >= 0 ? "+" : ""}
              {centsVsNearest.toFixed(0)}¢ of {midiToName(reading.midi)}
            </div>
            <div
              className={`vs ${Math.abs(centsVsTarget) <= 25 ? "good" : "off"}`}
            >
              {Math.abs(centsVsTarget) <= 25
                ? `On target (${midiToName(targetMidi)})`
                : centsVsTarget > 0
                  ? `${centsVsTarget.toFixed(0)}¢ above ${midiToName(targetMidi)}`
                  : `${Math.abs(centsVsTarget).toFixed(0)}¢ below ${midiToName(targetMidi)}`}
            </div>
          </>
        ) : (
          <div className="idle">
            {running
              ? "Listening…"
              : "Pick a target note, press Start, and sing."}
          </div>
        )}
      </div>
    </>
  );
}
