# Screenshots index

Real screenshots of how things actually look, kept in the repo so they're reviewable by anyone
looking at the project — not just described in prose. Every image here comes from an actual run
against real code (the browser tools, the approval UI, etc.), never mocked up.

Convention: one subfolder per feature/component, files numbered in the order they were taken within
that folder, a one-line description added to this index whenever an image is added or replaced.

## browser-agent/

Screenshots from the Browser Agent tools (`src/browser-tools.ts`).

| File | What it shows |
| --- | --- |
| `01-open-fill-click-screenshot.png` | Stage 1 demo: `open` → `fill` → `click` → `screenshot` driven directly against a real local demo page, captured by the real `screenshot` tool handler (not a mockup). |

## approval-ui/

Screenshots of the live approval UI (`ui/index.html`, served by `src/server.ts`).

_(none yet — added as the dashboard evolves, e.g. Stage 2's browser panel)_
