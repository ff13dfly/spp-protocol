# scripts/eval — perception eval harness

Measures how well a vision model turns a floor plan **image → room-layout grid**
(the step that bottlenecks reconstruction), scored against a **hand-labeled
ground truth**. This is the "model vs truth" upgrade of `../compare-llm.mjs`
(which only compared model vs model).

## Run

```bash
# offline — validate the scorer, no API calls, no keys needed
node scripts/eval/run-eval.mjs --selftest

# live — runs every model whose key is set, against every sample
ANTHROPIC_API_KEY=...  GEMINI_API_KEY=...  QWEN_API_KEY=...  node scripts/eval/run-eval.mjs
node scripts/eval/run-eval.mjs --repeats=3   # average N runs/model (variance; see note below)
node scripts/eval/run-eval.mjs --strict      # "Bedroom 1" ≠ "Bedroom" (default is lenient)
```

**Scoring is lenient by default** — `"Bedroom 1"`/`"Bedroom 2"` collapse to `"Bedroom"`, because the room-list prompt explicitly asks models to number bedrooms; strict mode would penalize a correct answer. A small synonym map (`WC`→`Bathroom`, `Lounge`→`Living Room`, …) lives in `score.mjs`; extend it for your label vocabulary.

**Determinism / variance.** Qwen and Gemini are pinned to `temperature=0.1`; **Claude (opus-4-8) rejects `temperature`** (the API 400s), so it can't be pinned — use `--repeats=N` to average runs and read the reported `±IoU` stdev rather than trusting a single run.

Keys (any subset; absent → that model is skipped):
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`|`GOOGLE_API_KEY`, `QWEN_API_KEY`|`DASHSCOPE_API_KEY`.
Pin exact model ids with `CLAUDE_MODEL` / `GEMINI_MODEL` / `QWEN_MODEL`
(e.g. `GEMINI_MODEL=gemini-2.5-pro` — check Google's current model list for the right id).

## Metrics (all resolution-independent)

The model picks its own grid size, so we resample both layouts to a common 48×48
grid before comparing:

| Metric | Meaning |
| ------ | ------- |
| `roomF1` | Did it find the right **set** of rooms (precision/recall/F1)? **This is what catches hallucinated/missed rooms.** |
| `builtAreaAcc` | Correct cells **inside the building footprint** (excludes exterior). The most honest single accuracy number. |
| `layoutAcc` | Correct cells over the **whole** grid, exterior included. ⚠️ Inflated on sparse plans — a model that only gets the outline right can score 50%+. Read it alongside `builtAreaAcc`. |
| `meanIoU` | Mean per-room IoU over **ground-truth rooms only** — spatial placement quality. Does **not** itself penalize hallucinations (roomF1/layoutAcc do). |
| `footprintIoU` | IoU of the built area (non-null mask) — did it get the building outline? |

> Both layouts are resampled to a common 48×48 grid (point-sampling) before comparison, so different model grid resolutions are comparable; this adds ≤~2% quantization noise on narrow grids, which cancels in relative model comparison.

## Adding samples

Drop a `samples/<name>.truth.json`:

```json
{
  "name": "...",
  "image": "<path relative to this truth file>",
  "imageWidth": 640, "imageHeight": 640,
  "gridX": 7, "gridZ": 6,
  "rooms": ["Kitchen", "..."],
  "layout": [["Kitchen", null, "..."], ...]   // gridZ rows × gridX cols; null = outside
}
```

`doors`/`windows` are optional metadata (not scored yet — face-level door/window
P/R against a different-resolution grid is future work).

> ⚠️ **The harness only discriminates as well as its samples.** The seed sample
> (`mock-floorplan`) is a clean synthetic line drawing — strong models near-ace it.
> Real differentiation needs **labeled real floor plans** (furnished/colored
> renders, where models actually diverge). Grow the set there.

Generated reports land in `results/` (gitignored).
