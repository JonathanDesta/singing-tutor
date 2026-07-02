export type SourceKind = "mic" | "tone";

/** Samples per analysis window (about 43 ms at 48 kHz). */
export const CAPTURE_SIZE = 2048;

/** Notify listeners every N worklet chunks (N × 128 samples ≈ 21 ms). */
const CHUNKS_PER_NOTIFY = 8;

// Runs on the audio rendering thread, so capture continues even when the
// page is hidden (rAF and timers stop firing on hidden pages, the audio
// thread does not). It forwards raw input chunks and outputs silence.
const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch);
    return true;
  }
}
registerProcessor("tap", Tap);
`;

export type BufferListener = (buf: Float32Array, sampleRate: number) => void;

/**
 * Owns the Web Audio graph. Two source modes feed one worklet tap:
 *  - "mic": raw microphone input (echo cancellation / noise suppression off,
 *    since those DSP stages distort pitch content)
 *  - "tone": a sine oscillator used to exercise the detection pipeline
 *    without a mic; the tap emits silence, so neither mode is audible
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private osc: OscillatorNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private toneVibrato = false;
  private tap: AudioWorkletNode | null = null;
  private clipBuffer: AudioBuffer | null = null;
  private clipSrc: AudioBufferSourceNode | null = null;
  private clipStartedAt = 0;
  private ring = new Float32Array(CAPTURE_SIZE);
  private scratch = new Float32Array(CAPTURE_SIZE);
  private received = 0;
  private chunksSinceNotify = 0;
  private listeners = new Set<BufferListener>();

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Listener is called with the latest CAPTURE_SIZE samples ~every 21 ms while running. */
  subscribe(fn: BufferListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(kind: SourceKind, toneFreq = 261.63): Promise<void> {
    await this.stop();
    const ctx = new AudioContext();
    this.ctx = ctx; // assign before source setup: attachLfo needs it
    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const tap = new AudioWorkletNode(ctx, "tap");
    // connecting to the destination keeps the graph pulled; output is silence
    tap.connect(ctx.destination);
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);

    let sourceNode: AudioNode;
    if (kind === "mic") {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.mediaStream = stream;
      sourceNode = ctx.createMediaStreamSource(stream);
    } else {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = toneFreq;
      osc.start();
      this.osc = osc;
      sourceNode = osc;
      if (this.toneVibrato) this.attachLfo();
    }
    sourceNode.connect(tap);

    this.ring.fill(0);
    this.received = 0;
    this.chunksSinceNotify = 0;
    this.tap = tap;
    await ctx.resume();
  }

  private push(chunk: Float32Array): void {
    const n = chunk.length;
    this.ring.copyWithin(0, n);
    this.ring.set(chunk, CAPTURE_SIZE - n);
    this.received += n;
    this.chunksSinceNotify++;
    if (
      this.received >= CAPTURE_SIZE &&
      this.chunksSinceNotify >= CHUNKS_PER_NOTIFY
    ) {
      this.chunksSinceNotify = 0;
      this.scratch.set(this.ring);
      const sr = this.sampleRate;
      for (const fn of this.listeners) fn(this.scratch, sr);
    }
  }

  setToneFreq(freq: number): void {
    if (this.osc && this.ctx) {
      this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.02);
      if (this.lfoGain) this.lfoGain.gain.value = freq * 0.03;
    }
  }

  /** Adds/removes a 5.5 Hz ±~50¢ FM wobble on the test tone (dev aid). */
  setToneVibrato(on: boolean): void {
    this.toneVibrato = on;
    if (on && this.osc && !this.lfo) this.attachLfo();
    if (!on && this.lfo) this.detachLfo();
  }

  private attachLfo(): void {
    if (!this.ctx || !this.osc) return;
    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.5;
    const gain = this.ctx.createGain();
    gain.gain.value = this.osc.frequency.value * 0.03; // ~±50 cents
    lfo.connect(gain).connect(this.osc.frequency);
    lfo.start();
    this.lfo = lfo;
    this.lfoGain = gain;
  }

  private detachLfo(): void {
    try {
      this.lfo?.stop();
      this.lfo?.disconnect();
      this.lfoGain?.disconnect();
    } catch {
      // already stopped
    }
    this.lfo = null;
    this.lfoGain = null;
  }

  /**
   * Decodes a clip (e.g. an iTunes preview) for playback through this
   * engine's context. Requires a started engine — sing-along flows start the
   * mic first, then load. Returns the clip duration in seconds. The engine
   * keeps only the decoded buffer; callers keep the raw bytes for reloads
   * after stop() (decode detaches the ArrayBuffer, so pass a copy).
   */
  async loadClip(data: ArrayBuffer): Promise<number> {
    if (!this.ctx) throw new Error("engine not started");
    this.clipBuffer = await this.ctx.decodeAudioData(data);
    return this.clipBuffer.duration;
  }

  /** Plays the loaded clip audibly (mic capture continues in parallel). */
  playClip(onEnded?: () => void): void {
    if (!this.ctx || !this.clipBuffer) throw new Error("no clip loaded");
    this.stopClip();
    const src = this.ctx.createBufferSource();
    src.buffer = this.clipBuffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.clipSrc === src) this.clipSrc = null;
      onEnded?.();
    };
    this.clipStartedAt = this.ctx.currentTime;
    src.start();
    this.clipSrc = src;
  }

  stopClip(): void {
    if (this.clipSrc) {
      const src = this.clipSrc;
      this.clipSrc = null;
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      src.disconnect();
    }
  }

  /** Seconds into the playing clip, or null when nothing is playing. */
  clipPosition(): number | null {
    if (!this.ctx || !this.clipSrc) return null;
    return this.ctx.currentTime - this.clipStartedAt;
  }

  get clipDuration(): number | null {
    return this.clipBuffer?.duration ?? null;
  }

  async stop(): Promise<void> {
    this.stopClip();
    this.clipBuffer = null;
    this.detachLfo();
    this.osc?.stop();
    this.osc = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    if (this.tap) {
      this.tap.port.onmessage = null;
      this.tap.disconnect();
      this.tap = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close();
    }
  }
}
