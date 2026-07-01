import { useEffect, useRef, type MutableRefObject } from "react";
import { midiToName } from "../lib/notes";

export type TracePoint = { t: number; midi: number | null };

const WINDOW_MS = 8000;
const GAP_MS = 120; // break the trace line across silences longer than this
const SEMITONE_SPAN = 13; // vertical range above/below target

type Props = {
  pointsRef: MutableRefObject<TracePoint[]>;
  targetMidi: number;
};

export function PitchTrace({ pointsRef, targetMidi }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;

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

      const lo = targetMidi - SEMITONE_SPAN;
      const hi = targetMidi + SEMITONE_SPAN;
      const yOf = (m: number) => h - ((m - lo) / (hi - lo)) * h;

      // in-tune band: ±25 cents around the target
      const bandTop = yOf(targetMidi + 0.25);
      const bandBot = yOf(targetMidi - 0.25);
      ctx.fillStyle = "rgba(74, 222, 128, 0.12)";
      ctx.fillRect(0, bandTop, w, bandBot - bandTop);

      ctx.font = "11px system-ui, sans-serif";
      for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
        const y = yOf(m);
        const isTarget = m === targetMidi;
        ctx.strokeStyle = isTarget ? "#4ade80" : "rgba(255,255,255,0.06)";
        ctx.lineWidth = isTarget ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        const name = midiToName(m);
        if (isTarget || !name.includes("#")) {
          ctx.fillStyle = isTarget ? "#4ade80" : "rgba(255,255,255,0.35)";
          ctx.fillText(name, 6, y - 3);
        }
      }

      // pitch trace, newest at the right edge
      const now = performance.now();
      const xOf = (t: number) => w - ((now - t) / WINDOW_MS) * w;
      const pts = pointsRef.current;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      let prev: TracePoint | null = null;
      for (const p of pts) {
        if (
          p.midi !== null &&
          prev !== null &&
          prev.midi !== null &&
          p.t - prev.t < GAP_MS
        ) {
          const cents = Math.abs(p.midi - targetMidi) * 100;
          ctx.strokeStyle =
            cents <= 25 ? "#4ade80" : cents <= 60 ? "#facc15" : "#fb7185";
          ctx.beginPath();
          ctx.moveTo(xOf(prev.t), yOf(prev.midi));
          ctx.lineTo(xOf(p.t), yOf(p.midi));
          ctx.stroke();
        }
        prev = p;
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [targetMidi, pointsRef]);

  return <canvas ref={canvasRef} className="trace" />;
}
