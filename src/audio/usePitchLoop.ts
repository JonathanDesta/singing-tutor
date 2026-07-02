import { useEffect, useRef, type MutableRefObject } from "react";
import { PitchDetector } from "pitchy";
import { freqToMidi } from "../lib/notes";
import { estimateFormants } from "../lib/formants";
import { timbreFeatures, type TimbreFrame } from "../lib/timbre";
import { CAPTURE_SIZE, type AudioEngine } from "./engine";

const MIN_CLARITY = 0.9;
const MIN_FREQ = 50;
const MAX_FREQ = 1500;
const MIN_RMS = 0.004; // gate out silence / room noise

export type PitchFrame = {
  now: number; // performance.now() timestamp
  freq: number | null;
  midi: number | null;
  clarity: number;
  f1: number | null; // first formant (voiced frames only)
  f2: number | null; // second formant
  timbre: TimbreFrame | null; // spectral timbre features (voiced frames only)
};

/**
 * Subscribes to the engine's capture stream while `active`, invoking onFrame
 * with every reading (voiced or not). Buffer delivery is driven by the audio
 * thread, so detection keeps working when the page is hidden.
 */
export function usePitchLoop(
  engineRef: MutableRefObject<AudioEngine | null>,
  active: boolean,
  onFrame: (f: PitchFrame) => void,
): void {
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  useEffect(() => {
    if (!active) return;
    const engine = engineRef.current;
    if (!engine) return;
    const detector = PitchDetector.forFloat32Array(CAPTURE_SIZE);

    return engine.subscribe((buf, sampleRate) => {
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);
      const now = performance.now();

      if (rms > MIN_RMS) {
        const [freq, clarity] = detector.findPitch(buf, sampleRate);
        if (clarity >= MIN_CLARITY && freq >= MIN_FREQ && freq <= MAX_FREQ) {
          const { f1, f2 } = estimateFormants(buf, sampleRate);
          const timbre = timbreFeatures(buf, sampleRate, freq);
          cbRef.current({
            now,
            freq,
            midi: freqToMidi(freq),
            clarity,
            f1,
            f2,
            timbre,
          });
          return;
        }
      }
      cbRef.current({
        now,
        freq: null,
        midi: null,
        clarity: 0,
        f1: null,
        f2: null,
        timbre: null,
      });
    });
  }, [active, engineRef]);
}
