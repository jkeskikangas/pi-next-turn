// Client for pi-multiedit's in-process draft channel (`multiedit:draft` on pi's event bus, v2 E1).
// No package dependency: when pi-multiedit (with draft support) is not loaded, `available()` is
// false and v2 speculation falls back to v1 read-ahead.
import type { DraftOps } from "./tools.ts";
import type { ToolResult } from "./fork.ts";

export type EventBusLike = { emit(name: string, data: unknown): void; on(name: string, handler: (data: any) => void): () => void };

export type DraftSummary = { files: { path: string; status: "created" | "modified" | "deleted"; diff?: string }[]; insertions: number; deletions: number };

export class DraftClient {
  private ready = false;
  private readonly off: () => void;
  constructor(
    private readonly events: EventBusLike,
    private readonly timeoutMs = 5000,
  ) {
    this.off = events.on("multiedit:draft-ready", () => {
      this.ready = true;
    });
  }

  dispose(): void {
    this.off();
  }

  /** Whether pi-multiedit answers on the draft channel. Probes once if no announcement was seen. */
  async available(): Promise<boolean> {
    if (this.ready) return true;
    try {
      const r = await this.request({ op: "summary", draftId: "__probe__" }, 500);
      this.ready = r !== undefined;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  request(req: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<any> {
    return new Promise((resolvePromise, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`pi-multiedit did not answer ${String(req.op)}`));
      }, timeoutMs);
      timer.unref?.();
      try {
        this.events.emit("multiedit:draft", {
          ...req,
          reply: (result: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolvePromise(result);
          },
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  }

  async open(cwd: string): Promise<string> {
    const r = await this.request({ op: "open", cwd });
    if (!r?.draftId) throw new Error(r?.error ?? "could not open a draft");
    return r.draftId;
  }

  ops(draftId: string): DraftOps {
    const asResult = (r: any): ToolResult => (r?.error ? { content: [{ type: "text", text: String(r.error) }], isError: true } : { content: r?.content ?? [{ type: "text", text: "" }], details: r?.details });
    return {
      edit: async (params) => asResult(await this.request({ op: "edit", draftId, params })),
      read: async (args) => {
        const r = await this.request({ op: "read", draftId, path: args?.path, offset: args?.offset, limit: args?.limit });
        return { ...asResult(r), fileText: r?.fileText, abs: r?.abs };
      },
    };
  }

  async summary(draftId: string): Promise<DraftSummary> {
    const r = await this.request({ op: "summary", draftId });
    if (r?.error) throw new Error(r.error);
    return { files: r?.files ?? [], insertions: r?.insertions ?? 0, deletions: r?.deletions ?? 0 };
  }

  async apply(draftId: string): Promise<{ ok: boolean; content?: { type: string; text: string }[]; details?: any; error?: string }> {
    return this.request({ op: "apply", draftId }, 30_000);
  }

  async discard(draftId: string): Promise<void> {
    await this.request({ op: "discard", draftId }).catch(() => undefined);
  }

  async materialize(draftId: string, dir: string): Promise<void> {
    const r = await this.request({ op: "materialize", draftId, dir }, 30_000);
    if (!r?.ok) throw new Error(r?.error ?? "materialize failed");
  }
}
