import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { EventBus } from "./bus.js";
import type { AgentEvent } from "./types.js";

/**
 * A Claude Code-style transcript in the terminal: "⏺ Tool(args)" per call, "⎿" for its result, the
 * phase verdicts and Overseer decisions in between, and the same permission prompt as the web UI
 * (1 = yes, 2 = yes + don't ask again, 3 = no + tell it what to do instead). Either place can answer
 * an approval; whichever answers first wins and the other one moves on.
 */
export interface TerminalOptions {
  input?: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  output?: Writable & { isTTY?: boolean; columns?: number };
  /** Answer approvals here (needs a TTY). When false, the transcript still prints. */
  interactive: boolean;
  workDir?: string;
  /** Shown while waiting, so a non-interactive terminal says where to approve. */
  uiUrl?: string;
  color?: boolean;
}

type ApprovalRequest = Extract<AgentEvent, { type: "approval-request" }>;

export function attachTerminal(bus: EventBus, opts: TerminalOptions) {
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const useColor = opts.color ?? (!!out.isTTY && !process.env.NO_COLOR);
  const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const orange = c("38;5;173"), dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), blue = c("38;5;147"), yellow = c("33");
  const width = () => Math.max(60, Math.min(out.columns ?? 100, 120));
  const write = (s: string) => out.write(s + "\n");
  const rel = (p: unknown) => {
    const s = String(p ?? "");
    return opts.workDir && s.startsWith(opts.workDir + "/") ? s.slice(opts.workDir.length + 1) : s;
  };
  const short = (s: unknown, n: number) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const label = (name: string, i: Record<string, unknown> = {}) => {
    const b = name.match(/^mcp__browser__(\w+)$/);
    if (b) return `browser.${b[1]}(${short(i.url ?? i.selector ?? i.text ?? i.key ?? "", 70)})`;
    if (name === "Bash") return `Bash(${short(i.command, 90)})`;
    if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) return `${name}(${rel(i.file_path ?? i.notebook_path)})`;
    if (name === "Glob") return `Glob(${short(i.pattern, 70)})`;
    if (name === "Grep") return `Grep("${short(i.pattern, 50)}")`;
    return `${name}(${short(JSON.stringify(i), 70)})`;
  };

  const pretty = (r: string) => r.replace(/mcp__browser__/g, "browser.");
  let cost = 0;
  let startedAt = 0;
  const tools = new Map<string, string>();
  const queue: ApprovalRequest[] = [];
  let active: ApprovalRequest | null = null;
  let typing: string | null = null; // non-null while typing a rejection reason

  // --- the permission prompt
  // The caller decides (cli.ts: approvals on AND stdin is a TTY); tests drive it with a plain stream.
  const canPrompt = opts.interactive;
  function showPrompt() {
    if (active || !queue.length) return;
    active = queue[0];
    const i = (active.toolInput ?? {}) as Record<string, unknown>;
    const title = active.toolName === "Bash" ? "Bash command" : active.toolName === "Write" ? `Create file ${rel(i.file_path)}` : active.toolName === "Edit" ? `Edit file ${rel(i.file_path)}` : active.toolName;
    const body =
      active.toolName === "Bash" ? String(i.command ?? "")
      : active.toolName === "Write" ? String(i.content ?? "").split("\n").slice(0, 12).map((l) => green("+ " + l)).join("\n")
      : active.toolName === "Edit" ? [...String(i.old_string ?? "").split("\n").slice(0, 6).map((l) => red("- " + l)), ...String(i.new_string ?? "").split("\n").slice(0, 6).map((l) => green("+ " + l))].join("\n")
      : JSON.stringify(i, null, 2);
    const bar = blue("│");
    const lines = [
      "",
      blue("╭─ ") + bold(blue(title)) + (queue.length > 1 ? dim(`  (1 of ${queue.length} waiting)`) : ""),
      ...body.split("\n").slice(0, 16).map((l) => `${bar}   ${l}`),
      `${bar} ${dim(`${active.phase} wants to run this`)}`,
      `${bar} Do you want to proceed?`,
      `${bar} ${blue("❯")} 1. Yes`,
      ...(active.rule ? [`${bar}   2. Yes, and don't ask again for ${bold(pretty(active.rule))} this run`] : []),
      `${bar}   ${active.rule ? 3 : 2}. No, and tell the agent what to do differently`,
      blue("╰─ ") + dim(canPrompt ? "press a number (y = yes, n = no)" + (opts.uiUrl ? " · or answer in the web UI" : "") : `waiting — answer in the web UI: ${opts.uiUrl ?? ""}`),
    ];
    write(lines.join("\n"));
  }
  function finish(decision: "allow" | "deny", reason?: string, remember?: boolean) {
    if (!active) return;
    const req = active;
    active = null;
    typing = null;
    queue.shift();
    bus.resolveApproval(req.requestId, { decision, reason, remember });
    showPrompt();
  }
  function onKey(str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) {
    if (key.ctrl && key.name === "c") {
      input.setRawMode?.(false);
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (!active) return;
    if (typing !== null) {
      if (key.name === "return" || key.name === "enter") {
        out.write("\n");
        finish("deny", typing.trim() || undefined);
      } else if (key.name === "escape") {
        typing = null;
        write(dim("  (cancelled — still waiting)"));
      } else if (key.name === "backspace") {
        if (typing.length) { typing = typing.slice(0, -1); out.write("\b \b"); }
      } else if (str && !key.ctrl && str >= " ") {
        typing += str;
        out.write(str);
      }
      return;
    }
    const noKey = active.rule ? "3" : "2";
    if (str === "1" || str === "y") finish("allow");
    else if (str === "2" && active.rule) finish("allow", undefined, true);
    else if (str === noKey || str === "n" || key.name === "escape") {
      typing = "";
      out.write(dim("  What should it do instead? (Enter to send, Esc to cancel) ") + "\n  > ");
    }
  }
  if (canPrompt) {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKey);
    (input as Readable).resume?.();
  }

  // --- the transcript
  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case "run-start":
        startedAt = Date.parse(ev.ts);
        write(`\n${orange("✻")} ${bold("agent-loop")} ${dim("·")} ${ev.task}`);
        break;
      case "phase-start":
        write(`\n${orange(bold(ev.phase))}${ev.attempt > 1 ? dim(` · attempt ${ev.attempt}`) : ""} ${dim("─".repeat(Math.max(4, width() - ev.phase.length - 16)))}`);
        break;
      case "assistant-text": {
        const text = ev.text.replace(/```json[\s\S]*?```\s*$/, "").trim();
        if (!text) break;
        const lines = text.split("\n").filter((l) => l.trim());
        write(`⏺ ${lines.slice(0, 4).join("\n  ")}${lines.length > 4 ? dim(`\n  … +${lines.length - 4} lines`) : ""}`);
        break;
      }
      case "tool-call": {
        const l = label(ev.toolName, ev.toolInput as Record<string, unknown>);
        tools.set(ev.toolUseId, l);
        write(`${orange("⏺")} ${bold(l.split("(")[0])}${dim("(" + l.split("(").slice(1).join("("))}`);
        break;
      }
      case "tool-result": {
        const lines = String(ev.summary ?? "").replace(/\s+$/, "").split("\n");
        const first = short(lines[0] || "(no output)", width() - 8);
        const more = lines.length > 1 ? dim(` … +${lines.length - 1} lines`) : "";
        write(`  ${dim("⎿")}  ${ev.isError ? red(first) : dim(first)}${more}`);
        break;
      }
      case "approval-request":
        if (queue.some((q) => q.requestId === ev.requestId)) break;
        queue.push(ev);
        if (active) write(dim(`  (${queue.length - 1} more approval${queue.length > 2 ? "s" : ""} waiting after this one)`));
        showPrompt();
        break;
      case "approval-resolved": {
        const wasActive = active?.requestId === ev.requestId;
        const idx = queue.findIndex((q) => q.requestId === ev.requestId);
        if (idx >= 0) queue.splice(idx, 1);
        if (wasActive) { active = null; typing = null; }
        write(`  ${dim("⎿")}  ${ev.decision === "allow" ? green("approved") : red("rejected")}${ev.rememberedRule ? dim(` · won't ask again for ${pretty(ev.rememberedRule)}`) : ""}${ev.reason ? dim(` · ${short(ev.reason, 80)}`) : ""}`);
        showPrompt();
        break;
      }
      case "approval-auto-allowed":
        write(`  ${dim("⎿")}  ${dim(/read-only/.test(ev.rule) ? "read-only · no prompt" : `allowed by ${pretty(ev.rule)}`)}`);
        break;
      case "phase-end": {
        const v = ev.verdict;
        const ok = v.outcome === "pass";
        write(`${ok ? green("✓") : red("✗")} ${bold(`${ev.phase}: ${v.headline}`)} ${dim(v.headline === "Skipped" ? "(skipped)" : `(${v.outcome})`)}`);
        for (const f of v.blockingFindings ?? []) write(`  ${red("• " + short(f, width() - 6))}`);
        break;
      }
      case "overseer-decision":
        write(`${blue("◆")} Overseer → ${bold(blue(ev.decision.action.toUpperCase()))}${ev.decision.repairTarget ? " " + ev.decision.repairTarget : ""} ${dim("· " + short(ev.decision.reasoning, width() - 30))}`);
        break;
      case "usage":
        cost += ev.costUsd;
        break;
      case "trusted-decision-recorded":
        write(`${green("✓")} Decision recorded ${dim("· " + short(ev.text, 90))}`);
        break;
      case "browser-artifact-created":
        if (ev.kind === "video") write(`${yellow("▶")} Browser session recorded ${dim("· " + ev.path)}`);
        break;
      case "run-end": {
        const secs = Math.round((Date.parse(ev.ts) - startedAt) / 1000);
        const col = ev.status === "done" ? green : red;
        write(`\n${col("●")} Run ${col(bold(ev.status))} ${dim(`· ${secs}s · $${cost.toFixed(2)}`)}`);
        break;
      }
    }
  };
  bus.on("event", onEvent);

  return {
    detach() {
      bus.off("event", onEvent);
      if (canPrompt) {
        input.off?.("keypress", onKey);
        input.setRawMode?.(false);
        (input as Readable).pause?.();
      }
    },
  };
}
