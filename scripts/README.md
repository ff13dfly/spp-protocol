# scripts/ — SPP reconstruction tooling

Node (ESM) tooling for the inverse pipeline: floor plan image → room layout →
SPP cell topology → render. The geometry half is deterministic
(`spp-lib/spp-inverse-engine.js`); the only hard part is **perception** — turning
a floor plan image into a room-layout grid + doors + windows.

## Setup

```bash
cd scripts
npm install            # installs `canvas` (used for sealing doors + rendering)
```

## API keys (environment variables — never hardcode)

```bash
export QWEN_API_KEY=sk-...          # or DASHSCOPE_API_KEY — Qwen-VL (Dashscope)
export ANTHROPIC_API_KEY=sk-ant-... # Claude (vision perception)
```

## Scripts

| Script | What it does | Keys |
| ------ | ------------ | ---- |
| `reconstruct-mock.mjs` | Reconstruct `assets/mock-floorplan.png` with **no API** — perception read by hand (Claude vision), wall topology by the genuine engine. Writes top-down + isometric 3D renders and a cells JSON. This is the data embedded in `inverse-demo-v2` mock mode. | none |
| `reconstruct-real.mjs` | Same approach on the real colored render `assets/floorplan.png` (approximate — furnished image). | none |
| `compare-llm.mjs [image]` | Run the full room-list → grid → feature pipeline on one image with **Qwen vs Claude** side by side; writes `compare-result.json`. Skips whichever provider's key is unset. | `QWEN_API_KEY` and/or `ANTHROPIC_API_KEY` |
| `run-new-pipeline.mjs` | Door-first pipeline (detect doors → seal openings → room list → grid fill → map doors) against the floor plan via Qwen; writes `pipeline-result.json` + `sealed-floorplan.png`. | `QWEN_API_KEY` |

```bash
node scripts/reconstruct-mock.mjs       # → scripts/recon-out/mock-{topdown,iso}.png, mock-cells.json
node scripts/reconstruct-real.mjs       # → scripts/recon-out/real-topdown.png, real-cells.json
node scripts/compare-llm.mjs ../spp-examples/inverse-demo-v2/assets/mock-floorplan.png
node scripts/run-new-pipeline.mjs
```

## Why this matters

The external vision API (Qwen-VL) was the bottleneck: it hallucinates the room
layout (e.g. inventing rooms that aren't in the image), and the deterministic
engine faithfully renders whatever grid it's given — garbage in, garbage out.
A stronger vision model (Claude, via `ANTHROPIC_API_KEY`) produces a correct
layout; `reconstruct-*.mjs` demonstrate the perception step done by hand and fed
straight into the real engine.

Generated outputs (`recon-out/`, `*-result.json`, `sealed-floorplan.png`) are
gitignored — regenerate them with the scripts above.
