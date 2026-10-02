# Is any of this actually useful?

Written after being asked, bluntly, whether what was built is useful or "just BS". Every claim here is either a number measured
for this page or a pointer to where it was measured. Where there is no evidence, it says so.

## The short answer

- **The governance is real and earns its place**: the approval prompt, the safety net, the audit trail, and (as of this round) a way to
  stop a run and cap what it spends. Each of these has a measured before/after or a reproduced bug behind it.
- **The five-agent pipeline does not, on the evidence we have, write better code than one Claude session**, and it costs far more.
  That is the uncomfortable result, and it is in the repo's own earlier stress report, not new.
- **The cat, the dinosaur, the cursors, the sound and the jokes are delight, not utility.** They are cheap to turn off (one switch),
  but they are not why anyone would use this, and they are the largest share of recent work.

## The core question: does the pipeline produce better code?

Measured on 2026-09-24 (`docs/STRESS-TEST-REPORT.md`), same task, graded by 4,040 hidden checks the agents never saw:

| | Score | Cost | Time |
|---|---|---|---|
| Plain Claude, no skill | 4,037 / 4,040 | **$0.08** | 23 s |
| agent-loop, 5 phases + Overseer | 4,039 / 4,040 | **$1.41** | 6.3 min |

Two more checks passed for about 17x the money and 16x the time, and the pipeline still marked a run "GO" that had a real bug
(`"XIV\n"` raised the wrong exception). Where it did hold up: a planted instruction inside a file was flagged and not obeyed, and a bug
fix in an existing repo scored 15/15. It also has a documented hole: a contradictory task ended `done`.

**What that means.** If the goal is "write correct code cheaply", one session wins. If the goal is "let an agent work on my machine
while I stay in control of what it may touch, and keep a record", that is what this is for, and the pipeline's phases are mostly the
frame that record hangs on. Nobody has measured whether the phases catch bugs on a task big enough to need them (several files, an
ambiguous requirement). That experiment is below; it has not been run.

## Feature by feature

Verdicts: **earns its place** (solves a real problem, with evidence), **small but real**, **delight** (no function beyond
enjoyment), **unproven**.

| Feature | Problem it solves | Evidence | Price | Verdict |
|---|---|---|---|---|
| Approval prompt, one at a time, showing exactly what would run; "don't ask again" rules; read-only commands don't ask | An agent on your machine needs a human gate that is usable, not a wall of clicks | Real runs went from 53 prompts to 13 for the same task, same hidden-grader score (`docs/UI.md`; one run each, an earlier one measured 16) | none | **earns its place** |
| Safety net, path scope, sensitive-file check, browser localhost-only, desktop one-window fences | An agent following hostile text in a page, file or window | 24 of 27 dangerous shell commands got through before the fix; real exploits against each threat in `docs/DESKTOP-AGENT.md`; a planted instruction was refused in a real run | complexity | **earns its place** |
| Audit database, lineage tree, saved report | Knowing afterwards what happened and who did it | The lineage view caught a real bug (a refused `.env` write listed as a changed file) by disagreeing with another panel | 71 KB of sprites in every report (see below) | **earns its place** |
| Stop, and `--max-cost` | A run that costs more than you meant, or that you want to end | Ctrl-C used to leave the run "running" forever with no report (reproduced, fixed); the Stop button was tested end to end this round (189 ms) | the cap is checked after a phase attempt or Overseer call, so **one long step can pass it** by that step's cost; it is not a hard ceiling | **earns its place**, with that limit |
| Several runs at once against one audit folder | Two terminals | This round: it crashed with `database is locked` and left a run "running" with no report (5 of 5 runs affected). Fixed with a busy timeout; 12 at once now pass | none | a bug fixed, now **earns its place** |
| A database that fails mid-run no longer kills the run | A full disk or a lock | Tested with a database that throws from the first phase on: the run finishes, the page and report are whole, and it says so once | none | **small but real** |
| Replay speed, bounded history with an honest "N events dropped" note, idle CPU | A long run, and a tab left open while a prompt waits | 6,000 events took 29.6 s, now 1.4 s; a waiting prompt cost 4.2% of a core, now 0.3% (15x) because a glow animated `box-shadow` | none | **earns its place** (these were bugs) |
| `agent-loop doctor` | "Why won't desktop control start?" | Tells apart no display / dead display / locked / missing, wrong or silent driver; found that "No display" should not block someone not using desktop | none | **small but real** |
| "still running 31s", "no result" | A hung command looks like a calm spinner | Tested with a faked clock, and with the page's clock 7 minutes off | none | **small but real** |
| Browser notification when a prompt waits | Missing a prompt while in another tab | Tested with a stand-in for the browser's permission; **never with a person** | none | **unproven** |
| Cat, pixel icons, cursors | Friendliness; the cat's one functional claim is "you notice a waiting prompt sooner" | That claim has **never been measured with a person**. The prompt is already pinned to the bottom, the tab title counts what waits, the favicon changes, and notifications exist. If you are looking at the page you see the prompt anyway | ~2.5% of a core while a run is working (headless software rendering; a GPU is less), 71 KB in every saved report, seven test suites to keep it honest | **delight** |
| Offline dinosaur | Something to do while the server is down | None needed | it only exists while disconnected | **delight** |
| Sound | The same | Measured audible and not clipping; **nobody has listened to it** | off by default, no audio engine until you turn it on | **delight, unheard** |
| The jokes and `insights` roast | Entertainment; plus real tips | The counts it reports are real and tested; the tips are accurate ("a rule lasts one run"). **The grade is a formula I made up and never validated against anything**; it now says so where it prints. A quick approval is not always careless (the fiftieth `npm test` prompt is rational at one second) | none while off | **delight**, with real numbers underneath |
| Plain mode | Anyone who wants none of the above | Tested live, remembered, server default, saved report | exists only because the cartoons do | **small but real** |

## What the cartoons actually cost (measured)

Chromium, headless, software rendering, 10-second windows (`test/ui-idle-cost.mjs` prints these):

| State | Cartoons on | Plain |
|---|---|---|
| A run working | ~2.5% of a core | ~0.3% |
| A prompt waiting | ~0.3% | ~0.3% |
| Size added to every saved report | 71 KB | 0 |

While a prompt waits (which can be hours) the cat's hop runs on the compositor and costs nothing measurable. While a run works, the
cat's dance steps a sprite strip, which repaints. Small, and not the kind of thing that justifies calling the project bloated; also not
free, and not zero-value to remove if you leave a tab open all day.

## Things this round found by stressing it, that "it works" had hidden

All fixed, each with a test that fails without the fix:

1. Ctrl-C left a run "running" forever (earlier in the round).
2. Five runs sharing one audit folder crashed with `database is locked`, leaving a run "running" with no report.
3. A prompt waiting made the page repaint every frame (4.2% of a core) for as long as it waited.
4. A long run's reloaded page and saved report silently showed only the tail while the README said "full transcript"; they now say
   how many events were dropped. Also, trimming could cut between a tool call and its result (a headerless card at the top) and could,
   in principle, drop a request still waiting for an answer.
5. Runs killed or crashed stay "running" in the database forever, and `insights` treated them as maybe-alive. It now says what
   "running" may mean and counts the ones abandoned for 12+ hours as a habit, with a tip about Ctrl-C.
6. `insights` printed every unused rule, thousands of lines on a big history; it now stops at ten.
7. Docs that no longer matched the code (suite counts), and a size claim that was true but incomplete (the 50 KB of PNGs travel as
   71 KB of base64 in every report).

Scale: `insights` on 3,000 runs and 636,000 events takes 2.5 s. A reloaded page on a 40,000-event run loads in 1.6 s and holds
about 3,000 tool cards.

## The experiment that would answer the real question

Not run, because it costs real money:

- 4 tasks that are bigger than a one-file function: a multi-file feature, an ambiguous requirement, a bug fix that needs reading
  existing code, a refactor with tests that must keep passing.
- Two conditions each: one plain Claude session, and the pipeline with `--max-cost` set.
- Graded by hidden tests the agents never see, cost and time recorded, each run once (so treat the result as a hint, not a
  proof; running each three times would triple the cost).
- Rough cost: about $1.50 to $4 per pipeline run and about $0.10 to $0.50 per plain run, so **roughly $8 to $20 in total**.

If the pipeline wins there, the phases earn their cost. If it ties again, the honest description of agent-loop is "a safe, auditable
harness around one capable agent", and the phases should become optional or opt-in.
