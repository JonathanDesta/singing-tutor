import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioEngine, SourceKind } from "../audio/engine";
import { pickRoot, type Range } from "../lib/exercises";
import { SONGS, songPhraseExercise, type Song } from "../lib/songs";
import { parseMidiFile, songFromMidi } from "../lib/midi";
import { getKV, setKV, type Profile } from "../lib/db";
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
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () =>
      getKV<Song[]>("customSongs").then((s) => s && setCustomSongs(s));
    load();
    window.addEventListener("data-synced", load);
    return () => window.removeEventListener("data-synced", load);
  }, []);

  async function importMidi(file: File) {
    setImportError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseMidiFile(bytes);
      const newSong = songFromMidi(parsed, file.name.replace(/\.midi?$/i, ""));
      const next = [...customSongs, newSong];
      setCustomSongs(next);
      await setKV("customSongs", next);
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
  }

  const range: Range | null = profile
    ? { min: profile.rangeMin, max: profile.rangeMax }
    : null;

  if (song) {
    const ex = songPhraseExercise(song, phrase);
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
        </div>
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

      {importError && <div className="error">{importError}</div>}

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
