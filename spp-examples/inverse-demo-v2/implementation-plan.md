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

## 11. Implementation Issues & Optimization (2026-03-18)

### 11.1 Problems Encountered

#### 问题 1：Phase 1 提示词产生幻觉房间

**现象：** Qwen qwen-vl-max 在 Step 1A 中频繁将门厅/入户区识别为独立的 "Entrance" 房间，导致布局多出一列，所有其他房间被整体压缩偏移。

**原因：** 原提示词示例中包含 `"Entrance"`，且描述中写了 `"entrance, balcony, storage, etc."`，模型倾向于把门道区域单独列出。

**已修复：** 移除示例中的 `Entrance`，新增规则：
> Only include spaces that are clearly enclosed by walls. Do NOT list "Entrance", "Entry", "Foyer" unless it is a large, clearly labeled dedicated room — small transitional areas near the front door are part of the hallway.

---

#### 问题 2：Phase 5 像素 diff 失效

**现象：** Phase 5 top-view regression 无法识别出需要优化的 cell，或将全部 cell 标为发散。

**根本原因有两层：**

1. **Crop 坐标不准确**
   Phase 5 的 `compareWithSource()` 用 `cropInfo` 从原图裁出平面图区域，再与渲染俯视图做像素 diff。若 AI 返回的 `crop` 坐标偏移，裁出来的区域就和实际平面图对不上，导致全图 diff 失真。

2. **渲染风格与原图不匹配**
   渲染俯视图是带颜色的 3D 模型截图（砖红色墙体 + 灰色地板），原图是黑白线条平面图，两者风格根本不同。像素级 diff 在这两类图像之间缺乏可靠意义——颜色差异不等于结构差异。

**结论：** 以像素 diff 作为递归触发器，在实际场景中过于脆弱，依赖两个难以同时满足的前提（crop 精准 + 渲染风格接近）。

---

#### 问题 3：Step 3 门窗检测严重过检

**现象：** 在 8×8 网格（64 cells）上，Qwen 返回了 52 个门窗注解，超出合理范围（正常应为 8–15 个）。

**原因：** STEP3_PROMPT 将所有 wall face 的坐标列表完整传给模型，模型在 wall face 数量多时容易对每个 face 都生成一个注解。

**临时处理：** 当前代码已有 sanity check（注解数 > 2× cell 数时整批丢弃），但实际效果是要么全留、要么全丢，不够精细。此问题暂缓，等 Phase 5 重设计后一并处理。

---

### 11.2 Phase 5 优化方案：结构驱动递归（替代像素 diff）

#### 核心思路

将 Phase 5 的触发器从"像素偏差"改为"结构复杂度"。粗网格（Phase 2 输出）中，每个 cell 的 faceOptions 已经包含了它与相邻 cell 的拓扑关系，可以直接判断哪些区域细节不足，无需渲染或图像对比。

递归的机制（裁图 → AI 子网格 → 嵌入）保持不变，只改变触发时机和驱动条件。

#### 触发条件

Phase 2 完成后，对每个 cell 计算结构复杂度分，满足任一条件即标记为"需细化"：

| 条件 | 说明 |
|------|------|
| cell 的 4 个面连接了 ≥ 2 种不同房间 | 这里是多房间交界，细节不足 |
| cell 属于 Hallway 且相邻房间 ≥ 3 种 | 走廊枢纽，门的位置最密集 |
| 某房间在整个 layout 中只占 1 个 cell | 太粗，无法表达内部结构 |

#### 新执行流程

```
Phase 1: AI 识别粗粒度 layout（Step 1A → 1B → 1C）
Phase 2: 确定性生成墙体拓扑（generateCellsFromLayout）
         ↓
         扫描所有 cell，按结构复杂度标记需细化的 cell
         将相邻的待细化 cell 用 BFS 合并成区域
         ↓
Phase 3（结构驱动递归）：
  for each 待细化区域:
    cropImage = 按 cell 边界从原图裁出该区域
    constraints = 提取 4 边 Open/Wall 连通性
    localGridInfo = AI 分析子图（STEP1_LOCAL_PROMPT）
    localCells = 确定性生成子网格墙体
    integratePerCellRefinement(region.cells, localGrid)
    ↓
    对新生成的子 cell 再次评估结构复杂度
    满足条件则继续递归，直到 MAX_DEPTH 或无待细化 cell
         ↓
Phase 4（原 Step 3）: AI 检测门窗（在最终叶节点层执行）
Phase 5（原 Phase 4）: 确定性门窗穿刺
```

#### 与原设计的对比

| | 原 Phase 5（像素 diff） | 新方案（结构驱动） |
|--|--|--|
| 触发时机 | Phase 1-4 完成后 | Phase 2 完成后即开始 |
| 触发条件 | 渲染俯视图 vs 原图像素差 | cell 结构复杂度 |
| 依赖 crop 精度 | 是（偏移会导致全图误判） | 否（按 cell 边界裁图） |
| 依赖渲染风格 | 是（3D 图 vs 线条图差异大） | 否 |
| 细化机制 | 裁图 → AI → 嵌入（不变） | 裁图 → AI → 嵌入（不变） |
| 门窗检测时机 | 每层递归都调用 | 仅在最终叶节点层调用一次 |

#### 优点

1. **不依赖 crop 精度** — 裁图坐标从 cell 在网格中的相对位置计算，误差不累积到全局
2. **不依赖渲染** — 完全在数据层判断，无需截图
3. **更早开始细化** — Phase 2 结束即可驱动，不用等 Phase 1-4 全部跑完再回头
4. **门窗检测更精准** — 在最细粒度的叶节点层才调用 Step 3，此时区域更小、上下文更清晰

#### 待确认的设计决策

| # | 问题 | 待定 |
|---|------|------|
| 1 | 结构复杂度阈值如何标定（几种房间算"复杂"） | 建议先用 ≥2 种邻居房间 |
| 2 | 每轮最多细化多少个区域（防止 AI 调用爆炸） | 建议首轮限制 ≤ 6 个区域 |
| 3 | 门窗检测是只在叶节点层还是每层都做 | 建议仅叶节点层 |
| 4 | 原 Phase 5 像素 diff 是否完全废弃，还是保留为可选的最终校验步骤 | 待定 |

---

## 12. Pipeline Redesign：门符号优先架构（2026-03-18）

### 12.1 问题发现

结构递归细化（§11.2）实施后，发现一个更根本的问题：

**递归细化时 cell 边界可能正好落在门洞上。**

原因：Phase 1 的房间布局识别是在**带门洞的原图**上进行的。门弧/门扇符号在视觉上破坏了墙体的连续性，AI 难以判断"这里是房间边界"还是"通向另一个空间的开口"，导致初始网格划分出现偏差。结构递归再怎么细化，若初始边界就定错了，细化只会把错误放大。

### 12.2 新架构：先符号检测，后拓扑分析

核心思想：**门是独立的视觉符号（弧线/扇形），可以在不知道房间信息的情况下独立检测。** 先把门洞封闭，得到纯净的墙体图，再做布局识别和递归细化，最后把门还原回去。

#### 完整流程

```
Step 0: 门符号检测（AI）
  输入: 原始平面图
  任务: 找出所有门弧/门扇的像素位置和朝向
  输出: [{ px, py, width, angle }, ...]  — 归一化像素坐标

Step 1: 门洞封闭预处理（确定性）
  输入: 原图 + Step 0 门位置列表
  任务: 在门洞区域绘制实墙（填充像素）
  输出: 全封闭平面图（无门洞）

Step 2: 自动裁剪（像素检测，无 AI）
  与原方案相同，检测平面图边界，得到 cropInfo

Step 3: 房间布局识别（AI，在封闭图上）
  Step 3A: 识别房间列表（STEP1A_ROOMS_PROMPT）
  Step 3B: 计算网格尺寸（确定性，aspect ratio + 房间数）
  Step 3C: 填充网格（STEP1C_GRID_PROMPT）
  优势: 门洞已封闭，所有房间边界清晰，AI 识别更准

Step 4: 确定性生成墙体拓扑（generateCellsFromLayout）

Step 5: 结构递归细化
  与 §11.2 方案相同
  优势: 房间边界干净，cell 不会卡在门洞上

Step 6: 门坐标映射（确定性）
  将 Step 0 的像素坐标 → 网格坐标 (x, z, face)
  公式: gridX = floor(px / (cropW / gridX_count)), 同理 z

Step 7: 门窗穿刺（确定性，pierceFeatures）
```

#### 架构对比

| 步骤 | 旧方案 | 新方案 |
|------|--------|--------|
| 门的检测时机 | Phase 3，房间识别后 | Step 0，最先做 |
| 房间识别时的图 | 带门洞原图 ❌ | 封闭图 ✅ |
| 递归细化时的边界 | 可能卡在门洞 ❌ | 全封闭，边界干净 ✅ |
| 门的定位方式 | AI 在墙面列表里猜 ❌ | 独立符号检测，更准 ✅ |

### 12.3 Step 0 门符号检测 Prompt 设计

```
You are analyzing an architectural floor plan image.

Detect ALL door symbols in the image. Door symbols appear as:
- An arc (quarter-circle) indicating the swing path
- A straight line at the arc's base (the door leaf)
- The combination indicates a door opening in a wall

For each door found, return its center position and approximate width
as normalized coordinates (0.0–1.0 relative to full image size).

Return ONLY a JSON array:
[
  { "cx": 0.45, "cy": 0.32, "width": 0.04, "angle": 90 },
  ...
]

Where:
- cx, cy: center of the door opening (normalized 0–1)
- width: door opening width as fraction of image width
- angle: wall orientation in degrees (0=horizontal wall, 90=vertical wall)

Return [] if no doors are visible.
```

### 12.4 Step 1 门洞封闭预处理

在检测到的每个门位置，用与周围墙体相近的颜色（通常为黑色线条）绘制一段短线，覆盖门洞，使其在视觉上变为实墙。

```js
function sealDoorOpenings(imageDataUrl, doorAnnotations, cropInfo) {
    // For each door: draw a short line segment at (cx, cy)
    // perpendicular to the wall, width = door.width * imageWidth
    // color = #000000 (match wall line color)
}
```

### 12.5 坐标映射（Step 0 像素 → Step 6 网格）

```
门像素坐标 (cx, cy) → 网格坐标 (gx, gz, face)

// cx, cy 是归一化像素坐标（相对于整张图）
// 先换算到平面图内的相对坐标
relX = (cx - cropInfo.x) / cropInfo.w   // 0–1 within floor plan
relZ = (cy - cropInfo.y) / cropInfo.h   // 0–1 within floor plan

// 再映射到网格
gx = floor(relX * gridX)
gz = floor(relZ * gridZ)

// face 由 angle 决定
angle=0  (水平墙) → face 4 or 5 (POS_Z / NEG_Z)
angle=90 (垂直墙) → face 0 or 1 (POS_X / NEG_X)
```

### 12.6 待确认设计决策

| # | 问题 | 建议 |
|---|------|------|
| 1 | 门洞封闭用纯黑线还是检测周围墙色 | 先用纯黑线，简单可靠 |
| 2 | 窗的处理：是否也在 Step 0 检测 | 建议一并检测，窗符号（平行短线）同样影响边界识别 |
| 3 | Step 0 失败（检测不到门）的降级策略 | 跳过封闭步骤，直接用原图走原流程 |
| 4 | 门宽度换算为 cell 尺寸的精度问题 | 取最近的 cell 边界（四舍五入到格点） |

---

## 13. Confirmed Design Decisions

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

---

## 14. 纯几何空间识别架构（下一阶段优化方向）

### 14.1 背景与动机

在 Section 12（Door-First 架构）实施后，仍存在以下问题：

1. **走廊识别偏差**：STEP1C 要求每个房间是矩形块，Qwen 倾向于把走廊拉成贯穿全高/全宽的整列，导致顶部空间分配错误（如右上角 Bathroom 位置偏移）。
2. **房间命名引入偏差**：先列房间名单（Step 3A）再填格（Step 3C）的两步流程，AI 会用名字的语义"猜"位置，而不是观察视觉边界。例如 "Hallway" 这个名字本身就暗示"长条形通道"，导致填充时自动延伸。
3. **Step 3A 的房间数量依赖**：房间数量用于计算网格尺寸，但实际上可以通过宽高比独立计算，不需要先识别房间。

### 14.2 新架构：Wall-Fill + 纯几何分割

核心思路：**先把墙体填实，再让 AI 做纯几何空间切割，不命名房间。**

```
Step 1: [AI]    检测平面图边界 → cropInfo
         ↓
Step 2: [AI]    识别门窗位置 + 建议 gridX/gridZ
                → 保存 doorSymbols[], windowSymbols[]
         ↓
Step 3: [Canvas] 墙体填黑预处理
                • 阈值检测：深色像素（墙线）→ 标记
                • Morphological closing：填充细缝，使墙线变为实心区域
                • 封闭 Step 2 检测到的门洞（覆盖门弧）
                → 输出：黑墙/白空间 二值图
         ↓
Step 4: [AI]    纯空间分割（输入二值图）
                • 不命名，只区分连通空间
                • 输出 gridX×gridZ 二维数组，同一空间填同一字母/ID
                • 对复杂区域递归裁剪放大再识别
         ↓
Step 5: [确定性] 将 Step 2 的门窗坐标 pierce 到对应 face
         ↓
Step 6: [渲染]  3D 渲染识别结果
Step 7: [手动]  修正墙体位置
```

### 14.3 与 Door-First 架构（Section 12）的对比

| 维度 | Section 12（Door-First） | Section 14（Wall-Fill + 几何） |
|------|--------------------------|-------------------------------|
| 输入图像 | 原始线图（封闭门洞后） | 黑墙/白空间二值图 |
| 房间识别方式 | 先列名单，再按名字填格 | 纯几何，只区分连通区域 |
| 走廊处理 | 易被拉成全列（矩形约束） | 走廊 = 白色通道，形状由像素决定 |
| AI 理解依赖 | 依赖对房间语义的理解 | 依赖对几何连通性的理解 |
| 房间命名时机 | Step 3A（影响后续填格） | Step 5 之后可选加一步语义标注 |
| 实现复杂度 | 中 | Step 3 墙体填黑需要 canvas 形态学处理 |
| 鲁棒性 | 中（受命名偏差影响） | 高（纯视觉，不依赖语义） |

### 14.4 Step 3 墙体填黑实现要点

```js
// 输入：原始 floor plan imageData（已封闭门洞）
// 输出：黑墙/白空间 二值图

function fillWallsBlack(imageData, threshold = 128, dilateRadius = 3) {
    // 1. 灰度化 + 阈值：深色像素（墙线）→ black (0), 浅色（空间）→ white (255)
    // 2. Morphological dilation：以 dilateRadius 为半径膨胀黑色区域
    //    → 细墙线变为实心墙体区域，填充细缝
    // 3. 返回二值 canvas buffer
}
```

关键参数：
- `threshold`：区分墙/空间的灰度阈值（典型值 100–150，取决于图像风格）
- `dilateRadius`：膨胀半径（典型值 2–4px，取决于原始墙线粗细）

### 14.5 Step 4 提示词设计

输入二值图（黑墙/白空间）后，提示词不再要求命名：

```
You are analyzing a floor plan where walls are filled black and rooms are white.

Divide the image into a __GRID_X__ × __GRID_Z__ grid.
Assign each cell an identifier (A, B, C, ...) so that all cells belonging to
the same connected white region share the same identifier.
Use null for cells that are entirely black (wall) or outside the building.

Return ONLY a JSON 2D array:
[["A","A","B",...], ...]
```

这样输出与现有 `generateCellsFromLayout` 兼容（room 字段变为空间 ID），无需其他改动。

### 14.6 实施步骤

1. **概念验证**：写 `scripts/wall-fill-test.mjs`，对 `mock-floorplan.png` 执行 Step 3 墙体填黑，输出 `scripts/wall-filled.png`，人工检查质量
2. **接入 Step 4**：将二值图传给 AI，验证纯几何分割结果
3. **语义标注（可选）**：分割完成后，可再加一步 AI 调用，对每个空间 ID 打上语义标签（"Kitchen"/"Bedroom" 等），不影响结构识别
4. **替换现有 Step 3A+3C**：验证通过后，用新流程替换
