import { useEffect, useRef, useState } from "react";
import { PitchDetector } from "pitchy";
import { AudioEngine, type SourceKind } from "./audio/engine";
import { PitchTrace, type TracePoint } from "./components/PitchTrace";
import { freqToMidi, midiToFreq, midiToName } from "./lib/notes";

const BUFFER_SIZE = 2048; // must match AnalyserNode fftSize
const MIN_CLARITY = 0.9;
const MIN_FREQ = 50;
const MAX_FREQ = 1500;
const MIN_RMS = 0.004; // gate out silence / room noise
const TRACE_RETENTION_MS = 10000;

type Reading = { freq: number; midi: number; clarity: number };

const TARGET_CHOICES: number[] = [];
for (let m = 36; m <= 84; m++) TARGET_CHOICES.push(m); // C2..C6

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  const detectorRef = useRef(PitchDetector.forFloat32Array(BUFFER_SIZE));
  const pointsRef = useRef<TracePoint[]>([]);
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState<SourceKind>("mic");
  const [targetMidi, setTargetMidi] = useState(60); // C4
  const [toneMidi, setToneMidi] = useState(60);
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const buf = new Float32Array(BUFFER_SIZE);
    let lastReadingUpdate = 0;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const engine = engineRef.current;
      if (!engine || !engine.readInto(buf)) return;

      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);

      const now = performance.now();
      const point: TracePoint = { t: now, midi: null };

      if (rms > MIN_RMS) {
        const [freq, clarity] = detectorRef.current.findPitch(
          buf,
          engine.sampleRate,
        );
        if (clarity >= MIN_CLARITY && freq >= MIN_FREQ && freq <= MAX_FREQ) {
          point.midi = freqToMidi(freq);
          if (now - lastReadingUpdate > 100) {
            setReading({ freq, midi: point.midi, clarity });
            lastReadingUpdate = now;
          }
        }
      }
      if (point.midi === null && now - lastReadingUpdate > 500) {
        setReading(null);
        lastReadingUpdate = now;
      }

      const pts = pointsRef.current;
      pts.push(point);
      const cutoff = now - TRACE_RETENTION_MS;
      while (pts.length > 0 && pts[0].t < cutoff) pts.shift();
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // retune the test oscillator live as the slider moves
  useEffect(() => {
    if (running && source === "tone") {
      engineRef.current?.setToneFreq(midiToFreq(toneMidi));
    }
  }, [toneMidi, running, source]);

  async function handleStart() {
    setError(null);
    try {
      const engine = engineRef.current ?? new AudioEngine();
      engineRef.current = engine;
      await engine.start(source, midiToFreq(toneMidi));
      pointsRef.current = [];
      setRunning(true);
    } catch (e) {
      setError(
        source === "mic"
          ? "Microphone access failed. Check browser permissions and try again."
          : `Audio failed to start: ${e instanceof Error ? e.message : e}`,
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
    <div className="app">
      <header>
        <h1>Singing Tutor</h1>
        <span className="phase">Phase 1 · pitch engine</span>
      </header>

      <div className="controls">
        <div className="field">
          <label>Input</label>
          <div className="segmented">
            <button
              className={source === "mic" ? "on" : ""}
              disabled={running}
              onClick={() => setSource("mic")}
            >
              Microphone
            </button>
            <button
              className={source === "tone" ? "on" : ""}
              disabled={running}
              onClick={() => setSource("tone")}
            >
              Test tone
            </button>
          </div>
        </div>

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

        {source === "tone" && (
          <div className="field grow">
            <label>
              Tone: {midiToName(toneMidi)} ({midiToFreq(toneMidi).toFixed(1)}{" "}
              Hz)
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
    </div>
  );
}
