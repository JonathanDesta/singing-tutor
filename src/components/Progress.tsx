import { useEffect, useState } from "react";
import {
  clearAllData,
  listSessions,
  type Profile,
  type SessionRec,
} from "../lib/db";
import { clearCloudData, isSignedIn } from "../lib/sync";
import { midiToName } from "../lib/notes";

type Props = { profile: Profile | null };

export function Progress({ profile }: Props) {
  const [sessions, setSessions] = useState<SessionRec[] | null>(null);
  const [resetting, setResetting] = useState(false);

  async function resetAll() {
    const scope = isSignedIn()
      ? "on this device AND in your synced cloud account"
      : "on this device";
    const ok = window.confirm(
      `Delete ALL app data ${scope}?\n\nSessions, vocal range, goal, program, coaching history — everything. This cannot be undone.`,
    );
    if (!ok) return;
    setResetting(true);
    try {
      await clearCloudData();
    } catch {
      const proceed = window.confirm(
        "Couldn't clear the cloud copy (offline or permission issue). " +
          "Reset local data anyway? Note: it may re-sync back from the cloud on your next sign-in.",
      );
      if (!proceed) {
        setResetting(false);
        return;
      }
    }
    await clearAllData();
    window.location.reload();
  }

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

      <div className="danger">
        <button
          className="secondary danger-btn"
          disabled={resetting}
          onClick={resetAll}
        >
          {resetting ? "Resetting…" : "Reset all data"}
        </button>
        <span className="muted">
          Deletes sessions, range, goal, and program — from this device and
          your synced account.
        </span>
      </div>
    </div>
  );
}
