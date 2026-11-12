// The follow-up turn (docs/parallel-photo-reading.md 2.5): when the photo report is stored as a note from the site, a turn the SERVER starts hands
// it to the model, which stages the clear recipes and asks about the doubtful ones. There is no user token here, so the caller is rebuilt from the
// conversation's owner, and only while their email is still in EDITORS. That is safe because a chat turn can only stage into the tray: Save still
// needs the editor's fresh token (POST /chat/plan/apply).
//
// Exactly once: whoever claims the conversation's unhandled notes first (claimEvents, atomic) hands them to the model: this follow-up, or the
// user's own next turn. Every turn holds the conversation's turn lock; a follow-up that finds it taken leaves the note for the running turn, which
// starts the follow-up itself when it ends (afterTurn).
import { config } from "./config.js";
import { makeCaller } from "./tools.js";
import { runChat } from "./chat.js";
import { startTrace } from "./langfuse.js";
import { userEmail } from "./auth.js";
import { loadTray, trayNote } from "./tray.js";
import { getEvent, conversationById, takeTurnLock, releaseTurnLock, claimEvents, unhandledEvents, getMessages, appendMessages, historyForModel, withPhotoNotes, photoList, newId } from "./chat-store.js";
import { readsOf, progressNote, startFollowUp } from "./photo-queue.js";

/** How long a turn holds the conversation's lock: past the hard deadline of any turn, so a dead turn's lock expires by itself. */
export const TURN_LOCK_MS = () => config.chatTurnDeadlineMs + 30_000;

/** Runs the follow-up for one note. Resolves { status: "done" | "handled" | "busy" | "gone" | "not-editor" }. Never throws. */
export async function runFollowUp(eventId, { origin } = {}) {
  let convo;
  let token;
  try {
    const ev = await getEvent(eventId);
    if (!ev) return { status: "gone" };
    if (ev.handled_at) return { status: "handled" };
    convo = await conversationById(ev.conversation_id);
    if (!convo) return { status: "gone" };
    const email = await userEmail(convo.user_id);
    if (!email || !config.shoppingEditors.includes(email)) {
      console.warn("No follow-up turn: the conversation's owner isn't an editor (any more); the note stays in the chat");
      return { status: "not-editor" };
    }
    token = `f:${newId()}`;
    if (!(await takeTurnLock(convo.id, token, TURN_LOCK_MS()))) {
      token = null;
      return { status: "busy" }; // the running turn starts us again when it ends
    }
    const claimed = await claimEvents(convo.id);
    if (!claimed.length) return { status: "handled" }; // the user's own turn got there first
    const caller = makeCaller({ role: "editor", email, userId: convo.user_id, ip: "server" });
    const rows = await getMessages(convo.id);
    const photos = photoList(rows);
    const reads = await readsOf(convo.id).catch(() => []);
    // the notes this turn answers go LAST (one may have been stored while another turn was still writing its reply)
    const claimedIds = new Set(claimed.map((e) => e.id));
    const messages = withPhotoNotes(historyForModel(rows.filter((r) => !claimedIds.has(r.id))), photos, reads);
    const note = claimed.map((e) => `[Note from the site, not from the user: ${String(e.content?.content || "")}]`).join("\n\n");
    const last = messages[messages.length - 1];
    if (last?.role === "user" && typeof last.content === "string") messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
    else messages.push({ role: "user", content: note });
    let extraNote = "";
    try {
      extraNote = [await trayNote(await loadTray(), caller), progressNote(reads, photos)].filter(Boolean).join("\n");
    } catch (err) {
      console.error("Reading the tray for the follow-up's note failed:", err.message);
    }
    const turnId = newId();
    const summary = claimed.map((e) => e.content?.summary).filter(Boolean).join("; ") || "note from the site";
    const trace = startTrace({ name: "chat follow-up", sessionId: convo.id, userId: convo.user_id, tags: ["editor", "follow-up"], metadata: { mode: "follow-up", model: config.chatEditorModel, turnId, events: claimed.map((e) => e.id) }, input: summary });
    let output;
    try {
      const result = await runChat({
        caller,
        messages,
        page: {},
        emit: () => {}, // nobody is listening: the panel picks the stored answer up when it polls
        trace,
        model: config.chatEditorModel,
        apiKey: config.chatEditorKey,
        origin,
        extraNote,
        conversation: { id: convo.id, title: convo.title },
        photos,
        // the user's own words are their last message (this turn has none): "use this as the photo" with the photos still counts, nothing else does
        userText: String(rows.findLast((r) => r.role === "user")?.content?.content || ""),
      });
      output = result.reply;
      await appendMessages(convo.id, result.produced, { turnId, traceId: trace.traceId });
    } catch (err) {
      output = `error: ${err.message}`;
      console.error(`The follow-up turn failed: ${err.message}`);
      await appendMessages(convo.id, [{ role: "assistant", content: "", ui: { error: "I read your photos but couldn't finish adding them. Ask me to carry on." } }], { turnId, traceId: trace.traceId }).catch(() => {});
    } finally {
      trace.finish(output);
    }
    return { status: "done" };
  } catch (err) {
    console.error(`The follow-up for a note failed: ${err.message}`);
    return { status: "error" };
  } finally {
    if (convo && token) await afterTurn(convo.id, token, { origin });
  }
}

/**
 * The end of every turn (user or follow-up): releases the lock FIRST, then starts the follow-up for a note no turn has handled yet. In that order,
 * a note stored while this turn ran is never left behind: either its follow-up found the lock free, or this check sees it.
 */
export async function afterTurn(conversationId, token, { origin } = {}) {
  await releaseTurnLock(conversationId, token);
  try {
    const events = await unhandledEvents(conversationId);
    if (events.length) startFollowUp(events[0].id, { origin });
  } catch (err) {
    console.error("Checking for notes after a turn failed:", err.message);
  }
}
