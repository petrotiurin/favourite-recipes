// Answers that need no model (docs/chatbot-design.md 7.1 Finalise): "Not yet" to "Next week has N recipes. Is it ready to become this week?"
// means nothing is staged, Finalise stops and the tray goes back to collecting. A model that is asked to work that out can loop for a minute
// (it did), so the server does it: deterministic, instant, no spend.

const PROMOTE_QUESTION = /ready to become this week/i;
const NOT_YET = /^\s*(not yet|not now|no|nope|no thanks|no thank you|not yet please|wait|later|hold on|not ready)\s*[.!]?\s*$/i;

export const isNotYet = (text) => NOT_YET.test(String(text || ""));

/** Is the newest thing in the (stored) history an unanswered promote question from ask_user? */
export function promoteQuestionOpen(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "tool") continue; // its result
    if (m.role !== "assistant") return false; // the user spoke after it
    return (m.tool_calls || []).some((c) => {
      if (c.function?.name !== "ask_user") return false;
      try {
        return PROMOTE_QUESTION.test(JSON.parse(c.function.arguments).question || "");
      } catch {
        return false;
      }
    });
  }
  return false;
}

export const NOT_YET_REPLY = "OK, next week stays as it is and nothing changes. Finalise again when you're ready.";
