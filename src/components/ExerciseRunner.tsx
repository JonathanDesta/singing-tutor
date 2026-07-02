import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { TonePlayer, sleep } from "../audio/player";
import { usePitchLoop } from "../audio/usePitchLoop";
import { resolve, type Exercise } from "../lib/exercises";
import {
  analyzeSegments,
  describeAnalysis,
  type AFrame,
  type SegmentAnalysis,
} from "../lib/analysis";
import {
  applyVibratoAllowance,
  scoreSegments,
  overallScore,
  type SegmentScore,
} from "../lib/scoring";
import { addSession } from "../lib/db";
import { midiToFreq, midiToName } from "../lib/notes";
import { ExerciseStage } from "./ExerciseStage";

type Phase = "ready" | "preview" | "countin" | "sing" | "results";

const STATUS: Record<Phase, string> = {
  ready:
    "Press Start. You'll hear the exercise once, then a 3-beep count-in — then sing it back.",
  preview: "Listen…",
  countin: "Get ready…",
  sing: "Sing!",
  results: "",
};

type Props = {
  exercise: Exercise;
  rootMidi: number;
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  onExit: () => void;
};

export function ExerciseRunner({
  exercise,
  rootMidi,
  engineRef,
  source,
  toneMidi,
  onExit,
}: Props) {
  const { targets, totalMs } = useMemo(
    () => resolve(exercise, rootMidi),
    [exercise, rootMidi],
  );
  const playerRef = useRef<TonePlayer | null>(null);
  if (!playerRef.current) playerRef.current = new TonePlayer();

  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef<Phase>("ready");
  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const framesRef = useRef<AFrame[]>([]);
  const previewStartRef = useRef(0);
  const singStartRef = useRef(0);
  const runTokenRef = useRef(0);
  const savedRef = useRef(false);
  const [segScores, setSegScores] = useState<SegmentScore[] | null>(null);
  const [analyses, setAnalyses] = useState<SegmentAnalysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePitchLoop(engineRef, phase === "sing", (f) => {
    framesRef.current.push({
      t: f.now - singStartRef.current,
      midi: f.midi,
      clarity: f.clarity,
      f1: f.f1,
      f2: f.f2,
    });
  });

  useEffect(
    () => () => {
      runTokenRef.current++;
      playerRef.current?.stop();
      engineRef.current?.stop();
    },
    [engineRef],
  );

  async function run() {
    const token = ++runTokenRef.current;
    setError(null);
    setSegScores(null);
    savedRef.current = false;
    framesRef.current = [];
    try {
      await engineRef.current?.start(source, midiToFreq(toneMidi));
    } catch {
      setError(
        source === "mic"
          ? "Microphone access failed. Check browser permissions and try again."
          : "Audio failed to start.",
      );
      return;
    }
    if (token !== runTokenRef.current) return;

    go("preview");
    previewStartRef.current = performance.now();
    await playerRef.current!.playTargets(targets, totalMs);
    if (token !== runTokenRef.current) return;

    go("countin");
    await playerRef.current!.countIn(3);
    if (token !== runTokenRef.current) return;

    framesRef.current = [];
    singStartRef.current = performance.now();
    go("sing");
    await sleep(totalMs + 250);
    if (token !== runTokenRef.current) return;

    await engineRef.current?.stop();
    const scores = scoreSegments(targets, framesRef.current);
    const segAnalyses = analyzeSegments(targets, framesRef.current);
    setSegScores(
      applyVibratoAllowance(scores, segAnalyses, targets, framesRef.current),
    );
    setAnalyses(segAnalyses);
    go("results");
  }

  function stopRun() {
    runTokenRef.current++;
    playerRef.current?.stop();
    engineRef.current?.stop();
    setSegScores(null);
    setAnalyses(null);
    go("ready");
  }

  useEffect(() => {
    if (phase === "results" && segScores && analyses && !savedRef.current) {
      savedRef.current = true;
      addSession({
        date: new Date().toISOString(),
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        rootMidi,
        score: overallScore(segScores),
        segments: segScores.map((s, i) => ({
          label: s.label,
          score: s.score,
          avgCents: s.avgCents,
          analysis: analyses?.[i] ?? null,
        })),
      }).catch(() => {
        // storage failure shouldn't break the results view
      });
    }
  }, [phase, segScores, analyses, exercise, rootMidi]);

  const getProgressMs = useCallback(() => {
    const p = phaseRef.current;
    if (p === "preview") {
      return Math.min(totalMs, performance.now() - previewStartRef.current);
    }
    if (p === "sing") {
      return Math.min(totalMs, performance.now() - singStartRef.current);
    }
    if (p === "results") return totalMs;
    return null;
  }, [totalMs]);

  const busy = phase === "preview" || phase === "countin" || phase === "sing";

  return (
    <div className="runner">
      <div className="runner-head">
        <button className="secondary" onClick={onExit}>
          ← Exercises
        </button>
        <h2>{exercise.name}</h2>
        <span className="meta">starts at {midiToName(rootMidi)}</span>
      </div>

      {error && <div className="error">{error}</div>}

      <ExerciseStage
        targets={targets}
        totalMs={totalMs}
        framesRef={framesRef}
        getProgressMs={getProgressMs}
      />

      {phase !== "results" ? (
        <div className="runner-foot">
          <div className={`status ${phase === "sing" ? "sing" : ""}`}>
            {STATUS[phase]}
          </div>
          <button className="primary" onClick={busy ? stopRun : run}>
            {busy ? "Stop" : "Start"}
          </button>
        </div>
      ) : (
        segScores && (
          <div className="results">
            <div className="bigscore">{overallScore(segScores)}</div>
            <table className="stbl">
              <tbody>
                {segScores.map((s, i) => (
                  <tr key={i}>
                    <td>{s.label}</td>
                    <td>{Math.round(s.score * 100)}%</td>
                    <td>
                      {s.avgCents === null
                        ? "not voiced"
                        : Math.abs(s.avgCents) <= 10
                          ? "in tune"
                          : s.avgCents > 0
                            ? `${s.avgCents.toFixed(0)}¢ sharp`
                            : `${Math.abs(s.avgCents).toFixed(0)}¢ flat`}
                    </td>
                    <td>{Math.round(s.voicedRatio * 100)}% voiced</td>
                    <td className="chips">
                      {describeAnalysis(analyses?.[i]).map((chip, j) => (
                        <span className="chip" key={j}>
                          {chip}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-btns">
              <button className="primary" onClick={run}>
                Try again
              </button>
              <button className="secondary" onClick={onExit}>
                Back to exercises
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
