# SPP Inverse Modeling Demo V2 — Implementation Plan

## 1. Overview

Built on top of `spp-lib` (`spp-core.js` + `spp-inverse-engine.js`), this demo implements a full SPP inverse reconstruction pipeline:

1. **Full-screen Canvas** — Three.js fills the entire viewport; all interaction happens inside the 3D scene
2. **Multi-depth visualization** — coarse grid → refinement layers stacked by depth, each depth colored differently
3. **AI-driven recursive refinement** — Phase 5 top-view regression loop; AI auto-detects divergent regions and refines them; manual box-select is the fallback
4. **Floor plan overlay** — the source image is projected as a semi-transparent 3D ground texture for visual alignment

---

## 2. Architecture

### UI Layout — Full-screen Canvas + Floating Controls

```
┌───────────────────────────────────────────────┐
│ [📎 Upload] [▶ Analyze] [T Top]  ← toolbar    │
│ ┌ Toast ──────────────────┐                   │
│ └─────────────────────────┘                   │
│                                               │
│           Three.js Full-screen Canvas         │
│                                               │
│    Layer 0: Floor plan texture (ground)       │
│    Layer 1: Coarse grid depth=0 (brick-red)   │
│    Layer 2: Refinement depth=1 (blue-grey)    │
│    Layer 3: 2nd refinement depth=2 (teal)     │
│                                               │
│          [🔍 Refine Selection (3)]  ← on sel  │
│                         ── Opacity ▬▬▬◉── │
└───────────────────────────────────────────────┘
```

### HTML Structure (minimal)

```html
<body>
  <canvas id="viewport"></canvas>

  <!-- Floating controls, absolute-positioned -->
  <div id="toolbar">       <!-- top-left: upload + analyze + top-view toggle -->
  <div id="toast">         <!-- top-left: status toast (auto-dismiss) -->
  <div id="action-bar">    <!-- bottom-center: action buttons after selection -->
  <div id="opacity-slider"><!-- bottom-right: floor texture opacity -->
  <div id="api-modal">     <!-- modal: API key entry, stored in localStorage -->
</body>
```

### Data Flow (full 5-phase pipeline)

```
Drag floor plan onto Canvas
  ↓
Apply floor texture (Layer 0)
  ↓
Phase 1: AI detects coarse grid N×M + semantic room names
Phase 2: AI generates binary topology (Wall/Open only)
Phase 3: AI detects door/window positions → [{x, z, face, optionId}, ...]
Phase 4: Deterministic piercing → write into faceOptions
  ↓
Render Layer 1 (depth=0, brick-red)
  ↓
Phase 5: Top-view regression (auto-loop driving local Phase 1-4 recursion)
  → Render orthographic top-view screenshot
  → Pixel diff: original image vs top-view, locate divergent cells
  → For each divergent region, run local Phase 1-4:
      Local Phase 1: crop sub-image → AI re-grids local area
      Local Phase 2: AI re-generates binary topology for region
      Local Phase 3: AI re-detects doors/windows in region
      Local Phase 4: deterministic pierce into faceOptions
  → Integrate back into main grid, re-render
  → Repeat until no divergence or depth limit reached
  ↓
User dissatisfied → manual box-select → triggers same refinement (fallback)
  ↓
Shortcut E → export SPP JSON
```

---

## 3. File Structure

```
inverse-demo-v2/
├── implementation-plan.md  ← this file
├── index.html              ← minimal HTML (canvas + floating controls)
├── js/
│   ├── main.js             ← orchestrator (events, AI calls, state)
│   ├── renderer.js         ← multi-depth Three.js renderer (LayerRenderer)
│   ├── regression.js       ← top-view screenshot + pixel diff + region grouping
│   ├── selection.js        ← manual multi-select (Ctrl+Click + box-select)
│   ├── floor-texture.js    ← floor plan projected as ground texture (UV + opacity)
│   └── shim.js             ← spp-lib re-export
├── css/
│   └── style.css           ← full-screen canvas + floating control styles
└── assets/
    └── mock-floorplan.png
```

---

## 4. Core Module Design

### 4.1 Multi-depth Renderer (`renderer.js`)

Renders by `depth` group; each layer has a distinct color and slight vertical offset:

| depth | Wall color | Floor color | Wall height | Y offset |
|-------|-----------|------------|-------------|---------|
| 0 (coarse) | `#d4886b` brick-red | `#e8e8ef` light-grey | 2.8 | 0 |
| 1 (1st refinement) | `#6b8fd4` blue-grey | `#e0e8f0` pale-blue | 2.6 | 0.08 |
| 2 (2nd refinement) | `#6bd49b` teal | `#e0f0e8` pale-green | 2.4 | 0.16 |

Cells that have been refined → walls rendered semi-transparent (`opacity: 0.15`), floor hidden.

### 4.2 Top-view Regression Module (`regression.js`)

Core of Phase 5 — drives the auto-refinement loop:

```
renderTopView()                  ← switch to ortho camera, capture canvas as image A
compareWithSource(A, B, crop)    ← pixel diff per cell, return list of divergent cells
cropToCells(B, crop, cells)      ← crop divergent region from source image B
extractConstraints(cells)        ← extract Open/Wall connectivity for the 4 boundary edges
groupDivergentRegions(cells)     ← BFS flood-fill adjacent divergent cells into regions
```

**Image alignment:** Phase 1 returns `crop: { x, y, w, h }` (normalized) defining the floor plan's bounding box in the source image. Before comparison, the rendered image A is cropped/resized to match the crop region of source image B — otherwise boundary pixels produce false divergence.

**Divergence threshold:** per-cell average color diff across the crop region; cells above threshold are flagged.

**Screenshot:** call `canvas.toDataURL()` after `renderer.render()` with a temporary orthographic camera (scene unchanged).

### 4.3 Manual Selection (`selection.js`)

Fallback when the user is unsatisfied with auto-refinement results:

- **Single click** — select / deselect cell
- **Ctrl/Cmd + click** — additive multi-select
- **Left-drag** — box-select
- **Selection highlight** — blue floor tint
- After selection, bottom action bar shows `"🔍 Refine Selection (N cells)"`

#### 4.3.1 Mouse Button Assignment (vs OrbitControls)

| Action | Condition | Behavior |
|--------|-----------|----------|
| Scene rotate | Right-drag | OrbitControls rotate |
| Scene pan | Middle-drag or Right+Shift | OrbitControls pan |
| Box-select | Left-drag (no modifier) | Draw selection rect |
| Click-select | Left click (no movement) | Toggle cell |

Implementation: `controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }` — left button fully owned by `selection.js`.

### 4.4 Floor Texture (`floor-texture.js`)

- Load source image with `TextureLoader`, crop to Phase 1 `cropInfo` region
- Project as a flat `PlaneGeometry` covering the full grid extent
- `renderOrder = 2`, `depthTest = false` — renders as overlay on top of cell floors
- Opacity adjustable at runtime via bottom-right slider (0–100%)

### 4.5 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `T` | Toggle top-view / perspective |
| `V` | View JSON panel |
| `E` | Export SPP JSON (recursive tree) |
| `Escape` | Clear selection (or close JSON panel) |
| `Delete` | Remove refinement layer from selected cells |

---

## 5. Full Reconstruction Pipeline (Phase 1–5)

### 5.1 Phase 1 — Coarse Grid Detection

**AI task:** detect floor plan bounding box + overlay grid + assign semantic room names.

**Output:**
```json
{
  "crop": { "x": 0.08, "y": 0.10, "w": 0.84, "h": 0.82 },
  "gridX": 5, "gridZ": 4,
  "layout": [
    ["Kitchen", "Kitchen", "Hallway", "Bathroom", "Bathroom"],
    ["Living Room", "Living Room", "Hallway", "Bedroom", "Bedroom"]
  ]
}
```

### 5.2 Phase 2 — Binary Topology

**AI task:** classify each cell's four horizontal faces: same room → `[0]` Open; different room or exterior → `[10]` Wall. No doors or windows yet.

### 5.3 Phase 3 — Door/Window Detection

**AI task:** given source image + Phase 2 wall-face list, return annotation array `[{ x, z, face, optionId }]`.

`optionId`: `1` (arch door), `2` (rect door), `20` (window). Rule: only annotate currently-Wall faces; doors require annotations on both adjacent cells.

### 5.4 Phase 4 — Feature Piercing (deterministic)

Iterate Phase 3 annotations, replace `faceOptions[face]=[10]` with the target optionId. Only replace Wall(10) faces — never touch Open(0) faces.

### 5.5 Phase 5 — Top-view Regression Loop

Phase 5 is not a standalone refinement step — it is a **closed-loop controller** that drives local Phase 1-4 repeatedly until convergence.

**Global (Phase 1-4) vs Local (Phase 5 triggered):**

| | Global (Phase 1-4) | Local (Phase 5) |
|--|--|--|
| Phase 1 input | Full floor plan image | Cropped divergent region |
| Phase 1 constraints | None | 4-edge Open/Wall connectivity |
| Phase 2-4 | Same | Same, scoped to region |
| Integration | Build root grid | `integratePerCellRefinement()` back into main grid |

**Execution flow:**

```
① Render orthographic top-view screenshot (image A)
   ↓
② Pixel diff: source image B vs image A
   → sample per cell, collect cells above threshold → divergent set
   ↓
③ For each divergent region (adjacent cells merged via BFS), run local Phase 1-4:
   Local Phase 1: crop sub-image → AI re-grids (rooms + semantic names)
   Local Phase 2: AI re-generates binary topology
   Local Phase 3: AI re-detects doors/windows
   Local Phase 4: deterministic pierce
   → integratePerCellRefinement(region.cells, localOutput)
   ↓
④ Re-render, loop back to ①
   → no new divergence or depth limit reached → stop
```

After auto-refinement, the user can manually box-select unsatisfied regions to trigger additional refinement.

### 5.6 Full Call Chain

```
── Global initial reconstruction ─────────────────────────────────────
Phase 1: analyzeGridSize(imageDataUrl)                  → gridInfo
Phase 2: classifyFaces(imageDataUrl, gridInfo)          → { cells }
Phase 3: detectFeatures(imageDataUrl, cells, gridInfo)  → annotations[]
Phase 4: pierceFeatures(cells, annotations)             → finalCells
render Layer 0 (depth=0)

── Phase 5 auto-loop (local Phase 1-4 recursion) ──────────────────────
loop until converged or depth limit:
  imageA = renderTopView()
  diffRegions = compareWithSource(imageA, imageB, cropInfo, gridInfo)
  if diffRegions is empty → break

  for each region of diffRegions:
    cropImage   = cropToCells(imageB, cropInfo, gridInfo, region.cells)
    constraints = extractConstraints(region.cells)

    // Local Phase 1-4 (smaller image + boundary constraints)
    localGridInfo = analyzeGridSize(cropImage, { constraints, parentLayout })
    localCells    = classifyFaces(cropImage, localGridInfo)
    localAnn      = detectFeatures(cropImage, localCells, localGridInfo)
    localFinal    = pierceFeatures(localCells, localAnn)

    // localFinal = { scale, gridX, gridZ, cells } — unified sub-grid from AI
    integratePerCellRefinement(region.cells, localFinal)

  re-render

── Manual fallback (same local Phase 1-4) ────────────────────────────
on user selects region manually:
  trigger the same local Phase 1-4 flow as above
```

---

## 6. Refinement Grid / Main Grid Relationship

### 6.1 Region-level AI Generation → Per-cell Integration

Refinement happens in two stages:

1. **AI generation (region-level):** AI generates a **unified sub-grid** for the entire selected region in one call, ensuring internal spatial consistency.
2. **Integration (per-cell):** the front-end splits the unified sub-grid and attaches each slice to the corresponding `parentCell.refinement` field per SPP-Core v1.1.

Example — 2×2 selection, scale=3 → AI generates 6×6 sub-grid → split into 4 × 3×3 chunks:

```
Main grid (2×2)          AI output         After integration (per-cell)
┌───┬───┐               ┌─┬─┬─┬─┬─┬─┐   cell[0,0].refinement → top-left 3×3
│ A │ B │  → scale=3 →  │ │ │ │ │ │ │   cell[1,0].refinement → top-right 3×3
├───┼───┤               ├─┼─┼─┼─┼─┼─┤   cell[0,1].refinement → bottom-left 3×3
│ C │ D │               │ │ │ │ │ │ │   cell[1,1].refinement → bottom-right 3×3
└───┴───┘               └─┴─┴─┴─┴─┴─┘
```

Each parent cell shrinks to 1/scale in world space; the 4 refinements tile seamlessly to cover the original 2×2 area. The original 2×2 cells become semi-transparent (their leaf nodes take over rendering).

### 6.2 Boundary Connectivity Constraints (Open/Wall only)

Constraints are minimal: **only the Open/Wall state of the four outer edges** needs to be preserved.

```
Left edge of 2×2 region has Open  → sub-grid left column has at least one Open
Right edge of 2×2 region is Wall  → sub-grid right column is all Wall
Internal walls are freely determined by AI
```

**Constraint extraction:** for each outer edge, scan the boundary cells' outer-face `faceOptions`; if any face is Open(0) → edge is `'open'`; otherwise `'wall'`.

### 6.3 Data Structure (SPP-Core v1.1 compliant)

Integration follows `ParticleCell.refinement?: ParticleChunk` (mutually recursive); each parent cell independently holds its sub-chunk:

```js
// AI output: region-level unified sub-grid
const aiOutput = {
    scale: 3,
    gridX: 6, gridZ: 6,
    cells: [...]   // unified 6×6 ParticleCells, position = [0..5, 0, 0..5]
};

// Integration: split sub-grid into per-cell refinements
// Selection: 2×2 (cols=2, rows=2), scale=3
function integratePerCellRefinement(selectedCells, aiOutput) {
    const { scale, cells: subCells } = aiOutput;
    for (const parent of selectedCells) {
        const [px, , pz] = parent.position;     // parent cell position in main grid
        const ox = (px - minX) * scale;         // offset within the unified sub-grid
        const oz = (pz - minZ) * scale;
        parent.refinement = {
            gridX: scale,
            gridZ: scale,
            cells: subCells
                .filter(c => c.position[0] >= ox && c.position[0] < ox + scale
                          && c.position[2] >= oz && c.position[2] < oz + scale)
                .map(c => ({
                    ...c,
                    position: [c.position[0] - ox, 0, c.position[2] - oz]
                }))
        };
    }
}
```

**Storage:** no separate `refinements[]` list. Each parent cell's `refinement` field is the SPP-Core v1.1 `ParticleChunk`; `flattenRecursiveCells` handles all depths recursively.

### 6.4 Coordinate Mapping

For a sub-cell `(rx, rz)` inside a parent cell's refinement, world coordinates are derived from the parent's position — consistent with `flattenRecursiveCells` recursion:

```
// parentCell: position = [px, 0, pz], worldScale = cellSize
// refinement cell (rx, rz):
worldX     = px * cellSize + (rx / scale) * cellSize
worldZ     = pz * cellSize + (rz / scale) * cellSize
worldScale = cellSize / scale
```

Multiple parent cells' refinements tile seamlessly in world space — no extra region-level coordinate transform needed.

---

## 7. Refinement AI Call Strategy

### 7.1 Input: Local Crop + Connectivity Constraints

**Only the divergent region's sub-image is sent** (no full floor plan) along with 4-edge connectivity, dramatically reducing token usage:

```js
{
  image: cropDataUrl,          // sub-image cropped from source floor plan
  constraints: {
    left:   'open',            // region's left edge has an Open connection
    right:  'wall',            // region's right edge is solid Wall
    top:    'wall',
    bottom: 'open',
  },
  rooms: ['Bedroom', 'Bathroom'],  // room names present in this region
}
```

### 7.2 Constraint Extraction Rule

For each of the 4 outer edges of the selection, scan the outer-face `faceOptions` of boundary cells:
- Any Open(0) face present → edge is `'open'`
- All Wall(10)/Door(1/2)/Window(20) → edge is `'wall'`

### 7.3 AI Prompt Structure (refinement-specific)

```
You are an SPP spatial refiner. Given a cropped floor plan region and boundary
connectivity constraints, generate a fine-grained sub-grid.

## Boundary Constraints
left: open   (this edge connects to an adjacent space)
right: wall  (this edge is a solid exterior or room boundary)
top: wall
bottom: open

## Rooms in this region
Bedroom, Bathroom

## Task
Choose a scale (2, 3, or 4) based on visual complexity.
Generate a unified NxM sub-grid where N = cols * scale, M = rows * scale.
Internal wall placement is free — only boundary connectivity must be respected.

## Output
{
  "scale": 3,
  "gridX": 6,
  "gridZ": 6,
  "cells": [{ "position": [x, 0, z], "room": "...", "faceOptions": [...] }]
}
```

### 7.4 Scale Strategy

AI autonomously selects `scale ∈ {2, 3, 4}` based on the visual complexity of the cropped image and returns it in the output JSON.

---

## 8. Delete / Rollback

### 8.1 Delete Granularity — Per-cell Refinement

Delete operates **per selected cell**: select a cell in a refinement layer → delete its direct parent's `refinement` field → parent becomes opaque again, re-render.

If the selection spans multiple parent cells, each parent's `refinement` is deleted independently.

**Reverse lookup:** leaf nodes from `flattenRecursiveCells` include a `_parentCell` reference (added during flatten). The selection manager hits a leaf cell, then uses `_parentCell` to locate the node whose `refinement` should be deleted:

```js
// Leaf node extra fields (when depth > 0):
{ ..., _depth: 1, _parentCell: <reference to direct parent ParticleCell> }

// Delete logic:
for (const leaf of selectedLeaves) {
    if (leaf._depth > 0 && leaf._parentCell) {
        delete leaf._parentCell.refinement;
    }
}
```

### 8.2 Layer-by-layer Rollback Constraint

```
User selects cells at depth=1
  ↓
Check if any cell in parentCell.refinement.cells has its own refinement (depth=2)
  → If yes: toast "Delete deeper refinements first", block operation
  → If no: delete parentCell.refinement, parent resumes opaque rendering
```

Since storage is a per-cell recursive tree, checking for deeper layers only requires scanning direct child cells' `refinement` fields — no global `refinements[]` list needed.

---

## 9. Mock Mode

Enabled via `?mock=1` — demonstrates the full flow without an API key:

| Phase | Mock data |
|-------|-----------|
| Phase 1+2 | Fixed 6×5 coarse grid, 5 semantic rooms |
| Phase 3+4 | Fixed door annotations (at least one door per room) |
| Phase 5 regression | Pixel diff against `mock-floorplan.png`; refinement uses `buildMockSubGrid` (scale=3) |
| Manual refinement | Selected region returns fixed refinement (scale=3) |

---

## 10. spp-lib Patches Applied

### 10.1 `flattenRecursiveCells` Bug Fix ✅

`gridSpan` scoped inside the `if (sub)` branch; added `depth` parameter; leaf nodes output `_depth` and `_parentCell` fields.

### 10.2 `detectFeatures()` + `pierceFeatures()` ✅

Phase 3 AI call + Phase 4 deterministic pierce — implemented and tested.

### 10.3 `integratePerCellRefinement(selectedCells, aiOutput)` ✅

Implemented in `RecursiveGridManager` inside `spp-inverse-engine.js`, conforming to SPP-Core v1.1 per-cell storage standard (see §6.3).

### 10.4 `extractBoundaryConstraints` ✅

Logic lives inside `createBatchRefineContext`; `regression.js` wraps it as `extractConstraints()` for use in the Phase 5 auto-loop.

### 10.5 `createBatchRefineContext` ✅

Constraint format updated to `{ left, right, top, bottom: 'open'|'wall' }`, aligned with §7.2.

### 10.6 `collectInteriorNodes` ✅

Returns cells with `refinement` (interior nodes) with `worldPosition`/`worldScale`/`_depth` for semi-transparent rendering. Complements `flattenRecursiveCells` (leaves only).

### 10.7 `analyzeGridSize(imageDataUrl, localContext?)` ✅

Optional second parameter for local Phase 5 calls. When `localContext = { constraints, parentLayout }` is provided, uses `STEP1_LOCAL_PROMPT` and returns `{ scale, gridX, gridZ, layout }` (no crop field).

---

## 11. Confirmed Design Decisions

| # | Decision | Resolution |
|---|----------|-----------|
| 1 | **Scale strategy** | AI autonomously chooses `scale ∈ {2, 3, 4}` based on visual complexity |
| 2 | **Max recursion depth** | 4 levels (depth 0–3); refinement disabled beyond that |
| 3 | **Export format** | Recursive-tree JSON; per-cell `refinement` nesting (SPP-Core v1.1 `ParticleCell.refinement?: ParticleChunk`) |
| 4 | **Delete granularity** | Delete `parentCell.refinement` (per-cell); layer-by-layer rollback; no partial rollback |
| 5 | **Refinement driver** | AI auto-drives via top-view regression; manual box-select is the user fallback |
| 6 | **Sub-grid granularity** | AI generates at region level (one unified sub-grid per region); **stored per-cell** (each parent holds its own `refinement: ParticleChunk`) |
| 7 | **Boundary constraints** | Open/Wall connectivity only (one value per edge); no exact face matching required |
| 8 | **Token strategy** | Front-end crops local sub-image + extracts constraints; AI only sees the small image |
| 9 | **Mouse assignment** | Left-drag = box-select; Right-drag = rotate; Middle/Right+Shift = pan |
| 10 | **Phase 4 implementation** | Purely deterministic; only replaces Wall(10) faces; never touches Open faces |
