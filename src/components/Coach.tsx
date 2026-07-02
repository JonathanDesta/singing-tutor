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
  currentProgramWeek,
  offlinePlan,
  offlineFeedback,
  requestPlan,
  requestFeedback,
  requestChat,
  type ChatMessage,
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
  const [busy, setBusy] = useState<"plan" | "feedback" | "chat" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

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
      getKV<ChatMessage[]>("coach-chat").then((c) => c && setChat(c));
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
      const recentFeedback = (await getKV<string[]>("coach-log")) ?? [];
      p = await requestPlan(text, summary, {
        previousProgram: program?.source === "claude" ? program : null,
        currentWeek:
          program && program.source === "claude" ? currentProgramWeek(program) : null,
        recentFeedback,
      });
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
      const log = (await getKV<string[]>("coach-log")) ?? [];
      f = await requestFeedback(goal?.text ?? null, program, last, summary, log);
      const entry = `${f.date.slice(0, 10)}: ${f.text.slice(0, 600)}`;
      setKV("coach-log", [...log, entry].slice(-5)).catch(() => {});
    } catch {
      f = offlineFeedback(last, summary);
    }
    setFeedback(f);
    setKV("last-feedback", f).catch(() => {});
    setBusy(null);
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || busy !== null) return;
    const next: ChatMessage[] = [...chat, { role: "user", content: text }];
    setChat(next);
    setChatInput("");
    setBusy("chat");
    try {
      const summary = buildSingerSummary(sessions, profile);
      const last = sessions.length > 0 ? sessions[sessions.length - 1] : null;
      const reply = await requestChat(
        { goal: goal?.text ?? null, program, summary, lastSession: last },
        next.slice(-20),
      );
      const withReply: ChatMessage[] = [
        ...next,
        { role: "assistant" as const, content: reply },
      ].slice(-30);
      setChat(withReply);
      setKV("coach-chat", withReply).catch(() => {});
    } catch {
      setChat([
        ...next,
        {
          role: "assistant" as const,
          content:
            "(offline) Chat needs the AI coach backend — I can't reach it from here right now.",
        },
      ]);
    }
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
          <div className="row-btns">
            <div className={`feas feas-${program.feasibility}`}>
              {FEAS_LABEL[program.feasibility]}
              {program.source === "offline" && " · offline coach"}
            </div>
            {program.source === "claude" && (
              <span className="chip">
                Week {currentProgramWeek(program)} of {program.weeks.length}
              </span>
            )}
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
          {program.customDrills && program.customDrills.length > 0 && (
            <p className="muted">
              The coach composed {program.customDrills.length} custom drill
              {program.customDrills.length > 1 ? "s" : ""} for you — find them
              under "From your coach" in the Practice tab.
            </p>
          )}
          {program.songSuggestions && program.songSuggestions.length > 0 && (
            <div>
              <h3>Songs to import (find these as MIDI files)</h3>
              <ul className="suggestions">
                {program.songSuggestions.map((s, i) => (
                  <li key={i}>
                    <strong>
                      {s.title} — {s.artist}
                    </strong>
                    : {s.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="chatpanel">
        <h2>Ask your coach</h2>
        {chat.length === 0 && (
          <p className="muted">
            Push back, ask why, request changes — the coach sees your goal,
            program, and practice data.
          </p>
        )}
        <div className="chatlog">
          {chat.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content.split("\n\n").map((para, j) => (
                <p key={j}>{para}</p>
              ))}
            </div>
          ))}
          {busy === "chat" && <div className="msg assistant muted">thinking…</div>}
        </div>
        <div className="chatrow">
          <textarea
            rows={2}
            value={chatInput}
            placeholder='e.g. "Why so many sirens in week 1?" or "I only have 5 minutes today — what matters most?"'
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChat();
              }
            }}
          />
          <button
            className="primary"
            disabled={busy !== null || chatInput.trim() === ""}
            onClick={sendChat}
          >
            Send
          </button>
        </div>
      </div>

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
