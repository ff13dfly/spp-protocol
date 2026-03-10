# SPP Inverse Modeling Demo

A browser-based demonstration of reverse-engineering 2D floor plan images into editable 3D spatial structures using the [SPP Inverse Engine](../../spp-lib/README.md).

## What It Does

1. Upload a 2D floor plan image
2. AI analyzes the image in two steps (grid layout → face classification)
3. A 3D reconstructed blueprint appears in the viewport
4. Click any wall to cycle it through different face options (wall → door → window → open → ...)
5. Export the result as a standard SPP JSON file

## How to Run

1. Host a local HTTP server in the project root:
   ```bash
   # From the spp-protocol root directory
   npx serve .
   ```
   Or use VSCode Live Server. Opening `index.html` directly also works in most browsers.

2. Enter your API Key in the left panel. Supported providers:
   - **Alibaba DashScope** — Qwen-VL series (千问)
   - **Google GenAI** — Gemini series

3. Drag and drop any 2D floor plan image, then click **✨ Analyze & Reconstruct**.

4. Wait for the two-step AI generation to complete.

### Mock Mode

Append `?mock` to the URL to bypass AI and see a pre-built reconstruction with hardcoded data:
```
http://localhost:3000/spp-examples/inverse-demo/?mock
```

## Architecture

This demo is a thin UI layer on top of the shared [spp-lib](../../spp-lib/) modules:

| File | Role |
|---|---|
| `index.html` | Layout, styles, and Three.js importmap |
| `js/main.js` | UI logic, Three.js scene, image upload, click-to-edit, mock data |
| `js/prompt.js` | LLM API callers (Qwen, Gemini) and `createEngine()` factory |
| `js/renderer-3d.js` | Three.js wall/floor rendering from `ParticleCell` data |
| `js/grid-overlay.js` | 2D canvas grid overlay on the uploaded floor plan |
| `js/particle.js` | Re-exports from [`spp-lib/spp-core.js`](../../spp-lib/spp-core.js) |
| `js/parser.js` | Re-exports from [`spp-lib/spp-inverse-engine.js`](../../spp-lib/spp-inverse-engine.js) |

For the reconstruction pipeline's technical architecture (two-step prompting, anti-hallucination design, recursive grid, greedy meshing), see the [SPP Library README](../../spp-lib/README.md).

## Interactive Editing

- **Click any wall** in the 3D viewport to cycle its face option
- **Grid density controls** (±) adjust the overlay grid on the uploaded image
- **Top-down view** button toggles an orthographic camera angle (mock mode)
- **Export JSON** saves the current state as a standard SPP architecture file

## Output Format

The exported JSON follows the SPP `ParticleChunk` structure:

```json
{
  "cells": [
    {
      "position": [x, 0, z],
      "size": [1, 1, 1],
      "faceStates": 63,
      "faceOptions": [[10], [0], [], [], [20], [10]]
    }
  ]
}
```
