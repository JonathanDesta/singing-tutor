import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { pickRoot, type Range } from "../lib/exercises";
import { SONGS, songPhraseExercise, type Song } from "../lib/songs";
import { parseMidiFile, songFromMidi, type ParsedMidi } from "../lib/midi";
import { getKV, setKV, type Profile } from "../lib/db";
import { requestSongStyle, type SongStyle } from "../lib/coach";
import { ExerciseRunner } from "./ExerciseRunner";

type Props = {
  engineRef: MutableRefObject<AudioEngine | null>;
  source: SourceKind;
  toneMidi: number;
  profile: Profile | null;
};

export function Songs({ engineRef, source, toneMidi, profile }: Props) {
  const [song, setSong] = useState<Song | null>(null);
  const [phrase, setPhrase] = useState(0);
  const [customSongs, setCustomSongs] = useState<Song[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { name: string; downloadUrl: string; views: number }[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [styles, setStyles] = useState<Record<string, SongStyle>>({});
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{
    parsed: ParsedMidi;
    title: string;
    songId: string;
    voiceIdx: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => {
      getKV<Song[]>("customSongs").then((s) => s && setCustomSongs(s));
      getKV<Record<string, SongStyle>>("songStyles").then(
        (s) => s && setStyles(s),
      );
    };
    load();
    window.addEventListener("data-synced", load);
    return () => window.removeEventListener("data-synced", load);
  }, []);

  async function fetchStyle(s: Song) {
    if (styleBusy) return;
    setStyleBusy(true);
    setStyleError(null);
    try {
      const style = await requestSongStyle(s);
      const next = { ...styles, [s.id]: style };
      setStyles(next);
      setKV("songStyles", next).catch(() => {});
    } catch {
      setStyleError(
        "Style analysis needs the AI coach backend — use the Vercel URL while online.",
      );
    }
    setStyleBusy(false);
  }

  async function saveSong(newSong: Song) {
    const next = [...customSongs, newSong];
    setCustomSongs(next);
    await setKV("customSongs", next);
  }

  async function finishImport(parsed: ParsedMidi, title: string) {
    const newSong = songFromMidi(parsed, title);
    await saveSong(newSong);
    setLastImport({ parsed, title, songId: newSong.id, voiceIdx: 0 });
  }

  /** The melody-track picker is a heuristic; let the user cycle candidates. */
  async function tryAnotherTrack() {
    if (!lastImport) return;
    const count = lastImport.parsed.voices.length;
    const voiceIdx = (lastImport.voiceIdx + 1) % count;
    const rebuilt: Song = {
      ...songFromMidi(lastImport.parsed, lastImport.title, voiceIdx),
      id: lastImport.songId,
    };
    const next = customSongs.map((s) => (s.id === lastImport.songId ? rebuilt : s));
    setCustomSongs(next);
    setKV("customSongs", next).catch(() => {});
    setLastImport({ ...lastImport, voiceIdx });
  }

  // BitMidi allows direct browser access (CORS *); its bot protection blocks
  // requests from server/datacenter IPs, so direct-from-browser is the
  // primary path and our Vercel proxy is only a fallback.
  async function searchSongs() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setImportError(null);
    setResults(null);
    try {
      let results: { name: string; downloadUrl: string; views: number }[];
      try {
        const r = await fetch(
          `https://bitmidi.com/api/midi/search?q=${encodeURIComponent(q)}&page=0`,
        );
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        results = (data?.result?.results ?? [])
          .filter((m: { name?: string; downloadUrl?: string }) => m.name && m.downloadUrl)
          .slice(0, 12)
          .map((m: { name: string; downloadUrl: string; views?: number }) => ({
            name: m.name,
            downloadUrl: m.downloadUrl,
            views: m.views ?? 0,
          }));
      } catch {
        const r = await fetch(`/api/midi?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(String(r.status));
        results = (await r.json()).results ?? [];
      }
      setResults(results);
    } catch {
      setImportError(
        "Song search needs an internet connection — or import a .mid file directly.",
      );
    }
    setSearching(false);
  }

  async function importFromWeb(m: { name: string; downloadUrl: string }) {
    if (importing) return;
    setImporting(m.downloadUrl);
    setImportError(null);
    try {
      let r = await fetch(`https://bitmidi.com${m.downloadUrl}`).catch(() => null);
      if (!r || !r.ok) {
        r = await fetch(`/api/midi?file=${encodeURIComponent(m.downloadUrl)}`);
      }
      if (!r.ok) throw new Error(String(r.status));
      const bytes = new Uint8Array(await r.arrayBuffer());
      const parsed = parseMidiFile(bytes);
      const title = m.name.replace(/\.midi?$/i, "");
      await finishImport({ ...parsed, name: title }, title);
      setResults(null);
      setQuery("");
    } catch (e) {
      setImportError(
        `Couldn't import "${m.name}": ${e instanceof Error ? e.message : e}`,
      );
    }
    setImporting(null);
  }

  async function importMidi(file: File) {
    setImportError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseMidiFile(bytes);
      await finishImport(parsed, file.name.replace(/\.midi?$/i, ""));
    } catch (e) {
      setImportError(
        `Couldn't import that file: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  function removeSong(id: string) {
    const next = customSongs.filter((s) => s.id !== id);
    setCustomSongs(next);
    setKV("customSongs", next).catch(() => {});
    if (lastImport?.songId === id) setLastImport(null);
  }

  const range: Range | null = profile
    ? { min: profile.rangeMin, max: profile.rangeMax }
    : null;

  if (song) {
    const ex = songPhraseExercise(song, phrase);
    const style = styles[song.id];
    return (
      <div className="songmode">
        <div className="songnav">
          <button
            className="secondary"
            disabled={phrase === 0}
            onClick={() => setPhrase((p) => p - 1)}
          >
            ← Prev
          </button>
          <span className="muted">
            Phrase {phrase + 1} of {song.phrases.length}
          </span>
          <button
            className="secondary"
            disabled={phrase === song.phrases.length - 1}
            onClick={() => setPhrase((p) => p + 1)}
          >
            Next →
          </button>
          {!style && (
            <button
              className="secondary"
              disabled={styleBusy}
              onClick={() => fetchStyle(song)}
            >
              {styleBusy ? "Analyzing song…" : "Get style targets (AI)"}
            </button>
          )}
        </div>
        {styleError && <div className="error">{styleError}</div>}
        {style && <p className="muted styleoverall">{style.overall}</p>}
        <div className="lyric">“{song.phrases[phrase].lyric}”</div>
        <ExerciseRunner
          key={ex.id}
          exercise={ex}
          rootMidi={pickRoot(ex, range)}
          engineRef={engineRef}
          source={source}
          toneMidi={toneMidi}
          onExit={() => {
            setSong(null);
            setPhrase(0);
          }}
          backLabel="← Songs"
          styleTarget={style?.phrases[phrase] ?? null}
        />
      </div>
    );
  }

  return (
    <>
      <div className="banner">
        <span>
          Sing real melodies phrase by phrase — same scoring and analysis as
          exercises, transposed to your range. Import a .mid file of any song
          (the coach can suggest which); the melody line is extracted
          automatically.
        </span>
        <button className="primary" onClick={() => fileRef.current?.click()}>
          Import MIDI
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".mid,.midi"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importMidi(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="searchrow">
        <input
          type="text"
          value={query}
          placeholder='Search songs online, e.g. "take on me"'
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

      {importError && <div className="error">{importError}</div>}

      {lastImport && (
        <div className="banner">
          <span>
            Imported <strong>{lastImport.title}</strong> using track "
            {lastImport.parsed.voices[lastImport.voiceIdx]?.label}". Practice a
            phrase — if the melody is wrong, another track of the file may hold
            it.
          </span>
          {lastImport.parsed.voices.length > 1 && (
            <button className="secondary" onClick={tryAnotherTrack}>
              Try another track ({lastImport.voiceIdx + 1}/
              {lastImport.parsed.voices.length})
            </button>
          )}
        </div>
      )}

      {results !== null && (
        <div className="searchresults">
          {results.length === 0 && (
            <p className="muted">No results — try fewer or different words.</p>
          )}
          {results.map((m) => (
            <div className="searchresult" key={m.downloadUrl}>
              <span className="name">{m.name}</span>
              <span className="muted">{m.views.toLocaleString()} views</span>
              <button
                className="primary"
                disabled={importing !== null}
                onClick={() => importFromWeb(m)}
              >
                {importing === m.downloadUrl ? "Importing…" : "Import"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cards">
        {[...customSongs, ...SONGS].map((s) => (
          <div className="card" key={s.id}>
            <h3>{s.title}</h3>
            <p>{s.attribution}</p>
            <div className="meta">{s.phrases.length} phrases</div>
            <div className="row-btns">
              <button
                className="primary"
                onClick={() => {
                  setSong(s);
                  setPhrase(0);
                }}
              >
                Practice
              </button>
              {s.attribution === "Imported MIDI" && (
                <button className="secondary" onClick={() => removeSong(s.id)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
