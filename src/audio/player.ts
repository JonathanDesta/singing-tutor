import { midiToFreq } from "../lib/notes";
import type { TimedTarget } from "../lib/exercises";

export const sleep = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

/** Plays reference tones through the speakers (preview playback + count-in). */
export class TonePlayer {
  private ctx: AudioContext | null = null;
  private nodes: OscillatorNode[] = [];

  private ensure(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  async playTargets(targets: TimedTarget[], totalMs: number): Promise<void> {
    const ctx = this.ensure();
    await ctx.resume();
    const start = ctx.currentTime + 0.05;
    for (const tg of targets) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      const t0 = start + tg.t0 / 1000;
      const t1 = start + tg.t1 / 1000;
      osc.frequency.setValueAtTime(midiToFreq(tg.midi0), t0);
      if (tg.midi1 !== tg.midi0) {
        osc.frequency.exponentialRampToValueAtTime(midiToFreq(tg.midi1), t1);
      }
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.03);
      gain.gain.setValueAtTime(0.22, Math.max(t0 + 0.03, t1 - 0.08));
      gain.gain.linearRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
      this.nodes.push(osc);
    }
    await sleep(totalMs + 150);
    this.nodes = [];
  }

  async countIn(beats = 3): Promise<void> {
    const ctx = this.ensure();
    await ctx.resume();
    const start = ctx.currentTime + 0.05;
    for (let i = 0; i < beats; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i === beats - 1 ? 1174.66 : 880; // last beep higher
      const t0 = start + i * 0.6;
      gain.gain.setValueAtTime(0.18, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
      this.nodes.push(osc);
    }
    await sleep(beats * 600 + 100);
    this.nodes = [];
  }

  stop(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
    }
    this.nodes = [];
  }
}
