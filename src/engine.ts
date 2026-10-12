// The orchestrator: predicts after each settled run, shows and publishes predictions, reads ahead
// or speculates when confident, records outcomes, injects read-ahead files into an accepted turn,
// and hands a prepared turn over when the user sends what was prepared (v1, v2).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataDir, loadConfig, type Config } from "./config.ts";
import { DraftClient } from "./draft-client.ts";
import { assistantText, captureSource, type ForkSource } from "./fork.ts";
import { BackOff, skipReason } from "./gates.ts";
import { composeInjection, readIsAnchored, VIEW_EVENT } from "./inject.ts";
import { findJev, judgeSpeculation, JevScorer } from "./jev.ts";
import { EventLog } from "./log.ts";
import { predict } from "./predict.ts";
import { readAhead } from "./readahead.ts";
import { AgreementScorer, loadCalibration, type Candidate, type Scorer } from "./scorer.ts";
import { classifySend, similarity, type OutcomeKind } from "./similar.ts";
import { speculate, type Speculation } from "./speculate.ts";
import { renderWidget, type WidgetState } from "./tui.ts";
import { contentText } from "./text.ts";

export const EVENTS = {
  ready: "next-turn:ready",
  prediction: "next-turn:prediction",
  clear: "next-turn:clear",
  outcome: "next-turn:outcome",
} as const;

export const ACCEPT_COMMAND = "next-turn-accept";
export const MESSAGE_TYPE = "pi-next-turn";
const WIDGET = "next-turn";

type Phase = "none" | "running" | "ready";

export type Prediction = {
  id: string;
  sessionId: string;
  candidates: Candidate[];
  at: number;
  readAhead: Phase;
  files?: Map<string, string>;
  speculation?: Speculation;
  speculating: boolean;
  controller: AbortController;
  baseLeafId: string | null;
  filled?: string;
  hidden: boolean;
  settled: boolean;
  scorer: string;
};

export type PredictionEvent = {
  id: string;
  sessionId: string;
  candidates: Candidate[];
  readAhead: Phase;
  draft?: { files: number; insertions: number; deletions: number; checks?: "pass" | "fail" | "none" };
  at: number;
};

function draftView(s: Speculation | undefined): PredictionEvent["draft"] {
  if (!s || !s.complete || !s.summary.files.length) return undefined;
  return { files: s.summary.files.length, insertions: s.summary.insertions, deletions: s.summary.deletions, checks: s.verify?.checks ?? "none" };
}

export class Engine {
  current: Prediction | undefined;
  private options: Record<string, any> | undefined;
  private backoff: BackOff;
  private dialogs = 0;
  private selected = 0;
  private bypass = new Set<string>();
  private pendingInjection: { forText: string; files: Map<string, string> } | undefined;
  private pendingAccept: { id: string; text: string } | undefined;
  private running: AbortController | undefined;
  private ctx: ExtensionContext | undefined;
  private unsubscribeInput: (() => void) | undefined;
  readonly draft: DraftClient;
  log: EventLog;
  cfg: Config;
  lastSkip: string | undefined;

  private readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI, cwd: string = process.cwd()) {
    this.pi = pi;
    this.cfg = loadConfig(cwd);
    this.log = new EventLog(undefined, this.cfg.debug);
    this.backoff = new BackOff(this.cfg.backoff.unused, this.cfg.backoff.every, this.loadStreak());
    this.draft = new DraftClient(pi.events);
  }

  // ── persistence of the back-off streak (survives restarts, like Claude Code's) ──

  private statePath(): string {
    return join(dataDir(), "state.json");
  }
  private loadState(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.statePath(), "utf8")) ?? {};
    } catch {
      return {};
    }
  }
  private loadStreak(): number {
    return Number(this.loadState().unusedStreak) || 0;
  }
  private saveState(patch: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.statePath()), { recursive: true });
      writeFileSync(this.statePath(), JSON.stringify({ ...this.loadState(), ...patch }) + "\n");
    } catch {}
  }
  private saveStreak(): void {
    this.saveState({ unusedStreak: this.backoff.unusedStreak });
  }

  /** Once: with predictions only, say that working ahead exists and how to turn it on. */
  private aheadTip(ctx: ExtensionContext): void {
    if (this.cfg.ahead !== "off" || !ctx.hasUI || this.loadState().aheadTipShown) return;
    this.saveState({ aheadTipShown: true });
    try {
      ctx.ui.notify("pi-next-turn shows predictions only. /next-turn ahead read also reads the files a confident prediction needs while you read; /next-turn ahead draft runs the whole turn ahead, its edits held in a draft until you send it.", "info");
    } catch {}
  }

  // ── lifecycle ──

  sessionStart(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.cfg = loadConfig(ctx.cwd);
    this.log = new EventLog(undefined, this.cfg.debug);
    this.reset("session");
    this.pi.events.emit(EVENTS.ready, { version: 1 });
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    if (ctx.mode === "tui" && ctx.hasUI) {
      this.unsubscribeInput = ctx.ui.onTerminalInput(() => {
        setImmediate(() => this.editorChanged());
        return undefined;
      });
    }
  }

  sessionShutdown(): void {
    this.reset("session");
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    this.draft.dispose();
  }

  captureOptions(options: Record<string, any>): void {
    // The object is shared with later before_agent_start handlers; it is cloned when a fork is made.
    this.options = options;
  }

  dialog(open: boolean): void {
    this.dialogs = Math.max(0, this.dialogs + (open ? 1 : -1));
  }

  agentStart(): void {
    this.running?.abort();
    if (this.current) this.clear("run started", true);
  }

  /** Clears the current prediction; records `ignored` unless an outcome was recorded. */
  reset(reason: string): void {
    this.running?.abort();
    this.running = undefined;
    if (this.current) this.clear(reason, true);
    this.pendingInjection = undefined;
    this.pendingAccept = undefined;
  }

  private clear(reason: string, ignored: boolean): void {
    const p = this.current;
    if (!p) return;
    this.current = undefined;
    p.controller.abort();
    if (p.speculation && !this.pendingAccept) void this.draft.discard(p.speculation.draftId);
    if (ignored && !p.settled) this.recordOutcome(p, "ignored", "", { reason });
    this.setWidget(undefined);
    this.pi.events.emit(EVENTS.clear, { id: p.id });
  }

  // ── prediction ──

  /** `leafId`: the leaf when the run settled; a later run makes this call stale. */
  async afterRun(ctx: ExtensionContext, aborted: boolean, leafId: string | null = ctx.sessionManager.getLeafId()): Promise<void> {
    this.ctx = ctx;
    this.cfg = loadConfig(ctx.cwd);
    if (ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle()) return this.skipped("stale");
    const branch = ctx.sessionManager.getBranch() as any[];
    const messages = branch.filter((e) => e.type === "message").map((e) => e.message);
    const assistants = messages.filter((m) => m.role === "assistant");
    const skip = skipReason({
      enabled: this.cfg.enabled,
      mode: ctx.mode,
      assistantMessages: assistants.length,
      aborted,
      lastStopReason: assistants[assistants.length - 1]?.stopReason,
      dialogOpen: this.dialogs > 0,
      pendingMessages: ctx.hasPendingMessages(),
    });
    if (skip) return this.skipped(skip);
    if (!this.backoff.allow()) return this.skipped("backoff");
    const src = captureSource(this.pi, ctx, this.options);
    if (!src) return this.skipped("no_source");
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const { model, thinkingLevel } = this.forkModel(ctx);
    const scorer = await this.scorer(ctx);
    const lastAssistant = assistantText(assistants[assistants.length - 1]);
    const recentUser = messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).slice(-5);
    let result;
    try {
      result = await predict(src, scorer, { lastAssistant, recentUser }, { samples: this.cfg.samples, limits: { maxWords: this.cfg.maxWords, maxChars: this.cfg.maxChars }, model, thinkingLevel, signal: controller.signal });
    } catch (e) {
      this.log.write("error", { stage: "predict", error: String((e as Error)?.message ?? e) });
      return;
    } finally {
      if (this.running === controller) this.running = undefined;
    }
    if (controller.signal.aborted || !ctx.isIdle()) return;
    const shown = result.candidates.filter((c) => c.p >= this.cfg.pShow).slice(0, 3);
    this.log.write(
      "prediction",
      { scorer: scorer.name, samples: this.cfg.samples, shown: shown.length > 0, top: result.candidates[0]?.p ?? 0, n: result.candidates.length, dropped: result.dropped.map((d) => d.reason), ms: result.ms, cost: result.usage.cost, cacheRead: result.usage.cacheRead, input: result.usage.input },
      { candidateTexts: result.candidates, sampleTexts: result.samples, droppedTexts: result.dropped },
    );
    if (!shown.length) return;
    const p: Prediction = {
      id: randomUUID(),
      sessionId: ctx.sessionManager.getSessionId(),
      candidates: shown,
      at: Date.now(),
      readAhead: "none",
      speculating: false,
      controller: new AbortController(),
      baseLeafId: ctx.sessionManager.getLeafId(),
      hidden: !!ctx.hasUI && ctx.mode === "tui" && ctx.ui.getEditorText().trim() !== "",
      settled: false,
      scorer: scorer.name,
    };
    if (this.current) this.clear("replaced", true);
    this.current = p;
    this.selected = 0;
    this.publish();
    this.aheadTip(ctx);
    void this.aheadOfTime(p, src, ctx, lastAssistant, model, thinkingLevel);
  }

  private skipped(reason: string): void {
    this.lastSkip = reason;
    if (reason !== "mode") this.log.write("skip", { reason });
  }

  private forkModel(ctx: ExtensionContext): { model?: any; thinkingLevel?: any } {
    let model: any;
    if (this.cfg.model !== "session") {
      const [provider, ...rest] = this.cfg.model.split("/");
      model = ctx.modelRegistry.find(provider, rest.join("/"));
    }
    const thinkingLevel = this.cfg.thinking !== "session" ? this.cfg.thinking : undefined;
    return { model, thinkingLevel };
  }

  /** Agreement scorer unless Jev is chosen ("jev") or allowed ("auto") and a classifier is configured. */
  async scorer(ctx: ExtensionContext): Promise<Scorer> {
    const agreement = new AgreementScorer(this.cfg.agreeCut, loadCalibration(dataDir(), this.cfg.samples));
    if (this.cfg.scorer === "agreement") return agreement;
    const jev = await findJev(ctx.modelRegistry as any);
    if (!jev) return agreement;
    const jevScorer = new JevScorer(ctx.modelRegistry as any, jev, this.cfg.agreeCut);
    return {
      name: "jev",
      score: async (samples, sctx) => {
        try {
          return await jevScorer.score(samples, sctx);
        } catch {
          return agreement.score(samples);
        }
      },
    };
  }

  // ── read-ahead / speculation (v1 D9, v2 E6) ──

  private async aheadOfTime(p: Prediction, src: ForkSource, ctx: ExtensionContext, lastAssistant: string, model: any, thinkingLevel: any): Promise<void> {
    const top = p.candidates[0];
    const signal = p.controller.signal;
    if (this.cfg.ahead === "draft" && top.p >= this.cfg.pDraft && (await this.draft.available()) && (await this.safeToSpeculate(ctx, top.text, lastAssistant, signal))) {
      p.speculating = true;
      p.readAhead = "running";
      this.publish();
      try {
        const s = await speculate(src, top.text, { caps: this.cfg.draftCaps, draft: this.draft, model, thinkingLevel, signal, verify: this.cfg.verify, verifyMs: this.cfg.verifyMs });
        this.log.write("speculation", { complete: s.complete, stopped: s.stopped, refused: s.refused?.name, files: s.summary.files.length, checks: s.verify?.checks, ms: s.ms, cost: s.usage.cost, cacheRead: s.usage.cacheRead, input: s.usage.input, p: top.p });
        if (signal.aborted || this.current !== p) {
          void this.draft.discard(s.draftId);
          return;
        }
        p.speculation = s;
        p.files = s.files;
        if (!s.complete) void this.draft.discard(s.draftId);
        p.readAhead = s.files.size ? "ready" : "none";
      } catch (e) {
        this.log.write("error", { stage: "speculate", error: String((e as Error)?.message ?? e) });
        p.readAhead = "none";
      } finally {
        p.speculating = false;
        this.speculationDone?.(p);
      }
      if (this.current === p) this.publish();
      return;
    }
    if (this.cfg.ahead === "off" || top.p < this.cfg.pRead) return;
    p.readAhead = "running";
    this.publish();
    try {
      const anchored = readIsAnchored(src.tools);
      const r = await readAhead(src, top.text, { caps: this.cfg.readCaps, anchored, model, thinkingLevel, signal });
      this.log.write("read_ahead", { files: r.files.size, calls: r.calls, stopped: r.stopped, aborted: r.aborted, ms: r.ms, cost: r.usage.cost, cacheRead: r.usage.cacheRead, input: r.usage.input, p: top.p });
      if (this.current !== p) return;
      p.files = r.files;
      p.readAhead = r.files.size ? "ready" : "none";
    } catch (e) {
      this.log.write("error", { stage: "read_ahead", error: String((e as Error)?.message ?? e) });
      p.readAhead = "none";
    }
    if (this.current === p) this.publish();
  }

  /** Test hook: called when a speculation finishes. */
  speculationDone?: (p: Prediction) => void;

  private async safeToSpeculate(ctx: ExtensionContext, task: string, lastAssistant: string, signal: AbortSignal): Promise<boolean> {
    if (!this.cfg.jevSafety) return true;
    const jev = await findJev(ctx.modelRegistry as any);
    if (!jev) return true;
    try {
      const v = await judgeSpeculation(ctx.modelRegistry as any, jev, task, lastAssistant, signal);
      this.log.write("safety", { safe: v.safe, ...v.scores });
      return v.safe;
    } catch {
      return false;
    }
  }

  // ── publishing ──

  event(p: Prediction): PredictionEvent {
    return { id: p.id, sessionId: p.sessionId, candidates: p.candidates, readAhead: p.readAhead, draft: draftView(p.speculation), at: p.at };
  }

  private publish(): void {
    const p = this.current;
    if (!p) return;
    this.pi.events.emit(EVENTS.prediction, this.event(p));
    this.render();
  }

  private render(): void {
    const p = this.current;
    if (!p || p.hidden) return this.setWidget(undefined);
    const state: WidgetState = { candidates: p.candidates, selected: this.selected, readAhead: p.readAhead, draft: draftView(p.speculation), keys: this.cfg.keys };
    let theme: any;
    try {
      theme = this.ctx?.ui.theme;
    } catch {}
    this.setWidget(renderWidget(state, theme));
  }

  private setWidget(lines: string[] | undefined): void {
    const ctx = this.ctx;
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    try {
      ctx.ui.setWidget(WIDGET, lines && lines.length ? lines : undefined, { placement: "belowEditor" });
    } catch {}
  }

  /** Typing hides the widget; an empty editor shows it again. */
  editorChanged(): void {
    const p = this.current;
    const ctx = this.ctx;
    if (!p || !ctx?.hasUI) return;
    let text = "";
    try {
      text = ctx.ui.getEditorText();
    } catch {}
    const hide = text.trim() !== "" && text !== p.filled;
    if (hide !== p.hidden) {
      p.hidden = hide;
      this.render();
    }
  }

  fill(ctx: ExtensionContext): void {
    const p = this.current;
    if (!p) return;
    const current = ctx.ui.getEditorText();
    if (current.trim() && current !== p.filled) return;
    const text = p.candidates[this.selected]?.text;
    if (!text) return;
    p.filled = text;
    ctx.ui.setEditorText(text);
    this.render();
  }

  cycle(ctx: ExtensionContext): void {
    const p = this.current;
    if (!p || p.candidates.length < 2) return;
    this.selected = (this.selected + 1) % p.candidates.length;
    if (p.filled !== undefined && ctx.ui.getEditorText() === p.filled) {
      p.filled = p.candidates[this.selected].text;
      ctx.ui.setEditorText(p.filled);
    }
    this.render();
  }

  // ── outcomes, injection, hand-over ──

  private recordOutcome(p: Prediction, outcome: OutcomeKind, sent: string, extra: Record<string, unknown> = {}): void {
    if (p.settled) return;
    p.settled = true;
    if (outcome === "accepted_exact" || outcome === "accepted_edited") this.backoff.used();
    else this.backoff.unusedOne();
    this.saveStreak();
    this.log.write("outcome", { id: p.id, outcome, p: p.candidates[0]?.p, raw: p.candidates[0]?.raw, scorer: p.scorer, samples: this.cfg.samples, readAhead: p.readAhead, draft: !!draftView(p.speculation), ...extra }, { sent, shown: p.candidates.map((c) => c.text) });
    this.pi.events.emit(EVENTS.outcome, { id: p.id, outcome, sent });
    if (outcome !== "ignored") {
      try {
        this.pi.appendEntry(MESSAGE_TYPE, { id: p.id, outcome, p: p.candidates[0]?.p });
      } catch {}
    }
  }

  /** `input` handler: classifies the send, then hands over, injects or just clears. */
  input(text: string, source: string, hasImages: boolean): { action: "continue" } | { action: "handled" } {
    if (this.bypass.delete(text)) return { action: "continue" };
    const p = this.current;
    if (!p) return { action: "continue" };
    const shown = p.candidates.map((c) => c.text);
    const m = classifySend(shown, text, this.cfg.editedCut);
    const s = p.speculation;
    const handover = !!s && s.complete && !hasImages && !text.startsWith("/") && (m.outcome === "accepted_exact" || (m.outcome === "accepted_edited" && similarity(s.predicted, text) >= this.cfg.handoverCut));
    if (handover) {
      this.pendingAccept = { id: p.id, text };
      this.current = undefined;
      this.setWidget(undefined);
      this.pi.events.emit(EVENTS.clear, { id: p.id });
      this.handoverPrediction = p;
      setImmediate(() => this.pi.sendUserMessage(`/${ACCEPT_COMMAND} ${p.id}`, { expandPromptTemplates: true }));
      return { action: "handled" };
    }
    if (s && m.outcome === "accepted_exact" && p.speculating) this.log.write("handover", { ok: false, reason: "still running" });
    if (m.outcome !== "changed_course") this.pendingInjection = { forText: text, files: p.files ?? new Map() };
    this.recordOutcome(p, m.outcome, text, { similarity: m.similarity, source });
    this.clear("sent", false);
    return { action: "continue" };
  }

  private handoverPrediction: Prediction | undefined;

  /** before_agent_start: the files read ahead, as already-read context, when the prompt matches. */
  injection(prompt: string): { customType: string; content: string; display: boolean } | undefined {
    const pending = this.pendingInjection;
    this.pendingInjection = undefined;
    if (!pending || !pending.files.size || pending.forText.trim() !== prompt.trim()) return undefined;
    const ctx = this.ctx;
    const tools = (() => {
      try {
        return this.pi.getAllTools();
      } catch {
        return [];
      }
    })();
    const inj = composeInjection(ctx?.cwd ?? process.cwd(), pending.files, this.cfg.injectChars, readIsAnchored(tools));
    if (!inj) return undefined;
    for (const v of inj.views) this.pi.events.emit(VIEW_EVENT, v);
    this.log.write("inject", { files: inj.files.length, chars: inj.text.length });
    return { customType: `${MESSAGE_TYPE}-files`, content: inj.text, display: false };
  }

  /** `/next-turn-accept <id>`: puts the prepared branch into the session and applies its draft (v2 E7). */
  async accept(id: string, ctx: ExtensionCommandContext): Promise<void> {
    const pending = this.pendingAccept;
    const p = this.handoverPrediction;
    this.pendingAccept = undefined;
    this.handoverPrediction = undefined;
    if (!pending || pending.id !== id || !p?.speculation) return;
    const s = p.speculation;
    const fallback = async (reason: string) => {
      this.log.write("handover", { ok: false, reason });
      void this.draft.discard(s.draftId);
      this.recordOutcome(p, pending.text === s.predicted ? "accepted_exact" : "accepted_edited", pending.text, { handover: false, reason });
      this.pendingInjection = { forText: pending.text, files: s.files };
      this.bypass.add(pending.text);
      this.pi.sendUserMessage(pending.text);
    };
    const sm = ctx.sessionManager as any;
    const leaf = sm.getLeafId();
    if (!this.sameContext(sm, s.baseLeafId, leaf)) return fallback("session moved");
    let applied: { ok: boolean; content?: { type: string; text: string }[]; error?: string } = { ok: true };
    if (s.summary.files.length) {
      applied = await this.draft.apply(s.draftId).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!applied.ok) return fallback(`draft not applied: ${applied.error ?? "unknown"}`);
    } else void this.draft.discard(s.draftId);
    let first = true;
    for (const e of s.entries as any[]) {
      if (e.type !== "message" || e.message?.role === "system") continue;
      let message = e.message;
      if (first && message.role === "user") {
        message = { ...message, content: pending.text, timestamp: Date.now() };
        first = false;
      }
      sm.appendMessage(message);
    }
    const last = sm.getLeafId();
    sm.branch(leaf);
    try {
      await ctx.navigateTree(last);
    } catch (e) {
      this.log.write("error", { stage: "handover", error: String((e as Error)?.message ?? e) });
    }
    this.recordOutcome(p, pending.text === s.predicted ? "accepted_exact" : "accepted_edited", pending.text, { handover: true });
    const lines = [`Prepared ahead of time while you were reading${s.summary.files.length ? "; the draft was applied" : ""}.`];
    if (s.summary.files.length) lines.push(`Changed: ${s.summary.files.map((f) => `${f.path} (${f.status})`).join(", ")} (+${s.summary.insertions} −${s.summary.deletions}).`);
    if (s.verify?.checks && s.verify.checks !== "none") lines.push(`${s.verify.label}: ${s.verify.checks === "pass" ? "passed" : "failed"} in a separate worktree.`);
    if (applied.content?.length) lines.push(applied.content.map((c) => c.text).join("\n"));
    this.pi.sendMessage({ customType: MESSAGE_TYPE, content: lines.join("\n"), display: true });
    this.log.write("handover", { ok: true, files: s.summary.files.length, checks: s.verify?.checks });
    setImmediate(() => void this.afterRun(ctx, false));
  }

  /** The leaf may have moved past the fork point only by entries that are not in the model context. */
  private sameContext(sm: any, base: string | null, leaf: string | null): boolean {
    if (base === leaf) return true;
    const branch = sm.getBranch(leaf) as any[];
    const i = branch.findIndex((e) => e.id === base);
    if (i < 0) return false;
    return branch.slice(i + 1).every((e) => e.type === "custom" || e.type === "label" || e.type === "session_info");
  }

  summaryText(): string {
    const p = this.current;
    const lines = [`pi-next-turn: ${this.cfg.enabled ? "on" : "off"} · scorer ${this.cfg.scorer} · samples ${this.cfg.samples} · ahead ${this.cfg.ahead}`];
    lines.push(`thresholds: show ${this.cfg.pShow}, read ${this.cfg.pRead}, draft ${this.cfg.pDraft} · unused streak ${this.backoff.unusedStreak}${this.backoff.active ? " (backing off)" : ""}`);
    if (p) lines.push(`current: ${p.candidates.map((c) => `"${c.text}" ${c.p.toFixed(2)}`).join(", ")} · ahead: ${p.readAhead}${p.speculation ? ` · draft ${draftView(p.speculation)?.files ?? 0} files` : ""}`);
    else if (this.lastSkip) lines.push(`last skip: ${this.lastSkip}`);
    return lines.join("\n");
  }
}

