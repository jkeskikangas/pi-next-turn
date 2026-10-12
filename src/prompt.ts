// The instructions appended to the forked conversation (v1 D3, D9; v2 E6).

export function predictionInstruction(maxWords: number, alternatives: number): string {
  return `[NEXT PROMPT MODE — not a message from the user. Do not call tools. Do not answer or continue the work.]
Predict what the user will type next into this coding agent, in their own words.

THE TEST: would they think "I was just about to type that"?
- If your last message asked a question or offered options, predict their answer (e.g. "yes, go with option 2").
- Otherwise predict the obvious next request, phrased like their earlier messages (same language, tone, brevity).
- Each line 2–${maxWords} words. No questions back to the assistant, no praise or thanks, no assistant voice ("Let me…", "I'll…"), no new ideas the user has not hinted at, one sentence.
- If the next step is not obvious from what the user said, reply with exactly: NONE

Reply with up to ${alternatives} lines, most likely first, nothing else.`;
}

export function readAheadInstruction(predicted: string): string {
  return `[READ-AHEAD MODE — the user has not sent this yet.] The user is about to ask:

${predicted}

Do not answer and do not change anything. Use read, grep, find and ls to open the files this request will need (the code to change, how it is called, its tests), then stop with a one-line list of what you read. Read whole files where you can. Stay within a few tool calls.`;
}

export const SPECULATION_NOTE = "[Prepared ahead of time: edits go to an in-memory draft and are applied only if the user sends this request. Shell commands other than read-only inspection are unavailable; checks run separately.]";
