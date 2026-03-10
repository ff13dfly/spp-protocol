# SPP Library (spp-lib)

Shared JavaScript modules implementing the **String Particle Protocol** data model and its AI-driven inverse modeling pipeline.

## Modules

| Module | Description |
|---|---|
| [`spp-core.js`](./spp-core.js) | SPP data model — face constants, option registry, cell operations |
| [`spp-inverse-engine.js`](./spp-inverse-engine.js) | Inverse modeling engine — 2D floor plan → 3D reconstruction pipeline |

---

## spp-core.js

Universal SPP building blocks shared by all applications (demos, tools, services).

### Exports

| Export | Description |
|---|---|
| `FACE`, `OPPOSITE_FACE`, `FACE_DIRECTION`, `FACE_NAMES` | Face index constants (6-face cube topology) |
| `OPTION_TYPE`, `OPTION_REGISTRY` | Open/Wall type system and the face option lookup table |
| `OPEN_IDS`, `WALL_IDS`, `ALL_IDS` | Grouped option ID arrays |
| `getResolvedOption(cell, faceIndex)` | Read a collapsed face's option ID |
| `cycleOption(cell, faceIndex)` | Cycle a face through all registered options |
| `createCell(x, y, z)` | Create a new cell with all options available (superposition) |
| `collapseCell(cell)` | Resolve each face to a single random option (collapse) |
| `createChunk()` | Create an empty `ParticleChunk` container |

---

## spp-inverse-engine.js

An independent reconstruction engine that transforms 2D floor plan images into SPP `ParticleCell` data structures. The LLM interaction is injected via a `llmProvider` callback — no dependency on specific AI services.

### Quick Start

```javascript
import { SPPInverseEngine } from './spp-inverse-engine.js';

const engine = new SPPInverseEngine({
  llmProvider: async (imageDataUrl, systemPrompt, userText) => {
    // Implement your LLM call here (Qwen, Gemini, OpenAI, local, etc.)
    const response = await fetch('https://your-llm-api/...', { ... });
    return await response.text();
  },
  onStatus: (msg) => console.log(msg),
});

const result = await engine.reconstruct(imageDataUrl);
// result = { gridInfo, cells, description, gridX, gridZ }
```

### Pipeline Architecture

The reconstruction is broken into a **Two-step AI Analysis** prompting strategy, followed by deterministic geometric processing.

#### Step 1: Floor Plan Bounding Box Detection & Grid Layout

* **Input**: A high-resolution floor plan image.
* **Process**: Sends an image-text prompt to the VLM requesting:
  * **A. Building Envelope Detection (Crop)**: Extracts the normalized bounding box of the actual architectural layout, filtering out margins and annotations.
  * **B. Spatial Grid Subdivision & Room Mapping**: Splits the indoor layout into a fine-grained grid (e.g., 8×10, adaptable 4×4 to 12×12), labeling each cell with a topological ID (`Space_A`, `Space_B`, `null` for exterior).
  * **C. Fractional Wall Snapping (Area-Majority Rule)**: When a wall falls inside a cell, the cell is assigned to the room occupying ≥50% of its area. Walls snap to the nearest grid boundary.

#### Step 2: Face Classification

* **Input**: Grid dimensions and spatial layout from Step 1.
* **Process**: A secondary prompt assigns Face Option IDs to each cell's 4 horizontal faces:
  * `0`: **Open** — same-room adjacency
  * `2`: **Door** — doorway between different rooms
  * `10`: **Wall** — solid wall
  * `20`: **Window** — exterior wall with window
* **Why Two Steps**: Splitting topology from face classification dramatically reduces VLM hallucinations by forcing the model to establish spatial relationships before assigning attributes.

### Advanced Architecture: Geometry-First Anti-Hallucination

To prevent "Semantic Coupling Hallucinations" (e.g., a VLM forcing a large bathroom to be split because its prior knowledge says bathrooms must be small), the architecture embraces a **Geometry-First** principle:

1. **Phase 1: Pure Geometric Topology** — The VLM assigns meaningless IDs (`Space_A`, `Space_B`) to enclosed regions, focusing 100% on physical lines without bias from room function.
2. **Phase 2: Binary Face Generation** — Strict binary logic: same-room → Open (0), different-room → Wall (10). This constructs a perfectly sealed 3D whitebox shell.
3. **Phase 3: Semantic Inference & Feature Piercing** — After geometry is locked, doors/windows are treated as Spatial POIs extracted by a secondary prompt or CV step.
4. **Phase 4: Common Sense Reconstruction** — Architectural common sense "pierces" features into binary walls (e.g., bedrooms must have doors; exterior habitable walls get windows).
5. **Phase 5: Sub-grid Refinement via Regression Testing** — An analysis-by-synthesis loop: render the 3D model top-down, diff against the source image with lightweight CV, and nudge wall positions for pixel-perfect alignment.

### Inverse-Specific Exports

| Export | Description |
|---|---|
| `SPPInverseEngine` | Main orchestrator class with `llmProvider` injection |
| `RecursiveGridManager` | Tree-based recursive grid for local refinement |
| `generateCellsFromLayout(layout, gridX, gridZ, doors)` | Generate cells from a 2D layout matrix |
| `optimizeGrid(baseLayout, scale, mods, doors)` | Multi-resolution grid optimization |
| `expandScaledCells(cells)` | Flatten scaled cells into sub-cell arrays |
| `parseAIResponse(text)` | Parse and validate LLM JSON responses |

### Recursive Data Structure

Instead of a flat 2D array, the engine supports a hierarchical **Tree-based Grid System** where any `ParticleCell` can contain its own `subGrid`:

```json
{
  "position": [2, 0, 3],
  "room": "Space_B",
  "faceOptions": [ [10], [10], [], [], [10], [10] ],
  "subGrid": {
    "gridX": 4, "gridZ": 4,
    "cells": [
      { "position": [0, 0, 0], "room": "Space_B_1", "faceOptions": [...] }
    ]
  }
}
```

This achieves infinite local precision without inflating the global grid. The `RecursiveGridManager` handles prompt context extraction, result integration, and recursive flattening for rendering.

### Mesh Optimization: Greedy Meshing

Before 3D rendering, continuous walls are merged via a linear scan:
* Adjacent cells sharing the same wall face merge into a single continuous wall object.
* **Benefits**: Zero Z-fighting, seamless UV mapping, cleaner CSG piercing for doors/windows.

### Future Vision: Endless Layout Generation

The decoupled architecture enables a powerful commercial scenario:
1. **One-Time VLM Processing** (~1,000–3,500 tokens): Establish the rigid 3D shell.
2. **Endless Text-Only Layout Refresh** (~150 tokens): Send cheap prompts to a smaller LLM for furniture placement within the immutable structural sandbox.
