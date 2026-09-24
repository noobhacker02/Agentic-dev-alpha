/**
 * Stage 1 of the Cloud Browser Agent proposal (docs/BROWSER-AGENT.md): a Playwright-backed tool
 * adapter exposed to phases as a real in-process MCP server (createSdkMcpServer + tool() -- the
 * SDK's actual custom-tool mechanism, confirmed against node_modules/@anthropic-ai/claude-agent-sdk
 * /sdk.d.ts rather than assumed). Custom tools surface as `mcp__<server>__<tool>` in `tool_name`,
 * the same field PreToolUse hooks already read for built-ins, so createSafetyHook/createPathScopeHook
 * /createSensitiveFileHook/createApprovalHook need no new plumbing to see these calls.
 *
 * Deliberately local-only for Stage 1: `open` accepts only http://localhost or http://127.0.0.1
 * URLs. A real domain allowlist is Stage 3 (cloud pilot) territory, not this pass.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { EventBus } from "./bus.js";

/** The installed playwright-core version doesn't reliably match the pre-installed browser's
 * revision number in every environment, so chromium.launch()'s own resolution can miss it even
 * when a real Chromium is present. Only used as a fallback after the normal launch fails. */
function findSandboxPreinstalledChrome(): string | undefined {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  if (!dir) return undefined;
  const exe = join(root, dir, "chrome-linux", "chrome");
  return existsSync(exe) ? exe : undefined;
}

async function launchBrowser(): Promise<Browser> {
  const explicit = process.env.AGENT_LOOP_CHROME_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit, headless: true });
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const fallback = findSandboxPreinstalledChrome();
    if (!fallback) {
      throw new Error(
        `Could not launch Chromium (${err instanceof Error ? err.message : String(err)}). ` +
          `Install a browser for playwright-core (npx playwright install chromium) or set AGENT_LOOP_CHROME_PATH ` +
          `to an existing Chrome/Chromium binary.`
      );
    }
    return chromium.launch({ executablePath: fallback, headless: true });
  }
}

interface BrowserSession {
  browserSessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Owns browser lifecycle and maps runId -> browserSessionId -> live Playwright objects, so the
 * same open tab survives across agent-loop's separate per-phase query() calls (each phase is its
 * own SDK session; the browser context is not). See docs/BROWSER-AGENT.md section 2.
 */
export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();

  async getOrCreate(runId: string, bus: EventBus): Promise<BrowserSession> {
    const existing = this.sessions.get(runId);
    if (existing) return existing;
    const browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    const session: BrowserSession = { browserSessionId: randomUUID(), browser, context, page };
    this.sessions.set(runId, session);
    bus.emitEvent({
      type: "browser-session-started",
      runId,
      browserSessionId: session.browserSessionId,
      ts: new Date().toISOString(),
    });
    return session;
  }

  get(runId: string): BrowserSession | undefined {
    return this.sessions.get(runId);
  }

  /** Always call this, even after a worker error -- an unclosed Chromium process and temp profile
   * leaking past the run is exactly the failure mode docs/BROWSER-AGENT.md's MVP boundary rules out. */
  async close(runId: string, bus: EventBus, status: "completed" | "failed" | "interrupted"): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    try {
      await session.browser.close();
    } finally {
      bus.emitEvent({
        type: "browser-session-ended",
        runId,
        browserSessionId: session.browserSessionId,
        status,
        ts: new Date().toISOString(),
      });
    }
  }

  async closeAll(bus: EventBus): Promise<void> {
    for (const runId of [...this.sessions.keys()]) await this.close(runId, bus, "interrupted");
  }
}

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** A short, human-legible summary of interactive elements -- not a full accessibility tree, but
 * enough for "accessible locators first" (docs/BROWSER-AGENT.md section 2) without the added
 * engineering of a recursive a11y-tree serializer this stage doesn't need yet. */
async function describeInteractiveElements(page: Page): Promise<string> {
  const handles = await page.locator("a, button, input, select, textarea, [role]").all();
  const lines: string[] = [];
  for (const el of handles.slice(0, 40)) {
    const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "?");
    const role = await el.getAttribute("role").catch(() => null);
    const id = await el.getAttribute("id").catch(() => null);
    const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
    const text = ariaLabel ?? (await el.innerText().catch(() => "")).trim().slice(0, 60);
    lines.push(`<${tag}${role ? ` role="${role}"` : ""}${id ? ` id="${id}"` : ""}> ${text}`.trim());
  }
  return lines.join("\n");
}

export interface CreateBrowserToolServerOptions {
  runId: string;
  bus: EventBus;
  sessions: BrowserSessionManager;
  /** Where screenshots get written -- always outside the agent's --dir, alongside the rest of the
   * run's audit artifacts, never in SQLite (docs/BROWSER-AGENT.md section 3). */
  artifactDir: string;
}

/** Wraps a tool handler to always emit browser-action-started/completed with timing, regardless of
 * which specific tool ran or whether it threw -- one place for this instead of repeating it seven times. */
function instrumented(
  opts: CreateBrowserToolServerOptions,
  toolName: string,
  input: unknown,
  fn: () => Promise<{ text: string; extra?: Record<string, unknown> }>
) {
  return (async () => {
    const actionId = randomUUID();
    const startedAt = Date.now();
    opts.bus.emitEvent({
      type: "browser-action-started",
      runId: opts.runId,
      browserSessionId: opts.sessions.get(opts.runId)?.browserSessionId ?? "",
      actionId,
      toolName,
      input,
      ts: new Date().toISOString(),
    });
    let result: { text: string; extra?: Record<string, unknown> };
    let isError = false;
    try {
      result = await fn();
    } catch (err) {
      isError = true;
      result = { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    opts.bus.emitEvent({
      type: "browser-action-completed",
      runId: opts.runId,
      browserSessionId: opts.sessions.get(opts.runId)?.browserSessionId ?? "",
      actionId,
      toolName,
      result: result.text.slice(0, 2000),
      isError,
      durationMs: Date.now() - startedAt,
      ts: new Date().toISOString(),
    });
    return { result, isError };
  })();
}

/** The seven browser tool definitions, keyed by name. Exported (as __testHandlers) so tests can
 * call a handler directly without standing up a real MCP client/transport -- the same reasoning
 * test/safety-net.mjs and test/approval-server.mjs already apply to hooks and the server. */
export function __testHandlers(opts: CreateBrowserToolServerOptions) {
  const { runId, bus, sessions } = opts;

  const open = tool(
    "open",
    "Navigate the browser to a URL. Stage 1 only allows http://localhost or http://127.0.0.1 URLs.",
    { url: z.string().describe("The URL to navigate to") },
    async ({ url }) => {
      const { result, isError } = await instrumented(opts, "open", { url }, async () => {
        if (!LOCAL_URL_RE.test(url)) {
          throw new Error(`Refused: only http://localhost or http://127.0.0.1 URLs are allowed in this stage, got: ${url}`);
        }
        const session = await sessions.getOrCreate(runId, bus);
        await session.page.goto(url, { waitUntil: "domcontentloaded" });
        return { text: `Opened ${url}. Title: ${await session.page.title()}` };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const inspect = tool(
    "inspect",
    "Get the current page's URL, title, visible text, and a summary of interactive elements.",
    {},
    async () => {
      const { result, isError } = await instrumented(opts, "inspect", {}, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        const url = session.page.url();
        const title = await session.page.title();
        const text = (await session.page.locator("body").innerText().catch(() => "")).slice(0, 3000);
        const elements = await describeInteractiveElements(session.page);
        return {
          text: `URL: ${url}\nTitle: ${title}\n\nVisible text (truncated):\n${text}\n\nInteractive elements (up to 40):\n${elements}`,
        };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const click = tool(
    "click",
    "Click an element matched by a CSS selector.",
    { selector: z.string().describe("CSS selector of the element to click") },
    async ({ selector }) => {
      const { result, isError } = await instrumented(opts, "click", { selector }, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        await session.page.locator(selector).click({ timeout: 5000 });
        return { text: `Clicked ${selector}` };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const fill = tool(
    "fill",
    "Fill a form field matched by a CSS selector with a value.",
    { selector: z.string().describe("CSS selector of the input/textarea"), value: z.string() },
    async ({ selector, value }) => {
      const { result, isError } = await instrumented(opts, "fill", { selector, value }, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        await session.page.locator(selector).fill(value, { timeout: 5000 });
        return { text: `Filled ${selector}` };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const press = tool(
    "press",
    "Press a keyboard key, optionally focusing a selector first.",
    {
      key: z.string().describe('Key name, e.g. "Enter", "Tab", "ArrowDown"'),
      selector: z.string().optional().describe("CSS selector to focus before pressing"),
    },
    async ({ key, selector }) => {
      const { result, isError } = await instrumented(opts, "press", { key, selector }, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        if (selector) await session.page.locator(selector).focus({ timeout: 5000 });
        await session.page.keyboard.press(key);
        return { text: `Pressed ${key}${selector ? ` on ${selector}` : ""}` };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const wait = tool(
    "wait",
    "Wait for a selector to appear, or for a fixed timeout if no selector is given.",
    {
      selector: z.string().optional(),
      timeoutMs: z.number().int().positive().max(30000).optional(),
    },
    async ({ selector, timeoutMs }) => {
      const { result, isError } = await instrumented(opts, "wait", { selector, timeoutMs }, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        const timeout = timeoutMs ?? 5000;
        if (selector) await session.page.locator(selector).waitFor({ timeout });
        else await session.page.waitForTimeout(timeout);
        return { text: selector ? `${selector} appeared` : `waited ${timeout}ms` };
      });
      return { content: [{ type: "text", text: result.text }], isError };
    }
  );

  const screenshot = tool(
    "screenshot",
    "Capture a screenshot of the current page. Returns the image and saves it as an artifact.",
    {},
    async () => {
      let pngBase64 = "";
      const { result, isError } = await instrumented(opts, "screenshot", {}, async () => {
        const session = sessions.get(runId);
        if (!session) throw new Error("No open browser session -- call open first.");
        const buf = await session.page.screenshot({ type: "png" });
        pngBase64 = buf.toString("base64");
        mkdirSync(opts.artifactDir, { recursive: true });
        const fileName = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        const filePath = join(opts.artifactDir, fileName);
        writeFileSync(filePath, buf);
        const url = session.page.url();
        const title = await session.page.title();
        bus.emitEvent({
          type: "browser-snapshot",
          runId,
          browserSessionId: session.browserSessionId,
          url,
          title,
          screenshotPath: filePath,
          ts: new Date().toISOString(),
        });
        bus.emitEvent({
          type: "browser-artifact-created",
          runId,
          browserSessionId: session.browserSessionId,
          kind: "screenshot",
          path: filePath,
          ts: new Date().toISOString(),
        });
        return { text: `Screenshot saved to ${filePath}`, extra: { filePath } };
      });
      return {
        content: [
          { type: "text", text: result.text },
          ...(pngBase64 ? [{ type: "image" as const, data: pngBase64, mimeType: "image/png" }] : []),
        ],
        isError,
      };
    }
  );

  return { open, inspect, click, fill, press, wait, screenshot };
}

export function createBrowserToolServer(opts: CreateBrowserToolServerOptions): McpSdkServerConfigWithInstance {
  const { open, inspect, click, fill, press, wait, screenshot } = __testHandlers(opts);
  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    tools: [open, inspect, click, fill, press, wait, screenshot],
  });
}
