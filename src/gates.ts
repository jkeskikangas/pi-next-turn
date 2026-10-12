// When not to predict (v1 D12): too early in a session, after an error or abort, while a dialog
// is open, in modes without a prompt editor; and back-off after many unused predictions.

export type GateInput = {
  mode: string;
  assistantMessages: number;
  aborted: boolean;
  lastStopReason?: string;
  dialogOpen: boolean;
  pendingMessages: boolean;
  enabled: boolean;
};

export type SkipReason = "disabled" | "mode" | "too_early" | "aborted" | "error" | "dialog" | "pending" | "backoff";

export function skipReason(g: GateInput): SkipReason | undefined {
  if (!g.enabled) return "disabled";
  if (g.mode !== "tui" && g.mode !== "rpc") return "mode";
  if (g.assistantMessages < 2) return "too_early";
  if (g.aborted) return "aborted";
  if (g.lastStopReason === "error" || g.lastStopReason === "aborted") return "error";
  if (g.dialogOpen) return "dialog";
  if (g.pendingMessages) return "pending";
  return undefined;
}

/** After `unused` shown predictions in a row go unused, predict only every `every`-th eligible turn. */
export class BackOff {
  private streak = 0;
  private turn = 0;
  private readonly unused: number;
  private readonly every: number;
  constructor(unused: number, every: number, initialStreak = 0) {
    this.unused = unused;
    this.every = every;
    this.streak = initialStreak;
  }
  get unusedStreak(): number {
    return this.streak;
  }
  get active(): boolean {
    return this.streak >= this.unused;
  }
  /** Whether this eligible turn may predict. */
  allow(): boolean {
    if (!this.active) return true;
    this.turn++;
    return this.turn % this.every === 0;
  }
  used(): void {
    this.streak = 0;
    this.turn = 0;
  }
  unusedOne(): void {
    this.streak++;
  }
}
