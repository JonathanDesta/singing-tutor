import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { usePitchLoop } from "../audio/usePitchLoop";
import { PitchTrace, type TracePoint } from "./PitchTrace";
import { ExerciseStage } from "./ExerciseStage";
import { midiToFreq, midiToName } from "../lib/notes";
import { searchITunes, fetchPreviewAudio, type ITunesTrack } from "../lib/itunes";
import { classifyTimbre, type TimbreClass, type TimbreFrame } from "../lib/timbre";
import { requestClipStyle, timbreMatches, type ClipStyle } from "../lib/coach";
import { getKV, setKV, addSession, type Profile } from "../lib/db";
import { parseMidiFile, melodyWithLyrics, type ParsedMidi } from "../lib/midi";
import {
  audioChroma,
  midiChroma,
  alignChroma,
  MIN_SYNC_SCORE,
  CHROMA_SAMPLE_RATE,
  type NoteSec,
} from "../lib/chroma";
import type { TimedTarget } from "../lib/exercises";
import {
  scoreSegments,
  applyVibratoAllowance,
  overallScore,
  type SegmentScore,
} from "../lib/scoring";
import {
  analyzeSegments,
  describeAnalysis,
  type AFrame,
  type SegmentAnalysis,
} from "../lib/analysis";

const TRACE_RETENTION_MS = 10000;

type Phase = "pick" | "loading" | "singing" | "done";

type MelodyTarget = { t0: number; t1: number; midi: number; syl?: string };

/** Aligned melody for one preview clip, cached per track in kv. */
type ClipMelody = {
  midiName: string;
  voiceLabel: string;
  voiceIdx: number;
  offsetSec: number;
  scale: number;
  syncScore: number;
  targets: MelodyTarget[]; // ms on the clip timeline
};

type Summary = {
  voicedPct: number;
  minMidi: number | null;
  maxMidi: number | null;
  medianMidi: number | null;
  timbre: TimbreClass | null;
};

type MelodyResults = {
  scores: SegmentScore[];
  analyses: SegmentAnalysis[];
  targets: TimedTarget[];
  overall: number;
  octaveShift: number;
};

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  profile: Profile | null;
};

function targetMidiAt(targets: MelodyTarget[], tMs: number): number | null {
  for (const tg of targets) {
    if (tMs >= tg.t0 && tMs <= tg.t1) return tg.midi;
  }
  return null;
}

/** Median of (sung − target) rounded to the nearest octave: singers follow
 * the record in their own register, so only 12-semitone shifts are real. */
function estimateOctaveShift(diffs: number[]): number {
  if (diffs.length < 25) return 0;
  const s = [...diffs].sort((a, b) => a - b);
  const med = s[s.length >> 1];
  return Math.max(-24, Math.min(24, Math.round(med / 12) * 12));
}

export function SingAlong({ engineRef, source, toneMidi, profile }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ITunesTrack[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [track, setTrack] = useState<ITunesTrack | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [reading, setReading] = useState<{ midi: number; freq: number } | null>(
    null,
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [melodyResults, setMelodyResults] = useState<MelodyResults | null>(null);
  const [styles, setStyles] = useState<Record<string, ClipStyle>>({});
  const [styleBusy, setStyleBusy] = useState(false);
  const [center, setCenter] = useState(
    profile ? Math.round((profile.rangeMin + profile.rangeMax) / 2) : 60,
  );
  const [clipDurMs, setClipDurMs] = useState(30000);
  const [octaveShift, setOctaveShift] = useState(0);
  const [lyricIdx, setLyricIdx] = useState(-1);

  // melody attachment
  const [melodies, setMelodies] = useState<Record<string, ClipMelody>>({});
  const [midiPanel, setMidiPanel] = useState(false);
  const [midiQuery, setMidiQuery] = useState("");
  const [midiResults, setMidiResults] = useState<
    { name: string; downloadUrl: string }[] | null
  >(null);
  const [midiSearching, setMidiSearching] = useState(false);
  const [melodyBusy, setMelodyBusy] = useState<string | null>(null);
  const [melodyError, setMelodyError] = useState<string | null>(null);

  const pointsRef = useRef<TracePoint[]>([]);
  const framesRef = useRef<AFrame[]>([]);
  const statsRef = useRef<{
    midis: number[];
    timbres: TimbreFrame[];
    diffs: number[];
    voiced: number;
    total: number;
  }>({ midis: [], timbres: [], diffs: [], voiced: 0, total: 0 });
  const audioDataRef = useRef<ArrayBuffer | null>(null);
  const parsedMidiRef = useRef<{ parsed: ParsedMidi; align: { offsetSec: number; scale: number; score: number }; clipSec: number } | null>(null);
  const lastUiRef = useRef(0);
  const lastRecenterRef = useRef(0);

  useEffect(() => {
    const load = () => {
      getKV<Record<string, ClipStyle>>("clipStyles").then(
        (s) => s && setStyles(s),
      );
      getKV<Record<string, ClipMelody>>("clipMelodies").then(
        (m) => m && setMelodies(m),
      );
    };
    load();
    window.addEventListener("data-synced", load);
    return () => window.removeEventListener("data-synced", load);
  }, []);

  // leaving the component releases the mic and playback
  useEffect(
    () => () => {
      engineRef.current?.stop();
    },
    [engineRef],
  );

  const melody = track ? melodies[String(track.trackId)] : undefined;
  const style = track ? styles[String(track.trackId)] : undefined;

  const shiftedTargets: TimedTarget[] = useMemo(
    () =>
      (melody?.targets ?? []).map((t) => ({
        t0: t.t0,
        t1: t.t1,
        midi0: t.midi + octaveShift,
        midi1: t.midi + octaveShift,
        label: t.syl ?? midiToName(t.midi + octaveShift),
      })),
    [melody, octaveShift],
  );
  const sylTargets = useMemo(
    () => (melody?.targets ?? []).filter((t) => t.syl),
    [melody],
  );

  const getProgressMs = useCallback(() => {
    const p = engineRef.current?.clipPosition();
    return p == null ? null : p * 1000;
  }, [engineRef]);

  usePitchLoop(engineRef, phase === "singing", (f) => {
    const st = statsRef.current;
    st.total++;
    if (f.midi !== null) {
      st.voiced++;
      st.midis.push(f.midi);
      if (f.timbre) st.timbres.push(f.timbre);
    }

    const pos = engineRef.current?.clipPosition();
    if (melody) {
      if (pos != null) {
        framesRef.current.push({
          t: pos * 1000,
          midi: f.midi,
          clarity: f.clarity,
          f1: f.f1,
          f2: f.f2,
          timbre: f.timbre,
        });
        if (f.midi !== null) {
          const target = targetMidiAt(melody.targets, pos * 1000);
          if (target !== null) st.diffs.push(f.midi - target);
        }
      }
    } else {
      const pts = pointsRef.current;
      pts.push({ t: f.now, midi: f.midi });
      while (pts.length > 0 && pts[0].t < f.now - TRACE_RETENTION_MS)
        pts.shift();
    }

    // UI updates ride the audio-driven callback (timers/rAF stall on hidden
    // pages, the audio thread does not)
    if (f.now - lastUiRef.current > 150) {
      lastUiRef.current = f.now;
      const dur = engineRef.current?.clipDuration;
      if (pos != null && dur) setProgress(Math.min(1, pos / dur));
      setReading(
        f.midi !== null && f.freq !== null
          ? { midi: f.midi, freq: f.freq }
          : null,
      );
      if (melody) {
        setOctaveShift(estimateOctaveShift(st.diffs));
        if (pos != null && sylTargets.length > 0) {
          let idx = -1;
          const tMs = pos * 1000 + 150;
          for (let i = 0; i < sylTargets.length; i++) {
            if (sylTargets[i].t0 <= tMs) idx = i;
            else break;
          }
          setLyricIdx(idx);
        }
      } else {
        // recenter the free trace when the singer drifts out of view
        const recent = st.midis.slice(-40);
        if (recent.length >= 10 && f.now - lastRecenterRef.current > 1500) {
          const sorted = [...recent].sort((a, b) => a - b);
          const median = sorted[sorted.length >> 1];
          setCenter((c) => {
            if (Math.abs(median - c) > 4) {
              lastRecenterRef.current = f.now;
              return Math.round(median);
            }
            return c;
          });
        }
      }
    }
  });

  async function searchSongs() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      setResults(await searchITunes(q));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSearching(false);
  }

  function ensureStyle(t: ITunesTrack) {
    const key = String(t.trackId);
    if (styles[key] || styleBusy) return;
    setStyleBusy(true);
    requestClipStyle(t.trackName, t.artistName)
      .then((s) => {
        setStyles((prev) => {
          const next = { ...prev, [key]: s };
          setKV("clipStyles", next).catch(() => {});
          return next;
        });
      })
      .catch(() => {
        // style targets need the AI backend — the mode works fine without
      })
      .finally(() => setStyleBusy(false));
  }

  function pickTrack(t: ITunesTrack) {
    setTrack(t);
    audioDataRef.current = null;
    parsedMidiRef.current = null;
    setSummary(null);
    setMelodyResults(null);
    setError(null);
    setMelodyError(null);
    setMidiPanel(false);
    setMidiResults(null);
    setMidiQuery(`${t.trackName} ${t.artistName}`);
    setOctaveShift(0);
    ensureStyle(t);
  }

  // ---------- melody attachment (MIDI search → chroma alignment) ----------

  async function searchMidi() {
    const q = midiQuery.trim();
    if (!q || midiSearching) return;
    setMidiSearching(true);
    setMelodyError(null);
    setMidiResults(null);
    try {
      let found: { name: string; downloadUrl: string }[];
      try {
        const r = await fetch(
          `https://bitmidi.com/api/midi/search?q=${encodeURIComponent(q)}&page=0`,
        );
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        found = (data?.result?.results ?? [])
          .filter((m: { name?: string; downloadUrl?: string }) => m.name && m.downloadUrl)
          .slice(0, 8)
          .map((m: { name: string; downloadUrl: string }) => ({
            name: m.name,
            downloadUrl: m.downloadUrl,
          }));
      } catch {
        const r = await fetch(`/api/midi?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(String(r.status));
        found = ((await r.json()).results ?? []).map(
          (m: { name: string; downloadUrl: string }) => ({
            name: m.name,
            downloadUrl: m.downloadUrl,
          }),
        );
      }
      setMidiResults(found);
      if (found.length === 0)
        setMelodyError("No MIDI found — try fewer or different words.");
    } catch {
      setMelodyError("MIDI search needs an internet connection.");
    }
    setMidiSearching(false);
  }

  /** Full pipeline: fetch clip + MIDI, decode, chroma-align, build targets. */
  async function attachMelody(m: { name: string; downloadUrl: string }) {
    if (!track || melodyBusy) return;
    setMelodyError(null);
    try {
      setMelodyBusy("Fetching the recording…");
      if (!audioDataRef.current) {
        audioDataRef.current = await fetchPreviewAudio(track.previewUrl);
      }
      setMelodyBusy("Decoding…");
      const octx = new OfflineAudioContext({
        numberOfChannels: 1,
        length: 1,
        sampleRate: CHROMA_SAMPLE_RATE,
      });
      const decoded = await octx.decodeAudioData(audioDataRef.current.slice(0));
      const mono = new Float32Array(decoded.length);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const d = decoded.getChannelData(ch);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / decoded.numberOfChannels;
      }

      setMelodyBusy("Fetching MIDI…");
      let r = await fetch(`https://bitmidi.com${m.downloadUrl}`).catch(() => null);
      if (!r || !r.ok) {
        r = await fetch(`/api/midi?file=${encodeURIComponent(m.downloadUrl)}`);
      }
      if (!r.ok) throw new Error(`MIDI fetch: ${r.status}`);
      const parsed = parseMidiFile(new Uint8Array(await r.arrayBuffer()));

      setMelodyBusy("Aligning to the recording…");
      const secPerBeat = 60 / parsed.bpm;
      const allNotes: NoteSec[] = parsed.voices.flatMap((v) =>
        v.notes.map((n) => ({
          midi: n.midi,
          start: n.start * secPerBeat,
          dur: n.dur * secPerBeat,
        })),
      );
      const songSec = Math.max(...allNotes.map((n) => n.start + n.dur)) + 1;
      const align = alignChroma(
        audioChroma(mono, CHROMA_SAMPLE_RATE),
        midiChroma(allNotes, songSec, 2048 / CHROMA_SAMPLE_RATE),
      );
      if (align.score < MIN_SYNC_SCORE) {
        setMelodyError(
          `Couldn't line "${m.name}" up with this recording (match ${align.score.toFixed(2)}). It's probably a different arrangement — try another file.`,
        );
        setMelodyBusy(null);
        return;
      }
      parsedMidiRef.current = { parsed, align, clipSec: decoded.duration };
      saveMelody(m.name, 0);
      setMidiPanel(false);
      setMidiResults(null);
    } catch (e) {
      setMelodyError(
        `Couldn't attach melody: ${e instanceof Error ? e.message : e}`,
      );
    }
    setMelodyBusy(null);
  }

  /** Builds clip-time targets from the chosen voice and stores the melody. */
  function saveMelody(midiName: string, voiceIdx: number) {
    const ctx = parsedMidiRef.current;
    if (!track || !ctx) return;
    const { parsed, align, clipSec } = ctx;
    const secPerBeat = 60 / parsed.bpm;
    const notes = melodyWithLyrics(parsed, voiceIdx);
    const targets: MelodyTarget[] = [];
    for (const n of notes) {
      const t0 = ((n.start * secPerBeat - align.offsetSec) / align.scale) * 1000;
      const t1 =
        (((n.start + n.dur) * secPerBeat - align.offsetSec) / align.scale) * 1000;
      if (t1 < 150 || t0 > clipSec * 1000 - 150) continue;
      if (t1 - t0 < 100) continue;
      const tg: MelodyTarget = {
        t0: Math.max(0, Math.round(t0)),
        t1: Math.min(Math.round(clipSec * 1000), Math.round(t1)),
        midi: n.midi,
      };
      if (n.syl) tg.syl = n.syl; // no undefined keys (Firestore rejects them)
      targets.push(tg);
    }
    if (targets.length < 4) {
      setMelodyError(
        "This track has almost no melody inside the preview window — try another track of the file.",
      );
      return;
    }
    const rec: ClipMelody = {
      midiName,
      voiceLabel: parsed.voices[voiceIdx]?.label ?? `Track ${voiceIdx + 1}`,
      voiceIdx,
      offsetSec: align.offsetSec,
      scale: align.scale,
      syncScore: align.score,
      targets,
    };
    setMelodies((prev) => {
      const next = { ...prev, [String(track.trackId)]: rec };
      setKV("clipMelodies", next).catch(() => {});
      return next;
    });
    setMelodyError(null);
  }

  function tryAnotherVoice() {
    const ctx = parsedMidiRef.current;
    if (!melody || !ctx) return;
    saveMelody(
      melody.midiName,
      (melody.voiceIdx + 1) % ctx.parsed.voices.length,
    );
  }

  function removeMelody() {
    if (!track) return;
    setMelodies((prev) => {
      const next = { ...prev };
      delete next[String(track.trackId)];
      setKV("clipMelodies", next).catch(() => {});
      return next;
    });
  }

  // ---------- run ----------

  async function startSinging() {
    if (!track) return;
    setPhase("loading");
    setError(null);
    try {
      const engine = engineRef.current;
      if (!engine) throw new Error("audio engine unavailable");
      await engine.start(source, midiToFreq(toneMidi));
      if (!audioDataRef.current) {
        audioDataRef.current = await fetchPreviewAudio(track.previewUrl);
      }
      // decode detaches the buffer — hand the engine a copy so replays work
      const dur = await engine.loadClip(audioDataRef.current.slice(0));
      setClipDurMs(Math.round(dur * 1000));
      pointsRef.current = [];
      framesRef.current = [];
      statsRef.current = { midis: [], timbres: [], diffs: [], voiced: 0, total: 0 };
      setProgress(0);
      setOctaveShift(0);
      setLyricIdx(-1);
      setSummary(null);
      setMelodyResults(null);
      setPhase("singing");
      engine.playClip(() => finish());
    } catch (e) {
      engineRef.current?.stop();
      setPhase("pick");
      setError(
        source === "mic" && e instanceof DOMException
          ? "Microphone access failed. Check browser permissions and try again."
          : `Couldn't start: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  function finish() {
    const st = statsRef.current;
    const sorted = [...st.midis].sort((a, b) => a - b);
    const medianMidi = sorted.length ? sorted[sorted.length >> 1] : null;
    setSummary({
      voicedPct: st.total ? Math.round((st.voiced / st.total) * 100) : 0,
      minMidi: sorted.length ? sorted[0] : null,
      maxMidi: sorted.length ? sorted[sorted.length - 1] : null,
      medianMidi,
      timbre: classifyTimbre(st.timbres, medianMidi ?? undefined),
    });

    if (melody && track) {
      const shift = estimateOctaveShift(st.diffs);
      const targets: TimedTarget[] = melody.targets.map((t) => ({
        t0: t.t0,
        t1: t.t1,
        midi0: t.midi + shift,
        midi1: t.midi + shift,
        label: t.syl ?? midiToName(t.midi + shift),
      }));
      const frames = framesRef.current;
      const analyses = analyzeSegments(targets, frames);
      const scores = applyVibratoAllowance(
        scoreSegments(targets, frames),
        analyses,
        targets,
        frames,
      );
      const overall = overallScore(scores);
      setMelodyResults({ scores, analyses, targets, overall, octaveShift: shift });
      addSession({
        date: new Date().toISOString(),
        exerciseId: `singalong-${track.trackId}`,
        exerciseName: `Sing along: ${track.trackName} — ${track.artistName}`,
        rootMidi: 60 + shift,
        score: overall,
        segments: scores.map((s, i) => ({
          label: s.label,
          score: s.score,
          avgCents: s.avgCents,
          analysis: analyses[i] ?? null,
        })),
      }).catch(() => {
        // storage failure shouldn't break the results view
      });
    }

    setPhase("done");
    setReading(null);
    engineRef.current?.stop();
  }

  // ---------- singing / results screen ----------
  if (track && phase !== "pick") {
    const centsVsNearest = reading
      ? (reading.midi - Math.round(reading.midi)) * 100
      : null;
    const matches =
      summary?.timbre && style ? timbreMatches(summary.timbre, style.target) : null;
    return (
      <div className="singalong">
        <div className="trackhead">
          {track.artworkUrl100 && (
            <img className="artwork" src={track.artworkUrl100} alt="" />
          )}
          <div>
            <h3>{track.trackName}</h3>
            <p className="muted">
              {track.artistName}
              {track.collectionName ? ` · ${track.collectionName}` : ""}
              {melody && ` · melody: ${melody.midiName}`}
            </p>
          </div>
        </div>

        {phase === "loading" && <p className="muted">Loading the recording…</p>}

        {phase === "singing" && (
          <>
            <div className="progressbar">
              <div style={{ width: `${progress * 100}%` }} />
            </div>
            {melody && sylTargets.length > 0 && (
              <div className="karaoke">
                {sylTargets
                  .slice(Math.max(0, lyricIdx), lyricIdx + 6)
                  .map((t, i) => (
                    <span key={t.t0} className={i === 0 && lyricIdx >= 0 ? "now" : ""}>
                      {t.syl}
                    </span>
                  ))}
              </div>
            )}
            {melody ? (
              <ExerciseStage
                targets={shiftedTargets}
                totalMs={clipDurMs}
                framesRef={framesRef}
                getProgressMs={getProgressMs}
              />
            ) : (
              <PitchTrace pointsRef={pointsRef} targetMidi={center} freeMode />
            )}
            <div className="readout">
              {reading && centsVsNearest !== null ? (
                <>
                  <div className="note">{midiToName(reading.midi)}</div>
                  <div className="detail">
                    {reading.freq.toFixed(1)} Hz ·{" "}
                    {centsVsNearest >= 0 ? "+" : ""}
                    {centsVsNearest.toFixed(0)}¢ of {midiToName(reading.midi)}
                    {octaveShift !== 0 &&
                      ` · singing ${octaveShift > 0 ? "up" : "down"} ${Math.abs(octaveShift) / 12} octave${Math.abs(octaveShift) > 12 ? "s" : ""}`}
                  </div>
                </>
              ) : (
                <div className="idle">Listening…</div>
              )}
            </div>
            <button className="secondary" onClick={() => finish()}>
              Stop early
            </button>
          </>
        )}

        {phase === "done" && summary && (
          <div className="clipsummary">
            {melodyResults ? (
              <>
                <div className="bigscore">{melodyResults.overall}</div>
                {melodyResults.octaveShift !== 0 && (
                  <p className="muted">
                    Scored in your register:{" "}
                    {Math.abs(melodyResults.octaveShift) / 12} octave
                    {Math.abs(melodyResults.octaveShift) > 12 ? "s" : ""}{" "}
                    {melodyResults.octaveShift > 0 ? "above" : "below"} the
                    record.
                  </p>
                )}
                <table className="stbl">
                  <tbody>
                    {melodyResults.scores.map((s, i) => (
                      <tr key={i}>
                        <td>{s.label}</td>
                        <td>{midiToName(melodyResults.targets[i].midi0)}</td>
                        <td>{Math.round(s.score * 100)}%</td>
                        <td>
                          {s.avgCents === null
                            ? "not sung"
                            : Math.abs(s.avgCents) <= 10
                              ? "in tune"
                              : s.avgCents > 0
                                ? `${s.avgCents.toFixed(0)}¢ sharp`
                                : `${Math.abs(s.avgCents).toFixed(0)}¢ flat`}
                        </td>
                        <td className="chips">
                          {describeAnalysis(melodyResults.analyses[i]).map(
                            (chip, j) => (
                              <span className="chip" key={j}>
                                {chip}
                              </span>
                            ),
                          )}
                          {style &&
                            melodyResults.analyses[i]?.timbre &&
                            (timbreMatches(
                              melodyResults.analyses[i].timbre!,
                              style.target,
                            ) ? (
                              <span className="chip chip-good">✓ style</span>
                            ) : (
                              <span className="chip chip-bad">✗ style</span>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <h3>Clip results</h3>
            )}
            <div className="chips">
              <span className="chip">sang {summary.voicedPct}% of the clip</span>
              {summary.minMidi !== null && summary.maxMidi !== null && (
                <span className="chip">
                  range {midiToName(summary.minMidi)}–{midiToName(summary.maxMidi)}
                </span>
              )}
              {summary.timbre && (
                <span className="chip">
                  {summary.timbre.weight} · {summary.timbre.color}
                </span>
              )}
            </div>
            {summary.timbre && style && (
              <p className={matches ? "chip-good" : "chip-bad"}>
                {matches
                  ? `✓ Your production matches the song (${style.target.weight} · ${style.target.color}).`
                  : `✗ This song calls for ${style.target.weight} · ${style.target.color} — you sang ${summary.timbre.weight} · ${summary.timbre.color}.`}
              </p>
            )}
            {summary.timbre && style?.target.notes && (
              <p className="muted">Coach cue: {style.target.notes}</p>
            )}
            {!summary.timbre && (
              <p className="muted">
                Not enough voiced singing to judge timbre — try singing more of
                the clip.
              </p>
            )}
            {style?.overall && <p className="muted styleoverall">{style.overall}</p>}
            {!melody && (
              <p className="muted">
                Want note-by-note scoring with lyrics? Add a melody on the song
                screen.
              </p>
            )}
            <div className="row-btns">
              <button className="primary" onClick={startSinging}>
                Sing it again
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setPhase("pick");
                }}
              >
                Back to song
              </button>
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  // ---------- search / pick screen ----------
  return (
    <>
      <div className="banner">
        <span>
          Sing along with the real recording — search any song and sing over
          the official ~30s preview clip while your pitch and timbre are
          analyzed live. <strong>🎧 Wear headphones:</strong> on speakers the
          recording bleeds into the mic and skews your results.
        </span>
      </div>

      <div className="searchrow">
        <input
          type="text"
          value={query}
          placeholder='Search real songs, e.g. "billie jean"'
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") searchSongs();
          }}
        />
        <button
          className="secondary"
          disabled={searching || query.trim() === ""}
          onClick={searchSongs}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {track && (
        <div className="banner trackpick">
          {track.artworkUrl100 && (
            <img className="artwork" src={track.artworkUrl100} alt="" />
          )}
          <span>
            <strong>{track.trackName}</strong> — {track.artistName}
            {styleBusy && !style && (
              <em className="muted"> · getting style target…</em>
            )}
            {style && <em className="muted"> · style target ready</em>}
          </span>
          <button className="primary" onClick={startSinging}>
            Start singing
          </button>
        </div>
      )}

      {track && (
        <div className="melodybox">
          {melody ? (
            <div className="banner">
              <span>
                ♪ Melody &amp; lyrics ready: <strong>{melody.midiName}</strong>{" "}
                ({melody.voiceLabel}, match{" "}
                {(melody.syncScore * 100).toFixed(0)}%) —{" "}
                {melody.targets.length} notes in the clip. You&apos;ll get
                note-by-note scoring.
              </span>
              {parsedMidiRef.current &&
                parsedMidiRef.current.parsed.voices.length > 1 && (
                  <button className="secondary" onClick={tryAnotherVoice}>
                    Try another track ({melody.voiceIdx + 1}/
                    {parsedMidiRef.current.parsed.voices.length})
                  </button>
                )}
              <button className="secondary" onClick={removeMelody}>
                Remove
              </button>
            </div>
          ) : !midiPanel ? (
            <div className="banner">
              <span>
                Optional: attach a MIDI melody to get note-by-note scoring with
                lyrics, synced to the recording automatically.
              </span>
              <button className="secondary" onClick={() => setMidiPanel(true)}>
                Find melody &amp; lyrics
              </button>
            </div>
          ) : (
            <>
              <div className="searchrow">
                <input
                  type="text"
                  value={midiQuery}
                  onChange={(e) => setMidiQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") searchMidi();
                  }}
                />
                <button
                  className="secondary"
                  disabled={midiSearching || midiQuery.trim() === ""}
                  onClick={searchMidi}
                >
                  {midiSearching ? "Searching…" : "Search MIDI"}
                </button>
              </div>
              {melodyBusy && <p className="muted">{melodyBusy}</p>}
              {midiResults !== null && !melodyBusy && (
                <div className="searchresults">
                  {midiResults.map((m) => (
                    <div className="searchresult" key={m.downloadUrl}>
                      <span className="name">{m.name}</span>
                      <button
                        className="primary"
                        disabled={melodyBusy !== null}
                        onClick={() => attachMelody(m)}
                      >
                        Sync it
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {melodyError && <div className="error">{melodyError}</div>}
        </div>
      )}

      {results !== null && (
        <div className="searchresults">
          {results.length === 0 && (
            <p className="muted">No results — try fewer or different words.</p>
          )}
          {results.map((t) => (
            <div className="searchresult" key={t.trackId}>
              {t.artworkUrl100 && (
                <img className="artwork" src={t.artworkUrl100} alt="" />
              )}
              <span className="name">
                {t.trackName}
                <span className="muted"> — {t.artistName}</span>
              </span>
              <button className="primary" onClick={() => pickTrack(t)}>
                Sing this
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
