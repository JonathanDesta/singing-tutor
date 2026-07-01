import { useEffect, useRef, type MutableRefObject } from "react";
import type { TimedTarget } from "../lib/exercises";
import type { Frame } from "../lib/scoring";
import { midiToName } from "../lib/notes";

const PAD_MS = 400; // horizontal breathing room before/after the exercise
const GAP_MS = 120;

type Props = {
  targets: TimedTarget[];
  totalMs: number;
  /** frames with t relative to the sing-phase start */
  framesRef: MutableRefObject<Frame[]>;
  /** current playhead position in exercise time, or null when idle */
  getProgressMs: () => number | null;
};

function targetAt(targets: TimedTarget[], t: number): number | null {
  for (const tg of targets) {
    if (t >= tg.t0 && t <= tg.t1) {
      const p = (t - tg.t0) / (tg.t1 - tg.t0);
      return tg.midi0 + (tg.midi1 - tg.midi0) * p;
    }
  }
  return null;
}

export function ExerciseStage({ targets, totalMs, framesRef, getProgressMs }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const tg of targets) {
      lo = Math.min(lo, tg.midi0, tg.midi1);
      hi = Math.max(hi, tg.midi0, tg.midi1);
    }
    lo -= 4;
    hi += 4;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = "#12141a";
      ctx.fillRect(0, 0, w, h);

      const xOf = (t: number) => ((t + PAD_MS) / (totalMs + 2 * PAD_MS)) * w;
      const yOf = (m: number) => h - ((m - lo) / (hi - lo)) * h;
      const semitoneH = h / (hi - lo);

      // gridlines on natural notes
      ctx.font = "11px system-ui, sans-serif";
      for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
        const name = midiToName(m);
        if (name.includes("#")) continue;
        const y = yOf(m);
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillText(name, 6, y - 3);
      }

      // target bars (slanted for glides)
      ctx.lineCap = "round";
      for (const tg of targets) {
        ctx.strokeStyle = "rgba(74, 222, 128, 0.28)";
        ctx.lineWidth = Math.max(6, semitoneH * 0.55);
        ctx.beginPath();
        ctx.moveTo(xOf(tg.t0) + 3, yOf(tg.midi0));
        ctx.lineTo(xOf(tg.t1) - 3, yOf(tg.midi1));
        ctx.stroke();
        if (tg.midi0 === tg.midi1) {
          ctx.fillStyle = "rgba(74, 222, 128, 0.75)";
          ctx.fillText(tg.label, xOf(tg.t0) + 4, yOf(tg.midi0) - semitoneH * 0.45);
        }
      }

      // sung trace
      const frames = framesRef.current;
      ctx.lineWidth = 2.5;
      let prev: Frame | null = null;
      for (const f of frames) {
        if (
          f.midi !== null &&
          prev !== null &&
          prev.midi !== null &&
          f.t - prev.t < GAP_MS
        ) {
          const target = targetAt(targets, f.t);
          if (target === null) {
            ctx.strokeStyle = "rgba(255,255,255,0.35)";
          } else {
            const cents = Math.abs(f.midi - target) * 100;
            ctx.strokeStyle =
              cents <= 25 ? "#4ade80" : cents <= 60 ? "#facc15" : "#fb7185";
          }
          ctx.beginPath();
          ctx.moveTo(xOf(prev.t), yOf(prev.midi));
          ctx.lineTo(xOf(f.t), yOf(f.midi));
          ctx.stroke();
        }
        prev = f;
      }

      // playhead
      const progress = getProgressMs();
      if (progress !== null) {
        const x = xOf(Math.min(progress, totalMs));
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [targets, totalMs, framesRef, getProgressMs]);

  return <canvas ref={canvasRef} className="trace stage" />;
}
