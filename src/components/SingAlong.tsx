import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { usePitchLoop } from "../audio/usePitchLoop";
import { PitchTrace, type TracePoint } from "./PitchTrace";
import { midiToFreq, midiToName } from "../lib/notes";
import { searchITunes, fetchPreviewAudio, type ITunesTrack } from "../lib/itunes";
import { classifyTimbre, type TimbreClass, type TimbreFrame } from "../lib/timbre";
import { requestClipStyle, timbreMatches, type ClipStyle } from "../lib/coach";
import { getKV, setKV, type Profile } from "../lib/db";

const TRACE_RETENTION_MS = 10000;

type Phase = "pick" | "loading" | "singing" | "done";

type Summary = {
  voicedPct: number;
  minMidi: number | null;
  maxMidi: number | null;
  medianMidi: number | null;
  timbre: TimbreClass | null;
};

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  profile: Profile | null;
};

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
  const [styles, setStyles] = useState<Record<string, ClipStyle>>({});
  const [styleBusy, setStyleBusy] = useState(false);
  const [center, setCenter] = useState(
    profile ? Math.round((profile.rangeMin + profile.rangeMax) / 2) : 60,
  );

  const pointsRef = useRef<TracePoint[]>([]);
  const framesRef = useRef<{
    midis: number[];
    timbres: TimbreFrame[];
    voiced: number;
    total: number;
  }>({ midis: [], timbres: [], voiced: 0, total: 0 });
  const audioDataRef = useRef<ArrayBuffer | null>(null);
  const lastUiRef = useRef(0);
  const lastRecenterRef = useRef(0);

  useEffect(() => {
    const load = () =>
      getKV<Record<string, ClipStyle>>("clipStyles").then(
        (s) => s && setStyles(s),
      );
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

  usePitchLoop(engineRef, phase === "singing", (f) => {
    const pts = pointsRef.current;
    pts.push({ t: f.now, midi: f.midi });
    while (pts.length > 0 && pts[0].t < f.now - TRACE_RETENTION_MS) pts.shift();

    const fr = framesRef.current;
    fr.total++;
    if (f.midi !== null) {
      fr.voiced++;
      fr.midis.push(f.midi);
      if (f.timbre) fr.timbres.push(f.timbre);
    }

    // UI updates ride the audio-driven callback (timers/rAF stall on hidden
    // pages, the audio thread does not)
    if (f.now - lastUiRef.current > 150) {
      lastUiRef.current = f.now;
      const engine = engineRef.current;
      const pos = engine?.clipPosition();
      const dur = engine?.clipDuration;
      if (pos !== null && pos !== undefined && dur) {
        setProgress(Math.min(1, pos / dur));
      }
      setReading(
        f.midi !== null && f.freq !== null
          ? { midi: f.midi, freq: f.freq }
          : null,
      );
      // recenter the trace when the singer drifts out of view
      const recent = fr.midis.slice(-40);
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
      .then((style) => {
        setStyles((prev) => {
          const next = { ...prev, [key]: style };
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
    setSummary(null);
    setError(null);
    ensureStyle(t);
  }

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
      await engine.loadClip(audioDataRef.current.slice(0));
      pointsRef.current = [];
      framesRef.current = { midis: [], timbres: [], voiced: 0, total: 0 };
      setProgress(0);
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
    const fr = framesRef.current;
    const sorted = [...fr.midis].sort((a, b) => a - b);
    const medianMidi = sorted.length ? sorted[sorted.length >> 1] : null;
    setSummary({
      voicedPct: fr.total ? Math.round((fr.voiced / fr.total) * 100) : 0,
      minMidi: sorted.length ? sorted[0] : null,
      maxMidi: sorted.length ? sorted[sorted.length - 1] : null,
      medianMidi,
      timbre: classifyTimbre(fr.timbres, medianMidi ?? undefined),
    });
    setPhase("done");
    setReading(null);
    engineRef.current?.stop();
  }

  const style = track ? styles[String(track.trackId)] : undefined;

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
            </p>
          </div>
        </div>

        {phase === "loading" && <p className="muted">Loading the recording…</p>}

        {phase === "singing" && (
          <>
            <div className="progressbar">
              <div style={{ width: `${progress * 100}%` }} />
            </div>
            <PitchTrace pointsRef={pointsRef} targetMidi={center} freeMode />
            <div className="readout">
              {reading && centsVsNearest !== null ? (
                <>
                  <div className="note">{midiToName(reading.midi)}</div>
                  <div className="detail">
                    {reading.freq.toFixed(1)} Hz ·{" "}
                    {centsVsNearest >= 0 ? "+" : ""}
                    {centsVsNearest.toFixed(0)}¢ of{" "}
                    {midiToName(reading.midi)}
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
            <h3>Clip results</h3>
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
            <div className="row-btns">
              <button className="primary" onClick={startSinging}>
                Sing it again
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setTrack(null);
                  setPhase("pick");
                }}
              >
                Choose another song
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
