// pi-next-turn: predicts the user's next prompt after each run, shows it below the editor (and on
// the phone through pi-mobile, which listens on pi's event bus), reads the files that prompt will
// need when the prediction is confident, and — with drafts on and pi-multiedit installed — runs the
// whole predicted turn ahead of time, edits held in an in-memory draft until the user sends it.
// Jev (TypeSafe) is optional: used for scoring and safety only when configured and chosen.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveSetting } from "./src/config.ts";
import { ACCEPT_COMMAND, Engine } from "./src/engine.ts";
import { logPath, readLog, stats } from "./src/log.ts";

export default function (pi: ExtensionAPI): void {
  const engine = new Engine(pi);
  const keys = loadConfig(process.cwd()).keys;

  pi.on("session_start", (_e, ctx) => engine.sessionStart(ctx));
  pi.on("session_shutdown", () => engine.sessionShutdown());
  pi.on("session_tree", () => engine.reset("tree"));
  pi.on("session_compact", () => engine.reset("compaction"));
  pi.on("ui_prompt_start", () => engine.dialog(true));
  pi.on("ui_prompt_end", () => engine.dialog(false));
  pi.on("agent_start", () => engine.agentStart());
  pi.on("agent_settled", (event, ctx) => {
    // Off the settle path: the prediction runs in the background.
    setImmediate(() => void engine.afterRun(ctx, event.aborted).catch(() => undefined));
  });
  pi.on("input", (event) => engine.input(event.text, event.source, !!event.images?.length));
  pi.on("before_agent_start", (event) => {
    engine.captureOptions(event.systemPromptOptions as any);
    const message = engine.injection(event.prompt ?? "");
    return message ? { message } : undefined;
  });

  pi.registerShortcut(keys.fill as any, { description: "Use the predicted next prompt", handler: (ctx) => engine.fill(ctx) });
  pi.registerShortcut(keys.cycle as any, { description: "Next predicted prompt", handler: (ctx) => engine.cycle(ctx) });

  pi.registerCommand(ACCEPT_COMMAND, {
    description: "Internal: hand over a turn prepared ahead of time",
    handler: async (args, ctx) => engine.accept(args.trim(), ctx),
  });

  pi.registerCommand("next-turn", {
    description: "Next-prompt predictions: status | on | off | stats | drafts on|off | set <key> <value>",
    getArgumentCompletions: (prefix) =>
      ["status", "on", "off", "stats", "drafts on", "drafts off", "read-ahead on", "read-ahead off", "scorer agreement", "scorer jev", "scorer auto", "set "]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const set = (key: string, value: string) => {
        const err = saveSetting(key, value);
        if (err) return ctx.ui.notify(`pi-next-turn: ${err}`, "warning");
        engine.cfg = loadConfig(ctx.cwd);
        ctx.ui.notify(`pi-next-turn: ${key} = ${value}`, "info");
      };
      switch (cmd ?? "status") {
        case "status":
          return ctx.ui.notify(engine.summaryText(), "info");
        case "on":
          return set("enabled", "on");
        case "off":
          engine.reset("disabled");
          return set("enabled", "off");
        case "drafts":
          return set("draft", rest[0] ?? "on");
        case "read-ahead":
          return set("readAhead", rest[0] ?? "on");
        case "scorer":
          if (!["agreement", "jev", "auto"].includes(rest[0] ?? "")) return ctx.ui.notify("pi-next-turn: scorer agreement | jev | auto", "warning");
          return set("scorer", rest[0]);
        case "set":
          if (rest.length < 2) return ctx.ui.notify("pi-next-turn: set <key> <value>, e.g. set pRead 0.75", "warning");
          return set(rest[0], rest.slice(1).join(" "));
        case "stats": {
          const s = stats(readLog());
          const accepted = s.accepted_exact + s.accepted_edited;
          const rate = s.shown ? ((accepted / s.shown) * 100).toFixed(0) : "–";
          return ctx.ui.notify(
            `pi-next-turn stats (${logPath()}):\nshown ${s.shown} of ${s.predictions} predictions · accepted ${accepted} (${rate}%: exact ${s.accepted_exact}, edited ${s.accepted_edited}) · changed course ${s.changed_course} · ignored ${s.ignored}\nread-aheads ${s.readAheads} · speculations ${s.speculations} · hand-overs ${s.handovers} · cost $${s.cost.toFixed(4)}`,
            "info",
          );
        }
        default:
          return ctx.ui.notify("Usage: /next-turn [status | on | off | stats | drafts on|off | read-ahead on|off | scorer agreement|jev|auto | set <key> <value>]", "info");
      }
    },
  });
}
