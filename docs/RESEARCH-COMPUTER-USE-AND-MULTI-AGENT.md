# Computer-use and multi-agent coordination: what two real projects actually do

Two public projects were reviewed (read-only local clones, not run or depended on) for concrete
ideas ahead of possibly extending agent-loop's own browser automation toward real desktop/OS-level
control, and to answer a direct question about how multi-agent coordination ("agents talking to each
other") actually works in a shipping system: [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
and [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Nothing here has been implemented in
agent-loop yet — this is the research and gap analysis those two follow-up tasks call for before any
code gets written, consistent with how every other capability surface this session touched
(browser-tools.ts's sandbox-escape fix, the approval-rule gaps) was handled: verify first, build
carefully second.

## Computer-use: both projects wrap the same third-party engine

Neither hermes-agent nor OpenClaw implements AT-SPI accessibility-tree walking, X11/Wayland input
dispatch, or window-compositor targeting itself. Both speak MCP (over stdio) to the same external,
open-source Rust binary — `trycua/cua-driver` — and build their own orchestration layer on top:
approval gating, action risk-classification, and targeting/staleness checks.

**Hermes-agent's layer** (`tools/computer_use/`) is genuinely careful in places: a "Bot Desktop
lease" re-checks its authorization epoch *both before and after* dispatching an action, specifically
to catch a human taking manual control mid-action — a real continuous-check pattern, not a one-time
gate. It also distinguishes "the session is locked" from "no display" from "the driver itself is
unhealthy" with real diagnostics, rather than one generic error.

**OpenClaw's layer** (`extensions/cua-computer`) fixes its authorization ceiling once, outside model
reach, with an explicit comment that the model can't select a session or widen it later. Actions are
risk-classified before dispatch (a `HIGH_RISK_FAMILIES` vs. `OBSERVATION_ACTIONS` split). The
"off by default" gate is real enforced config, not just a UI toggle: on non-macOS platforms the
whole provider skips registering entirely unless a config flag is explicitly set to `true` — a
plugin manifest saying "enabled by default" does not, on its own, turn this on. Every action must
re-present the exact frame/display identity from the most recent screenshot, so a display change
fails closed instead of silently retargeting the same coordinates on a different screen.

**Neither has moved past "the system prompt says don't"** for the one risk that matters most for a
tool like this: a hostile or compromised window/page telling the agent to do something the human
never asked for. Both reduce prompt-injection defense to an instruction the model is asked to honor,
not a structural boundary. That is exactly the class of gap agent-loop's own earlier
`browser-tools.ts` fix (moving a localhost-only check from "checked once at `open()`" to "enforced
continuously via a network-layer route handler") already proved isn't good enough by design alone.
**This is the one thing agent-loop would have to solve itself, structurally, before shipping any
real desktop-level capability** — neither reference project is a model to copy here.

### What this means for agent-loop, concretely

If agent-loop ever adds desktop control, the architecturally consistent path is a second
`createSdkMcpServer` proxying to a spawned `cua-driver` process — agent-loop's existing `PreToolUse`
hooks already key off `mcp__<server>__<tool>` tool names and would see it for free, no hook changes
needed. OpenClaw's integration shape (a typed, risk-classified action surface sitting in front of an
MCP-spoken driver, with the authorization ceiling fixed outside model reach) maps onto agent-loop's
existing hook-gated MCP-tool pattern more directly than hermes-agent's version, which is entangled
with hermes's own CLI/session internals agent-loop would have to reimplement rather than reuse.

Whether to actually build this is a separate, bigger decision than whether it's feasible: agent-loop's
Verifier/Gatekeeper model currently reasons about a *bounded* artifact (a repo diff, test output).
Real desktop control expands the blast radius to every window on the machine, not just a
`--dir`-scoped project — that's a genuine safety-model change, not an incremental feature, and
deserves its own explicit go/no-go from a human before any of it gets built.

## Multi-agent coordination: OpenClaw's base repo actually has this

The assumption going in was that OpenClaw's multi-agent feature lived entirely in a separate,
uncloned companion repo (`openclaw-agents`). That turned out to be wrong, and it's worth saying so
plainly rather than stretching the pokemon-harness-review pattern of "doesn't transfer" onto
something that does: **openclaw/openclaw's own base repo has real, working multi-agent
infrastructure**, and it directly answers the "how do multiple agents talk to each other" question:

- **Hierarchical subagent spawn/await**, with configurable limits (max concurrent children, max
  children per parent, max spawn depth), backed by a registry tracking parent/child completion.
- **"Swarm"**: the actual concurrent fan-out primitive. A coordinating script spawns N isolated child
  sessions in parallel (bounded per-group), drains their results through a bounded long-poll `wait`
  call, and gets back structured, schema-validated output from each. Children never see each other's
  results, and a child can never open its own approval prompt — only the coordinating script does.
- **A documented "team preset"** (coordinator + researcher + writer + reviewer) — but its own docs
  are explicit that task delegation between them is *prompt guidance interpreted by the model*, not
  a scheduler enforcing anything.

**What OpenClaw does *not* have, and says so in its own docs**: automatic duplicate-work detection
or shared mutable state between peer agents. Avoiding duplicate work across concurrent groups is
listed as a manually-written coordinator convention the operator has to design and prompt for, with
an explicit warning that "a coordinator without lane contracts just coordinates chaos." There is no
built-in shared notebook, discovery log, or automatic dedup mechanism in a real, shipping multi-agent
system doing exactly the kind of coordination this was asked about.

### What this means for the "shared discovery/work-registry" idea

This is the concrete precedent the open design question (a shared "notebook" so an orchestrator can
see what every agent has learned or is working on, and avoid duplicate work) needed. The real-world
answer, from a system that actually does this in production, is: **that problem is solved by
architecture (bounded, isolated groups; a single coordinator that owns dispatch and never lets
children see each other; structured outputs the coordinator reads), not by giving agents a shared
mutable log to read and write.** A shared notebook two concurrent agents could both write to
reintroduces exactly the race conditions and inconsistent-state problems structured, coordinator-
mediated fan-out is designed to avoid.

This also reframes why the idea didn't obviously fit agent-loop to begin with: agent-loop's phases
run strictly sequentially today (`pipeline.ts` awaits each phase fully before starting the next), so
there is never more than one active phase to coordinate between — the premise of "avoid duplicate
work between concurrently-running agents" doesn't apply to the current architecture at all. If
agent-loop ever wants OpenClaw-style concurrent fan-out (e.g., Verifier and a documentation pass
running in parallel), the swarm pattern — a bounded set of isolated children reporting structured
results back to one coordinator, never to each other — is the model worth adopting, not a shared
"decisions/discoveries" file multiple phases write into at once.

## Verdict

Neither project needs to be forked or depended on. The concrete, reusable findings are architectural,
not code to import: (1) delegate desktop-level input/accessibility work to an existing driver rather
than hand-rolling AT-SPI/UIA, if that capability is ever added, with the authorization ceiling fixed
outside the model's reach the way OpenClaw does it; (2) if agent-loop ever needs multiple agents
coordinating, the production-proven shape is bounded, coordinator-mediated fan-out with structured
outputs — not a shared mutable notebook; and (3) prompt-injection defense for on-screen or
window-level content is an unsolved problem in both reference projects, so it can't be borrowed —
agent-loop would need to design a structural (not just instructional) containment itself, the same
way it already did for the browser tool's localhost restriction.
