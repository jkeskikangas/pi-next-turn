// Text filters a candidate must pass before it is shown (v1 D13). Starts from Claude Code's set,
// minus the two that drop good prompts: `prefixed_label` (drops "fix: handle empty input") and
// the unanchored `evaluative` match (drops "add a greater-than check"); evaluative is anchored
// to the start here. The replay eval reports each filter's effect (eval/replay.ts).

export type FilterLimits = { maxWords: number; maxChars: number };
export const DEFAULT_LIMITS: FilterLimits = { maxWords: 12, maxChars: 100 };

const SHORT_OK = new Set(["yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "continue", "proceed", "commit", "push", "deploy", "ship", "merge", "revert", "undo", "retry", "go", "next", "both", "neither"]);
const DONE = /^(done|完了|完成|완료)$/i;
const META = /^(nothing( found)?|no suggestion|none|n\/a|silence|stay silent|\(silence\)|no prediction)\.?$/i;
const WRAPPED = /^[([{<].*[)\]}>]$/s;
const ERROR = /^(api error:|prompt is too long|invalid api key|error:|request failed|rate limit)/i;
const EVALUATIVE = /^(great|thanks|thank you|perfect|nice|awesome|looks good|lgtm|excellent|amazing|cool|wonderful)\b/i;
const ASSISTANT_VOICE = /^(let me|i'll|i will|i'm going to|here's|here is|this is|you can|sure,|certainly|of course)\b/i;
const SENTENCES = /[.!?]\s+[A-Z]/;
const FORMATTING = /\n|\*\*|^#|^[-*] /m;

export type FilterReason =
  | "empty"
  | "done"
  | "meta_text"
  | "meta_wrapped"
  | "error_message"
  | "too_few_words"
  | "too_many_words"
  | "too_long"
  | "multiple_sentences"
  | "has_formatting"
  | "evaluative"
  | "assistant_voice";

export const ALL_FILTERS: FilterReason[] = ["empty", "done", "meta_text", "meta_wrapped", "error_message", "too_few_words", "too_many_words", "too_long", "multiple_sentences", "has_formatting", "evaluative", "assistant_voice"];

/** Strips wrappers models add around a candidate: list markers, quotes, `Suggestion:` labels, tags. */
export function clean(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^<\/?suggestion>|<\/?suggestion>$/gi, "").trim();
  s = s.replace(/^(\d+[.)]|[-*•])\s+/, "");
  s = s.replace(/^(suggestion|prediction|next prompt|user)\s*:\s*/i, "");
  if (/^(["'`]).*\1$/s.test(s) && s.length > 1) s = s.slice(1, -1).trim();
  return s;
}

/** The first filter the text fails, or undefined when it may be shown. `disabled` skips filters. */
export function rejectReason(text: string, limits: FilterLimits = DEFAULT_LIMITS, disabled: ReadonlySet<FilterReason> = new Set()): FilterReason | undefined {
  const on = (r: FilterReason) => !disabled.has(r);
  const s = text.trim();
  if (!s) return "empty";
  if (on("done") && DONE.test(s)) return "done";
  if (on("meta_text") && META.test(s)) return "meta_text";
  if (on("meta_wrapped") && WRAPPED.test(s)) return "meta_wrapped";
  if (on("error_message") && ERROR.test(s)) return "error_message";
  const words = s.split(/\s+/).filter(Boolean);
  if (on("too_few_words") && words.length < 2 && !s.startsWith("/") && !SHORT_OK.has(s.toLowerCase().replace(/[.!]$/, ""))) return "too_few_words";
  if (on("too_many_words") && words.length > limits.maxWords) return "too_many_words";
  if (on("too_long") && s.length >= limits.maxChars) return "too_long";
  if (on("multiple_sentences") && SENTENCES.test(s)) return "multiple_sentences";
  if (on("has_formatting") && FORMATTING.test(s)) return "has_formatting";
  if (on("evaluative") && EVALUATIVE.test(s)) return "evaluative";
  if (on("assistant_voice") && ASSISTANT_VOICE.test(s)) return "assistant_voice";
  return undefined;
}

/** Parses a model reply into cleaned candidate lines (most likely first); NONE → []. */
export function parseCandidates(reply: string, max = 3): string[] {
  const lines = reply
    .split("\n")
    .map(clean)
    .filter(Boolean);
  if (!lines.length || /^none\.?$/i.test(lines[0])) return [];
  return lines.filter((l) => !/^none\.?$/i.test(l)).slice(0, max);
}
