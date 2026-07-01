import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { usePitchLoop } from "../audio/usePitchLoop";
import { midiToFreq, midiToName } from "../lib/notes";
import type { Range } from "../lib/exercises";

const WINDOW_MS = 1200; // how long a note must be held steady
const MIN_FRAMES = 40;
const MIN_VOICED = 0.85;
const MAX_STDDEV = 0.5; // semitones

type Step = "low" | "high";

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  onDone: (range: Range) => void;
  onCancel: () => void;
};

export function RangeSetup({ engineRef, source, toneMidi, onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>("low");
  const stepRef = useRef<Step>("low");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const [low, setLow] = useState<number | null>(null);
  const [high, setHigh] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bufRef = useRef<{ now: number; midi: number | null }[]>([]);
  const capturedRef = useRef(false);
  const lastUiRef = useRef(0);

  usePitchLoop(engineRef, running, (f) => {
    const buf = bufRef.current;
    buf.push({ now: f.now, midi: f.midi });
    while (buf.length > 0 && buf[0].now < f.now - 2 * WINDOW_MS) buf.shift();
    if (f.now - lastUiRef.current > 120) {
      setLive(f.midi);
      lastUiRef.current = f.now;
    }
    if (capturedRef.current) return;

    const win = buf.filter((b) => b.now >= f.now - WINDOW_MS);
    const voiced = win.filter((b) => b.midi !== null);
    if (win.length < MIN_FRAMES || voiced.length / win.length < MIN_VOICED) {
      return;
    }
    const vals = voiced.map((v) => v.midi!).sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length,
    );
    if (sd <= MAX_STDDEV) {
      capturedRef.current = true;
      const median = Math.round(vals[Math.floor(vals.length / 2)]);
      if (stepRef.current === "low") setLow(median);
      else setHigh(median);
    }
  });

  useEffect(
    () => () => {
      engineRef.current?.stop();
    },
    [engineRef],
  );

  async function start() {
    setError(null);
    try {
      await engineRef.current?.start(source, midiToFreq(toneMidi));
      bufRef.current = [];
      capturedRef.current = false;
      setRunning(true);
    } catch {
      setError(
        source === "mic"
          ? "Microphone access failed. Check browser permissions and try again."
          : "Audio failed to start.",
      );
    }
  }

  function redo() {
    if (stepRef.current === "low") setLow(null);
    else setHigh(null);
    bufRef.current = [];
    capturedRef.current = false;
  }

  function nextStep() {
    stepRef.current = "high";
    setStep("high");
    bufRef.current = [];
    capturedRef.current = false;
  }

  async function save() {
    if (low === null || high === null) return;
    setRunning(false);
    await engineRef.current?.stop();
    onDone({ min: low, max: high });
  }

  const captured = step === "low" ? low : high;
  const rangeTooNarrow = low !== null && high !== null && high - low < 5;

  return (
    <div className="rangebox">
      <h2>Find your range</h2>
      <p className="muted">
        {step === "low"
          ? "Sing your LOWEST comfortable note — not a growl, just the bottom of your easy range — and hold it steady until it locks in."
          : `Low note locked: ${low !== null ? midiToName(low) : ""}. Now sing your HIGHEST comfortable note (no straining) and hold it.`}
      </p>

      {error && <div className="error">{error}</div>}

      {!running ? (
        <div className="row-btns">
          <button className="primary" onClick={start}>
            {step === "low" ? "Start" : "Resume"}
          </button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="live-note">
            {captured !== null
              ? midiToName(captured)
              : live !== null
                ? midiToName(live)
                : "—"}
          </div>
          <div className="muted">
            {captured !== null
              ? `Locked in: ${midiToName(captured)}`
              : live !== null
                ? "Hold it steady…"
                : "Listening…"}
          </div>
          <div className="row-btns">
            {captured !== null && step === "low" && (
              <button className="primary" onClick={nextStep}>
                Next: highest note
              </button>
            )}
            {captured !== null && step === "high" && !rangeTooNarrow && (
              <button className="primary" onClick={save}>
                Save range {low !== null && midiToName(low)}–
                {high !== null && midiToName(high)}
              </button>
            )}
            {captured !== null && (
              <button className="secondary" onClick={redo}>
                Redo this note
              </button>
            )}
            <button className="secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
          {rangeTooNarrow && (
            <div className="error">
              That's less than half an octave above your low note — try reaching
              a bit higher (comfortably), or redo the low note.
            </div>
          )}
        </>
      )}
    </div>
  );
}
