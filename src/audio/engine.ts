export type SourceKind = "mic" | "tone";

/**
 * Owns the Web Audio graph. Two source modes share one AnalyserNode:
 *  - "mic": raw microphone input (echo cancellation / noise suppression off,
 *    since those DSP stages distort pitch content)
 *  - "tone": a sine oscillator routed into the analyser only (never to the
 *    speakers), used to exercise the detection pipeline without a mic
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private osc: OscillatorNode | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  async start(kind: SourceKind, toneFreq = 261.63): Promise<void> {
    await this.stop();
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    if (kind === "mic") {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.mediaStream = stream;
      ctx.createMediaStreamSource(stream).connect(analyser);
    } else {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = toneFreq;
      osc.connect(analyser);
      osc.start();
      this.osc = osc;
    }

    this.ctx = ctx;
    this.analyser = analyser;
    await ctx.resume();
  }

  setToneFreq(freq: number): void {
    if (this.osc && this.ctx) {
      this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.02);
    }
  }

  /** Copies the latest time-domain samples into buf. Returns false if stopped. */
  readInto(buf: Float32Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false;
    this.analyser.getFloatTimeDomainData(buf);
    return true;
  }

  async stop(): Promise<void> {
    this.osc?.stop();
    this.osc = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.analyser = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close();
    }
  }
}
