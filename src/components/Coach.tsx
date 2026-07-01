import { useEffect, useState } from "react";
import {
  getKV,
  setKV,
  listSessions,
  type Profile,
  type SessionRec,
} from "../lib/db";
import {
  buildSingerSummary,
  offlinePlan,
  offlineFeedback,
  requestPlan,
  requestFeedback,
  type CoachFeedback,
  type CoachProgram,
  type Goal,
} from "../lib/coach";

const FEAS_LABEL: Record<CoachProgram["feasibility"], string> = {
  realistic: "Realistic goal",
  stretch: "Stretch goal",
  unrealistic: "Not realistic",
};

type Props = { profile: Profile | null };

export function Coach({ profile }: Props) {
  const [goalText, setGoalText] = useState("");
  const [goal, setGoal] = useState<Goal | null>(null);
  const [program, setProgram] = useState<CoachProgram | null>(null);
  const [feedback, setFeedback] = useState<CoachFeedback | null>(null);
  const [sessions, setSessions] = useState<SessionRec[]>([]);
  const [busy, setBusy] = useState<"plan" | "feedback" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      getKV<Goal>("goal").then((g) => {
        if (g) {
          setGoal(g);
          setGoalText((cur) => (cur === "" ? g.text : cur));
        }
      });
      getKV<CoachProgram>("program").then((p) => p && setProgram(p));
      getKV<CoachFeedback>("last-feedback").then((f) => f && setFeedback(f));
      listSessions()
        .then(setSessions)
        .catch(() => setSessions([]));
    };
    load();
    window.addEventListener("data-synced", load);
    return () => window.removeEventListener("data-synced", load);
  }, []);

  async function buildProgram() {
    const text = goalText.trim();
    if (!text) return;
    setBusy("plan");
    setNote(null);
    const g: Goal = { text, createdAt: new Date().toISOString() };
    setGoal(g);
    setKV("goal", g).catch(() => {});
    const summary = buildSingerSummary(sessions, profile);
    let p: CoachProgram;
    try {
      p = await requestPlan(text, summary);
    } catch {
      p = offlinePlan(text, summary);
      setNote(
        "AI coach isn't connected yet, so this is the offline coach's generic program. Once the backend is live, rebuild the program for a real, goal-specific analysis.",
      );
    }
    setProgram(p);
    setKV("program", p).catch(() => {});
    setBusy(null);
  }

  async function coachLastSession() {
    setBusy("feedback");
    setNote(null);
    const summary = buildSingerSummary(sessions, profile);
    const last = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    let f: CoachFeedback;
    try {
      f = await requestFeedback(goal?.text ?? null, program, last, summary);
    } catch {
      f = offlineFeedback(last, summary);
    }
    setFeedback(f);
    setKV("last-feedback", f).catch(() => {});
    setBusy(null);
  }

  return (
    <div className="coach">
      <div className="goalbox">
        <label>
          Your goal — in your own words. Be specific: what do you want to be
          able to sing, by when, and why?
        </label>
        <textarea
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
          rows={3}
          placeholder={
            'e.g. "I want to sing the high notes in Take On Me at karaoke by December without my voice cracking"'
          }
        />
        <div className="row-btns">
          <button
            className="primary"
            disabled={busy !== null || goalText.trim() === ""}
            onClick={buildProgram}
          >
            {busy === "plan"
              ? "Coach is thinking…"
              : program
                ? "Rebuild my program"
                : "Assess goal & build program"}
          </button>
          <button
            className="secondary"
            disabled={busy !== null}
            onClick={coachLastSession}
          >
            {busy === "feedback" ? "Reviewing…" : "Coach my recent practice"}
          </button>
        </div>
      </div>

      {note && <div className="banner">{note}</div>}

      {program && (
        <div className="programbox">
          <div className={`feas feas-${program.feasibility}`}>
            {FEAS_LABEL[program.feasibility]}
            {program.source === "offline" && " · offline coach"}
          </div>
          <p className="feas-notes">{program.feasibilityNotes}</p>
          <p>{program.programSummary}</p>
          <div className="weeks">
            {program.weeks.map((w) => (
              <div className="card" key={w.week}>
                <h3>
                  Week {w.week}: {w.focus}
                </h3>
                <ul>
                  {w.drills.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="muted">{program.advice}</p>
        </div>
      )}

      {feedback && (
        <div className="feedbackbox">
          <h2>
            Session coaching
            {feedback.source === "offline" && (
              <span className="muted"> · offline coach</span>
            )}
          </h2>
          {feedback.text.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      )}

      {!program && !feedback && (
        <p className="muted">
          Set a goal above and the coach will judge honestly whether it's
          achievable, then build a week-by-week program from your measured
          range and scores. After practicing, use "Coach my recent practice"
          for specific feedback.
        </p>
      )}
    </div>
  );
}
