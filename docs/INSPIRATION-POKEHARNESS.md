# What we looked at, what we borrowed, and what we didn't

A friend's repo, [`mavericksxx/pokemon-harness`](https://github.com/mavericksxx/pokemon-harness)
("Pokéharness"), was reviewed for ideas worth bringing into agent-loop's own approval UI —
specifically while building a "live" browser panel (a continuously-updating view instead of a
single post-hoc screenshot) and a snapshot gallery. This document records what it actually does,
what's genuinely good about it, and — honestly — what does and doesn't transfer, so the borrowing is
traceable rather than a vague "inspired by."

Pokéharness itself is not run, forked as a build target, or depended on by agent-loop in any way.
Nothing here is copied code; it's a design idea, reimplemented from scratch in agent-loop's own
stack and visual language (no Pokémon theming — agent-loop keeps its existing dark-terminal /
light-desktop look, the same one used throughout `ui/index.html`).

## What Pokéharness is

A local Electron + React + Pixi.js desktop app that visualizes a user's running coding-agent CLI
sessions (`claude`, `codex`, `cursor-agent`) as Pokémon-style animated walkers in a pixel-art garden.
It spawns each agent CLI through a PTY (`node-pty`) and has to *infer* what the agent is doing from
either the CLI's own lifecycle hooks (when available, e.g. real Claude Code hooks) or by scraping
raw terminal text with regexes (for CLIs with no hook support) — then reflects that as walker
behavior: walks to a station and shows the tool in a speech bubble ("working"), walks to a signpost
with a pulsing "!" ("blocked"), or wanders ("idle"). Sessions "evolve" the longer they spend
"working," using real Pokémon evolution chains.

## What's genuinely well done

- **A dual-authority status model with an explicit handoff contract.** Real Claude Code hooks are
  authoritative when present; a PTY-text-scraping parser is the fallback for CLIs without hooks, or
  during a documented 60-second hook-silence window. The two sources are prevented from fighting
  mid-tool-call by an explicit latch, not just "whichever fires last wins."
- **A dirty-flag render loop, not a naive re-render-on-every-event.** Instead of repainting the Pixi
  canvas on every state change, a persistent `ticker` loop checks a cheap "did anything actually
  change" flag each frame and only repaints then, with a periodic heartbeat as a safety net. This is
  the one idea below that's actually relevant to agent-loop — see next section.
- **Evolution timing decoupled from wall-clock and from render rate**, accumulated only during
  genuine "working" time and checked on a throttled interval rather than every frame.
- **Real production hardening for a hobby project**: a documented WebGL context-loss crash, caught
  live and fixed with instrumentation plus a capped auto-rebuild; a documented async-subagent race
  (a tool dispatch reporting "done" before a subagent genuinely finishes) fixed with a backstop
  timer, not an assumption.
- **Honest attribution discipline** — its own `ATTRIBUTION.md` lists file-by-file what's ported vs.
  rewritten from other MIT-licensed projects, which is exactly the standard this document is trying
  to meet for agent-loop borrowing from it.

## What's weak

No automated tests anywhere in the repo — CI only checks that it compiles and packages, not that any
behavior is correct, which is a real gap for a codebase this stateful (PTY timing races, hook
handoff, evolution thresholds). The regex-scraping fallback is admittedly brittle: its own comments
describe multiple already-shipped false-positive fixes against real CLI output drift. State is split
across a Zustand store and imperative Pixi objects, bridged by convention and comments rather than
structure. None of this is a knock specific to a hobby project moving fast — it's just why "port the
code" was never on the table here, only "port the idea, re-verified against agent-loop's own tests."

## What is — and isn't — transferable, and why

agent-loop's dashboard already gets structured, typed events over a WebSocket directly from the
orchestrator process. It never has to *guess* what's happening from opaque terminal text the way
Pokéharness does for non-hook-supporting CLIs — so the actual PTY-scraping heuristics (the regexes,
the idle timers, the hook/regex latch) have nothing to offer; they exist purely to compensate for not
having structured data, which agent-loop already has. Being honest about that upfront matters more
than forcing a comparison.

One idea does transfer, independent of data source: **don't let incoming events drive rendering
one-for-one; run a continuous, independently-ticking "is this still alive" state that's cheap to
repaint and only does real work when something changed.** Pokéharness needs this to animate sprites
at 60fps; agent-loop's dashboard needs the same underlying principle for a much smaller reason —
making a WebSocket-driven UI feel alive *between* discrete events (a "still working" breathing
indicator, a browser panel that visibly signals it's live) rather than looking frozen until the next
message arrives.

**How it was actually implemented here**: not as a JS animation-frame loop (agent-loop's UI is a
normal DOM dashboard, not a canvas game) but as CSS `animation`s — the browser's own compositor
already runs these independently of JS execution or WebSocket events, which is the DOM-native
equivalent of Pixi's manual ticker for this exact purpose, not a corner cut. Concretely, in
`ui/index.html`:
- `.live-dot` on the browser panel's header — a small pulsing dot, shown only while a browser session
  is actually active, distinct in meaning (and less urgent-looking) than the existing accent-colored
  glow already used for "an approval needs you."
- `.step[data-state="active"] .icon` — the active phase's stepper icon breathes slowly, signaling
  "still working" continuously rather than looking static between tool-call events.
- `.shot-main`'s brief flash animation on a new snapshot, and the new snapshot **gallery** itself
  (every screenshot this run, not just the latest, with a "jump to live" control when pinned to an
  older one) — inspired by the general "a live view needs a history, not just a single frame" shape
  of the problem, built entirely against agent-loop's own event model (`browser-snapshot` events),
  with no equivalent in Pokéharness's own code (it doesn't keep a screenshot history at all).

**Explicitly not borrowed, and why**: the battle system's event-coalescing ("combine rapid hits into
one visual beat instead of queuing replays") does not fit agent-loop's transcript — a dev tool's
tool-call log needs full fidelity as an audit trail; suppressing or merging rapid real tool calls
would hide information a developer needs, not just visual noise the way repeated game-hit animations
are. The hook/regex latch, the PTY forensics, and the entire Tiled/Pixi sprite pipeline solve problems
specific to scraping an opaque terminal or rendering pixel-art sprites, neither of which applies to a
structured-event web dashboard.

## What came of it

[`REFERENCE-AUDIT.md`](REFERENCE-AUDIT.md) goes back through this document and the two research notes idea by idea: where each
one lives in the code, which test would fail without it, what was not built and why, and what the audit found by running things.

## Forking it

Actually forking the repo on GitHub (rather than this read-only local clone used for review) was
requested but not completed automatically — creating a fork is a visible action under this account
that needed explicit approval the session's permission system didn't grant on its own. Say the word
and it can be done directly.
