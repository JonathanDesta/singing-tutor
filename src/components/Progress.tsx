import { useEffect, useState } from "react";
import { listSessions, type Profile, type SessionRec } from "../lib/db";
import { midiToName } from "../lib/notes";

type Props = { profile: Profile | null };

export function Progress({ profile }: Props) {
  const [sessions, setSessions] = useState<SessionRec[] | null>(null);

  useEffect(() => {
    const load = () =>
      listSessions()
        .then((s) => setSessions(s.reverse()))
        .catch(() => setSessions([]));
    load();
    window.addEventListener("data-synced", load);
    return () => window.removeEventListener("data-synced", load);
  }, []);

  const bests = new Map<string, number>();
  for (const s of sessions ?? []) {
    bests.set(s.exerciseName, Math.max(bests.get(s.exerciseName) ?? 0, s.score));
  }

  return (
    <div className="progress">
      <div className="banner">
        <span>
          {profile ? (
            <>
              Range: <strong>{midiToName(profile.rangeMin)}–{midiToName(profile.rangeMax)}</strong>
            </>
          ) : (
            "No vocal range saved yet — detect it from the Practice tab."
          )}
        </span>
      </div>

      {sessions === null ? (
        <p className="muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">
          No sessions yet. Run an exercise from the Practice tab and your
          scores will collect here.
        </p>
      ) : (
        <>
          <h2>Personal bests</h2>
          <table className="stbl">
            <tbody>
              {[...bests.entries()].map(([name, score]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>
                    <strong>{score}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>History</h2>
          <table className="stbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Exercise</th>
                <th>Root</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={i}>
                  <td>
                    {new Date(s.date).toLocaleDateString()}{" "}
                    {new Date(s.date).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>{s.exerciseName}</td>
                  <td>{midiToName(s.rootMidi)}</td>
                  <td>{s.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
