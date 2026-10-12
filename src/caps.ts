// Hard caps for a running fork (v1 D10, v2 E6): tool calls, wall time, tokens. Exceeding one
// aborts the fork; the reason is kept for logs and `/next-turn status`.
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { totalTokens, usageOf } from "./usage.ts";

export type Caps = { toolCalls: number; ms: number; tokens: number };

export class CapGuard {
  reason: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly session: AgentSession;
  private readonly caps: Caps;
  constructor(session: AgentSession, caps: Caps, from: number) {
    this.session = session;
    this.caps = caps;
    this.timer = setTimeout(() => this.stop(`time cap ${caps.ms} ms`), caps.ms);
    this.timer.unref?.();
    this.unsubscribe = session.subscribe((ev: any) => {
      if (ev.type === "message_end" && totalTokens(usageOf(session.messages, from)) > caps.tokens) this.stop(`token cap ${caps.tokens}`);
    });
  }
  call(n: number): void {
    if (n > this.caps.toolCalls) this.stop(`tool-call cap ${this.caps.toolCalls}`);
  }
  stop(reason: string): void {
    if (this.reason) return;
    this.reason = reason;
    void this.session.abort();
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.();
  }
}
