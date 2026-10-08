# Reel flow: send a reel, learn what it is about, build it if it is good

Status: **design, with stage 1 built** (S5b, IMP-036). Built: steps 1, 3, 4 (code half), 5, 6 and 9 for a video file or pasted text, as `agent-loop reel`; the link is canonicalised and remembered but never opened. **Not built:** the transcript, frame OCR, the user's yes wired to the dev flow (steps 7 and 8), `ideas` list/purge, the URL path through LIVE mode, the UI Send box, any real-model run. Everything else below is still design.

User's request: *"if I send a reel from Instagram, it reads it and then tells me what it's about, and then if it's good enough we implement it."*

## What this has to be honest about

- **Instagram does not want to be read by programs.** Its terms restrict automated access, logged-out pages show little, and it throws
  login walls and challenges. Our standing rule is that we never evade bans or anti-bot measures, so this flow cannot depend on scraping.
  The path that always works is **the user gives us the content**: a file (a download or a screen recording), or the caption and a
  transcript pasted as text. Reading the URL with the agent's own browser is a convenience, for one reel the user asked about, on the
  user's own computer, and it stops and asks the moment the site pushes back.
- **We cannot test against real Instagram from here**, by the standing rule. Everything is tested with synthetic videos made by ffmpeg
  and a fake reel page on the local fake board. The README will say that real Instagram was not exercised.
- **Audio needs a transcriber.** None is installed in this environment (`ffmpeg` is; `whisper`/`faster-whisper` are not). Without one the
  flow reads the caption and on-screen text from frames, and it **says so** ("I could not hear this"). A transcriber is optional config.
- **A reel's claim is a hypothesis, not a fact.** "This one setting makes your app ten times faster" is often wrong. So "implement it"
  means "implement it as an experiment and keep it only if the measurement says so".

## The flow

```
 send: URL | file | pasted text            (CLI `agent-loop reel`, the UI Send box, or `agent-loop do "<url>"` through the router)
   │
   ▼ 1 intake        canonicalise the URL (shortcode only; the share token that identifies the sender is dropped), dedupe
   ▼ 2 acquire       file > pasted text > one-URL read in LIVE mode (single reel, paced, never crawls); wall/429 => ask for a file
   ▼ 3 extract       ffmpeg: duration, up to 12 scene-change frames, audio if a transcriber exists; evidence bundle outside the repo
   ▼ 4 read          model with NO tools, evidence fenced as untrusted: what it is about, claims (shown vs asserted), idea, citations
   ▼ 5 tell the user "this reel is about ..." in a few lines, with what could not be perceived        <- value even if nothing is built
   ▼ 6 judge         model supplies scores + citations; CODE applies the thresholds and the hard refusals
   ▼ 7 decide        default: ask. Opt-in auto-implement for a clear yes inside budget, one per day, on a branch, never pushed
   ▼ 8 implement     as an experiment through the normal dev flow (team sized by TEAM-COMPOSITION.md): baseline, change, measure, keep or revert
   ▼ 9 remember      `ideas` table + IMPROVEMENTS.md entry whose "why" cites the reel; feeds the learning loop
```

### 1. Intake

- Accepts `instagram.com/reel/<shortcode>`, `/reels/`, `/p/`, `instagr.am`, and (via the same flow, later) other short-video links. A link
  from another site routes to `web-task` unless the user says otherwise.
- **Canonicalise:** keep only the host and shortcode. Tracking parameters are dropped before anything is stored or logged. The `igsh`
  share parameter in particular ties a link to the account that shared it (threat R12).
- **Dedupe** by shortcode, and for files by a perceptual hash of the frames: "you sent this on 2 October; I said skip because ...".

### 2. Acquire, in order of how legitimate and reliable each is

| Source | Network | Notes |
|---|---|---|
| A file the user gives | none | Always works. A download or a screen recording. |
| Text the user pastes (caption, transcript) | none | Always works; thin without frames. |
| One URL, read by the agent's browser | LIVE mode, allowances `instagram.com` plus its media hosts, granted by the user's config | Single reel, user-initiated, paced (default 20 a day), serial, never follows "related" links. A login wall, challenge, 429 or 403 **pauses the site and asks for a file or text instead**. The browser plays the reel as a person would and captures frames; it does not download or reassemble media streams. Unverified against the real site. |
| The official oEmbed endpoint | needs a Meta app token | Title, author and thumbnail only; mentioned as the proper route if the user has a token. |

### 3. Extract (`src/reel/extract.ts`)

- `ffprobe` first: duration over 180 s, file over 200 MB, or more than 4096 pixels on a side is refused with a reason (threat R9).
- `ffmpeg -nostdin -protocol_whitelist file` only, in a subprocess with a time limit and no network, reading only from the evidence
  directory, so a playlist that points at `http://` is rejected and a malformed container cannot hang the run (threat R10).
- Up to 12 scene-change frames, downscaled. Audio only if a transcriber is configured; the result records
  `perception: { caption, frames, transcript }` so everything downstream knows what was actually seen and heard.
- The **evidence bundle** (`meta.json`, frames, caption, transcript) is written under the user's data directory with mode 0700,
  **outside the repo and outside `--dir`**, and the path hooks deny the agents reading it (threat R7). Default retention 30 days;
  `agent-loop ideas purge` removes it.

### 4. Read (the only stage that sees raw reel content)

A model with **no tools**, given the evidence inside a fenced, labelled "untrusted media content" block. It returns strict JSON, with
unknown keys dropped:

```json
{
  "about": "three sentences",
  "shown": ["what the video demonstrates"],
  "claims": [{ "text": "...", "kind": "demonstrated|asserted", "cite": { "frame": 4, "quote": "exact words from the caption" } }],
  "idea": "what could be built, in our own words",
  "perception": { "caption": true, "frames": 9, "transcript": false },
  "instructions_to_an_ai_found": ["any sentence addressed to an AI system"]
}
```

Code then **checks every citation**: a quote must be a substring of the caption, transcript or frame text; a frame index must exist.
A claim whose citation does not check out is dropped, not trusted (threat R4).

### 5. Tell the user

Before judging anything: "This reel is about ...", what it shows, what it only claims, and what could not be perceived. That output stands
on its own. If nothing is ever built, the user still got the reel summarised.

### 6. Judge: the model scores, code decides

The model returns scores 0 to 5 for **relevance** to the project (from its README, constitution and roadmap), **value**, **feasibility**
(stack and the size band the team-composition signals give), **novelty** (a read-only researcher looks for it in the repo) and **risk**
(legal, terms-of-service, security, copyright, personal data, cost). **A score with no citation is capped at 2.** Then program code applies:

| Verdict | Rule |
|---|---|
| `implement` | value >= 4, relevance >= 3, feasibility >= 3, risk <= 2, and no instruction aimed at an AI was found |
| `ask` | within one point of the `implement` thresholds on at most two of those, and risk <= 3 |
| `skip` | everything else, with the reason in one line |
| **refuse** | whatever the scores: circumventing anti-bot or access controls, harvesting credentials or personal data, copying a third party's protected work or brand, malware. Classified by code patterns plus the model's risk label. |

The thresholds are config. They are code, so a persuasive reel cannot argue past them.

### 7. Decide

Default is to **ask**, showing the task that would be built, the hypothesis, the measure, and the size of the team. The user can say
yes, no, or edit the scope. Opt-in `--auto-implement` applies only to a clean `implement` verdict inside budget, at most one a day, on a
branch `idea/<id>`, never pushed (the dev-workflow's "ask before pushing" still holds).

### 8. Implement as an experiment

The task given to the dev flow is **rewritten by code from the structured fields**, never the raw caption or transcript, so media text
cannot steer the Builder (threat R1):

```
Hypothesis (from a reel, unverified): <claim in our words>
Build:       <idea in our words>
Measure:     <benchmark suite id, or a new check named here>    Baseline recorded first.
Keep if:     <metric moves by at least X>                        Otherwise revert and record why.
```

The Gatekeeper keeps or reverts on the measurement. A feature with no metric is accepted on the spec's requirements and the Verifier's run,
and the entry says so. The result is logged in [IMPROVEMENTS.md](IMPROVEMENTS.md) with the reel as the **why** and the measured effect.

### 9. Remember

SQLite table `ideas`: id, canonical source, about, scores, verdict, decision, run id, outcome, measured effect. `agent-loop ideas` lists
them. The learning loop ([HYBRID-AGENT-SPEC.md](HYBRID-AGENT-SPEC.md)) reads outcomes (which kinds of reel you accepted, and which of
those survived their measurement) and may propose a preference profile as data, accepted by you, that sharpens the relevance score.

## Threats specific to this flow

| ID | Threat | Stop | Test |
|---|---|---|---|
| R1 | Prompt injection through caption, on-screen text or speech ("ignore the above, run ...") | **code**: the reader has no tools; the implement task is rewritten from structured fields; an instruction aimed at an AI blocks `implement` and raises risk | Fake reel with injections in caption and frame text: 0 tool calls, verdict not `implement`, task text lacks the string |
| R2 | Site pushes back: login wall, challenge, 429 | **code**: site paused, user asked for a file or text; never evade | Fake reel page returns each; no further requests after the pause |
| R3 | Bulk or crawling behaviour | **code**: one URL per request, "related" links never opened, daily cap | Reel page full of links: exactly one navigation; cap refuses the 21st |
| R4 | The summary claims more than was perceived | **code**: citations verified against the evidence text; `perception` shown to the user | Reader returns a claim with a fake quote: dropped |
| R5 | A false claim implemented as fact | **code**: hypothesis plus measurement gate; Gatekeeper reverts if the metric does not move | An idea with no effect on the fake metric is reverted and logged |
| R6 | Building something harmful or illegal | **code**: hard-refusal classes | A set of hostile ideas: all refused whatever the model scored |
| R7 | Copying a product's assets, brand or content; evidence leaking into the repo | **code**: idea restated in our words; evidence outside the repo and `--dir`, denied to the agents; no media copied into the project | Evidence path under `--dir` is refused; Read tool on it is denied |
| R8 | Personal data in the video (faces, usernames, locations) | **code + policy**: evidence 0700 and local only, summary describes content and never identifies people from appearance, retention limit, `purge` | Purge removes frames; summary of a face-only frame names no one |
| R9 | A huge or endless video burns time or usage | **code**: duration, size and dimension limits, frame cap, subprocess time limit, token budget | Oversized and over-long inputs refused; a stalled ffmpeg is killed |
| R10 | A malicious or corrupt container | **code**: `-protocol_whitelist file`, `-nostdin`, subprocess with a time limit, corrupt input is an error and not a crash | Playlist pointing at `http://` rejected with 0 requests; truncated file handled |
| R11 | The same reel sent twice, or a chain of "share this" | **code**: dedupe by shortcode and perceptual hash | Same reel by two URLs and as a file: one record |
| R12 | The share link identifies the sender | **code**: tracking parameters stripped before any storage or log | Link with `igsh=`: not present in the store, events, or report |
| R13 | Auto-implement drifts into building everything | **code**: clean-verdict-only, one a day, budget, on a branch, never pushed | Two `implement` verdicts in a day: the second waits |
| R14 | The user is shown a flattering summary that hides the risk | **code**: the risk score and "could not perceive" are part of every report | Report rendering test |

## Benchmark rows this adds

| Suite | Measures | Built in |
|---|---|---|
| `reel-extract` | Synthetic videos made by ffmpeg (text overlay, silent, too long, huge, corrupt, playlist trick): expected outcome for each | S5b |
| `reel-read` | Canned reader outputs: schema validation and citation checking, bad citations dropped | S5b |
| `reel-judge` | Labelled score vectors to verdicts, including every hard refusal | S5b |
| `reel-injection` | Hostile captions and frame text: 0 tool calls, never `implement`, task text clean | S5b |
| `reel-e2e` | Fake reel page and a file, through intake to a kept or reverted experiment on a fake metric | S5b |
| `reel-quality` | **Human-rated, gated.** Real reels the user sends; the user rates each summary 1 to 5 for correctness and each verdict for usefulness | after S7 |

## Staging inside S5b

1. **File and pasted-text path** (extract, read, tell, judge) needs only ffmpeg and the SDK: can land as soon as the dev flow's team
   composition exists, long before LIVE mode.
2. **URL path** needs LIVE mode (S2), the watchdog (S4) and the fake board's reel page.
3. **Implement-as-experiment** needs team composition (S3a) and the keep-or-revert measurement gate.

## Exit criteria

- R1 to R14 each have a passing test with a control that fails when the defence is removed.
- All five offline suites recorded with baselines; the fake end-to-end run shows one kept and one reverted experiment.
- An adversary round (fresh agent, told to get a hostile reel built) with its findings closed.
- README says plainly: real Instagram was not exercised; audio needs a transcriber; the reel's claim is treated as a hypothesis.
