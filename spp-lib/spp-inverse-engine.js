/**
 * spp-inverse-engine.js
 *
 * Independent SPP Inverse Modeling Engine
 * Consolidates the reconstruction pipeline into a single module.
 * LLM calls are injected via a provider callback — no dependency on specific AI services.
 *
 * Usage:
 *   import { SPPInverseEngine } from './spp-inverse-engine.js';
 *
 *   const engine = new SPPInverseEngine({
 *     llmProvider: async (imageDataUrl, systemPrompt, userText) => {
 *       // Call your LLM here, return the raw text response
 *       return responseText;
 *     },
 *     onStatus: (msg) => console.log(msg),
 *   });
 *
 *   const result = await engine.reconstruct(imageDataUrl);
 *   // result = { gridInfo: { crop, gridX, gridZ, layout }, cells, description }
 */

import { OPTION_REGISTRY } from './spp-core.js';

// Re-export core for convenience — consumers can import from either file
export {
    FACE, OPPOSITE_FACE, FACE_DIRECTION, FACE_NAMES,
    OPTION_TYPE, OPTION_REGISTRY, OPEN_IDS, WALL_IDS, ALL_IDS,
    getResolvedOption, cycleOption,
    createCell, createChunk, collapseCell,
} from './spp-core.js';

// ═════════════════════════════════════════════════════════════
// Part 1: Inverse-Specific Cell Generation (from particle.js)
// ═════════════════════════════════════════════════════════════

/**
 * Expand cells with scale > 1 into flat sub-cell array.
 * Non-scaled cells pass through unchanged.
 * Scaled cells produce n×n sub-cells with fractional positions.
 *
 * @param {Array} cells - array of cell objects (some may have .scale and .subCells)
 * @returns {Array} flat array of cells (all scale=1 effective)
 */
export function expandScaledCells(cells) {
    const result = [];

    for (const cell of cells) {
        const n = cell.scale || 1;
        if (n <= 1 || !cell.subCells) {
            // Normal cell — pass through
            result.push(cell);
            continue;
        }

        // Expand: parent at [px, 0, pz] with scale=n
        // Sub-cell [sx, sz] gets position [px + (sx - (n-1)/2) / n * ... ]
        // We use fractional positions: sub [sx,sz] → [px - 0.5 + (sx+0.5)/n, 0, pz - 0.5 + (sz+0.5)/n]
        // This places sub-cells within the parent's footprint
        const [px, py, pz] = cell.position;

        for (const sc of cell.subCells) {
            const [sx, sz] = sc.sub;
            const fracX = px - 0.5 + (sx + 0.5) / n;
            const fracZ = pz - 0.5 + (sz + 0.5) / n;

            result.push({
                position: [fracX, py, fracZ],
                size: [1 / n, 1, 1 / n], // fractional size for sub-cells
                faceStates: 63,          // 0b111111 (all faces active)
                room: sc.room,
                faceOptions: sc.faceOptions,
                _parentScale: n,        // renderer uses this for sizing
                _parentPos: [px, pz],   // for debugging
                _subPos: [sx, sz],
            });
        }
    }

    return result;
}

/**
 * Generate cells and face options from a 2D layout array and a list of doors.
 * @param {Array<Array<string|null>>} layout - 2D layout grid (z, x)
 * @param {number} gridX - Width of grid
 * @param {number} gridZ - Height of grid
 * @param {Array<Object>} doors - List of door objects {x1, z1, x2, z2}
 * @returns {Array<Object>} List of cell objects
 */
export function generateCellsFromLayout(layout, gridX, gridZ, doors) {
    const doorSet = new Set();
    for (const d of doors || []) {
        doorSet.add(`${d.x1},${d.z1}->${d.x2},${d.z2}`);
        doorSet.add(`${d.x2},${d.z2}->${d.x1},${d.z1}`);
    }
    function hasDoor(x1, z1, x2, z2) {
        return doorSet.has(`${x1},${z1}->${x2},${z2}`);
    }
    const windowRooms = new Set(['Kitchen', 'Living Room', 'Bedroom']);
    function faceValue(x, z, nx, nz) {
        const room = layout[z]?.[x];
        const neighbor = layout[nz]?.[nx];
        if (nx < 0 || nx >= gridX || nz < 0 || nz >= gridZ || !neighbor) {
            return windowRooms.has(room) ? [20] : [10];
        }
        if (room === neighbor) return [0];
        if (hasDoor(x, z, nx, nz)) return [2];
        return [10];
    }
    const cells = [];
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const room = layout[z]?.[x];
            if (!room) continue;
            cells.push({
                position: [x, 0, z],
                size: [1, 1, 1],    // standard unit size
                faceStates: 63,     // 0b111111 (all faces active)
                room,
                faceOptions: [
                    faceValue(x, z, x + 1, z),  // +X
                    faceValue(x, z, x - 1, z),  // -X
                    [],                           // +Y
                    [],                           // -Y
                    faceValue(x, z, x, z - 1),  // +Z
                    faceValue(x, z, x, z + 1),  // -Z
                ],
            });
        }
    }
    return cells;
}

/**
 * Data restructuring layer for multi-resolution grid optimization.
 * Expands a low-res base layout into a high-res fine layout, applies localized
 * fine-grained room overrides, scales doors, and recalculates all face options.
 *
 * @param {Array<Array<string|null>>} baseLayout - The original low-res layout
 * @param {number} scale - Expansion factor (e.g., 2)
 * @param {Array<Object>} cellModifications - Fine-grained room overrides
 *        Format: [{ basePos: [bx, bz], subPos: [sx, sz], room: 'Room Name' }]
 * @param {Array<Object>} baseDoors - Door definitions at base scale
 * @returns {Object} { fineLayout, cells, gridX, gridZ }
 */
export function optimizeGrid(baseLayout, scale, cellModifications, baseDoors) {
    if (scale <= 1) {
        const gridX = baseLayout[0]?.length || 0;
        const gridZ = baseLayout.length;
        const cells = generateCellsFromLayout(baseLayout, gridX, gridZ, baseDoors);
        return { fineLayout: baseLayout, cells, gridX, gridZ };
    }

    const baseZ = baseLayout.length;
    const baseX = baseLayout[0]?.length || 0;
    const fineZ = baseZ * scale;
    const fineX = baseX * scale;

    // 1. Expand base layout into fine layout
    const fineLayout = [];
    for (let fz = 0; fz < fineZ; fz++) {
        const row = [];
        for (let fx = 0; fx < fineX; fx++) {
            const bx = Math.floor(fx / scale);
            const bz = Math.floor(fz / scale);
            row.push(baseLayout[bz]?.[bx] || null);
        }
        fineLayout.push(row);
    }

    // 2. Apply localized room modifications (sub-cell overrides)
    for (const mod of cellModifications || []) {
        const [bx, bz] = mod.basePos;
        const [sx, sz] = mod.subPos;
        const fx = bx * scale + sx;
        const fz = bz * scale + sz;
        if (fineLayout[fz] && fineLayout[fz][fx] !== undefined) {
            fineLayout[fz][fx] = mod.room;
        }
    }

    // 3. Scale up door coordinates
    // A base door spans 1 base cell edge. In fine grid, it spans `scale` fine cell edges.
    const fineDoors = [];
    for (const d of baseDoors || []) {
        // Find which axis the door aligns with
        if (d.x1 === d.x2) {
            // Door on X axis (Z changes)
            const minX = Math.min(d.x1, d.x2) * scale + (scale - 1);
            const maxX = Math.max(d.x1, d.x2) * scale;
            const minZ = Math.min(d.z1, d.z2) * scale;
            for (let sz = 0; sz < scale; sz++) {
                fineDoors.push({ x1: minX, z1: minZ + sz, x2: maxX, z2: minZ + sz });
            }
        } else if (d.z1 === d.z2) {
            // Door on Z axis
            const minZ = Math.min(d.z1, d.z2) * scale + (scale - 1);
            const maxZ = Math.max(d.z1, d.z2) * scale;
            const minX = Math.min(d.x1, d.x2) * scale;
            for (let sx = 0; sx < scale; sx++) {
                fineDoors.push({ x1: minX + sx, z1: minZ, x2: minX + sx, z2: maxZ });
            }
        }
    }

    // 4. Generate cells using the uniform fine grid
    const cells = generateCellsFromLayout(fineLayout, fineX, fineZ, fineDoors);

    // 5. Mark cells so renderer sizes and spaces them correctly
    for (const cell of cells) {
        cell._parentScale = scale;
        cell._isFineGrid = true;
    }

    return { fineLayout, cells, gridX: fineX, gridZ: fineZ };
}

// ═════════════════════════════════════════════════════════════
// Part 2: Prompt Templates (from prompt.js)
// ═════════════════════════════════════════════════════════════

const STEP1_PROMPT = `You are a spatial layout analyzer. Given a floor plan image, first locate the floor plan boundary, then overlay a fine-grained grid that preserves room proportions.

## Task

### Phase A: Detect floor plan bounds
Find the bounding box of the actual floor plan (the outer walls), EXCLUDING any labels, titles, dimensions, margins, or whitespace around it.
Express the bounds as normalized coordinates (0.0 to 1.0) relative to the full image:
- cropX: left edge of the outer wall
- cropY: top edge of the outer wall
- cropW: width of the floor plan area
- cropH: height of the floor plan area

### Phase B: Overlay grid WITHIN the bounds
Create a grid that covers ONLY the floor plan area (not the margins):
- Large rooms span MULTIPLE cells (e.g., a living room might be 2×2 cells)
- Small rooms span fewer cells (e.g., a bathroom might be 1×1)
- Narrow spaces like hallways span 1 cell wide but may be multiple cells long
- The grid must preserve approximate room SIZE RATIOS

## Rules
1. Study the image and estimate each room's relative width and height
2. Choose a common unit size such that rooms fit as integer multiples
3. Assign each cell a **semantic room name** (e.g., "Kitchen", "Living Room", "Bedroom", "Bathroom", "Hallway", "Balcony") — cells belonging to the same enclosed region share the same name.
4. Use null for cells that are exterior (outside the building)
5. The grid should be between 4×4 and 12×12 for typical apartments
6. CRITICAL: the grid must preserve proportions — a room twice as wide should span twice as many columns
7. **Wall snapping (Area-Majority Rule)**: When a physical wall does not perfectly align with a cell boundary, assign the cell to whichever room occupies MORE of that cell's area. Walls must always land on cell boundaries.
8. **Rectangular spaces**: Each room name should form a contiguous rectangular block. Avoid L-shaped or jagged assignments.
9. **Minimum size**: Every enclosed region must have at least 1 cell.

## Output
Return ONLY a JSON object:
{
  "crop": { "x": <float 0-1>, "y": <float 0-1>, "w": <float 0-1>, "h": <float 0-1> },
  "gridX": <columns>,
  "gridZ": <rows>,
  "layout": [
    ["Kitchen", "Kitchen", "Hallway", ...],
    ["Kitchen", "Kitchen", "Hallway", ...],
    ...
  ]
}

Where layout[row][col] is the semantic room name for that cell, or null for exterior cells.
Example:
{
  "crop": { "x": 0.08, "y": 0.10, "w": 0.84, "h": 0.82 },
  "gridX": 5,
  "gridZ": 4,
  "layout": [
    ["Kitchen", "Kitchen", "Hallway", "Bathroom", "Bathroom"],
    ["Kitchen", "Kitchen", "Hallway", "Bathroom", "Bathroom"],
    ["Living Room", "Living Room", "Hallway", "Bedroom", "Bedroom"],
    ["Living Room", "Living Room", "Hallway", "Bedroom", "Bedroom"]
  ]
}`;

const STEP2_PROMPT = `You are an SPP (String Particle Protocol) spatial analyzer. Given a floor plan image and a fine-grained grid layout, classify each cell's face connections.

## Grid Layout (from Step 1)
GRID_X: __GRID_X__
GRID_Z: __GRID_Z__
Layout:
__LAYOUT__

## Phase 2: Binary Topology Generation
Your task is to classify connections between rooms. To simplify the process, use ONLY two options for now:

- 0: **Open** — same room (passage continues within the same region)
- 10: **Wall** — different rooms or exterior boundary

## Rules
1. **Same-room adjacency**: If two adjacent cells belong to the SAME room name → use 0 (open).
2. **Different-room adjacency**: If adjacent cells are DIFFERENT rooms or exterior → use 10 (wall).
3. **DO NOT generate doors or windows yet**. These will be processed in a later phase. Focus 100% on the physical shell.

## Output
Return ONLY a JSON object:
{
  "gridX": __GRID_X__,
  "gridZ": __GRID_Z__,
  "description": "<brief description>",
  "cells": [
    {
      "position": [x, 0, z],
      "room": "<semantic room name>",
      "faceOptions": [[id], [id], [], [], [id], [id]]
    }
  ]
}

Only include cells where layout is NOT null.`;

// Local refinement variant of STEP1_PROMPT (used in Phase 5 recursive local calls).
// Placeholders: __CONSTRAINTS__, __PARENT_LAYOUT__, __COLS__, __ROWS__
const STEP1_LOCAL_PROMPT = `You are a spatial layout refiner. Given a CROPPED region of a floor plan and boundary connectivity constraints, generate a fine-grained sub-grid for that region only.

## Boundary Constraints
The sub-grid must respect the connectivity of the region's four outer edges:
__CONSTRAINTS__

(open = this edge connects to an adjacent space; wall = solid boundary)

## Known rooms in this region
__PARENT_LAYOUT__

## Task
1. The cropped image covers a __COLS__×__ROWS__ area in the parent grid.
2. Choose a scale factor (2, 3, or 4) based on the visual complexity of this region.
3. Generate a unified sub-grid of size (cols × scale) × (rows × scale).
4. Assign semantic room names to each cell. Internal wall placement is free — only the boundary connectivity above must be respected.
5. Use null for any sub-cells that are exterior.

## Output
Return ONLY a JSON object (no crop field needed — the crop is already done):
{
  "scale": <2|3|4>,
  "gridX": <cols * scale>,
  "gridZ": <rows * scale>,
  "layout": [
    ["Room Name", "Room Name", ...],
    ...
  ]
}`;

const STEP3_PROMPT = `You are an SPP feature detector. Given a floor plan image and an existing binary wall topology, identify all doors and windows.

## Current Grid Topology
GRID_X: __GRID_X__
GRID_Z: __GRID_Z__
Wall faces (faces currently classified as Wall, optionId=10):
__WALL_FACES__

## Task
For each door or window visible in the floor plan image:
1. Identify which cell (x, z) and which face index it is on:
   - face 0 = +X (right edge of cell)
   - face 1 = -X (left edge of cell)
   - face 4 = +Z (front edge, lower row boundary)
   - face 5 = -Z (back edge, upper row boundary)
2. Assign the appropriate Option ID:
   - 1: Arch Door (arched opening)
   - 2: Rectangular Door (standard door, most common)
   - 20: Window (glazed panel, only on exterior walls)

## Rules
- Only annotate faces that are currently Wall (optionId=10). Do not touch Open (0) faces.
- A door between two interior cells must appear on BOTH cells' facing faces.
  Example: door between (2,1) and (3,1) → annotate (2,1) face 0 AND (3,1) face 1.
- Windows only appear on exterior walls (the neighboring cell is outside the building).
- If a wall shows a door symbol but type is unclear, use 2 (Rectangular Door).
- If no doors or windows are visible, return an empty array [].

## Output
Return ONLY a JSON array (no extra text):
[
  { "x": 2, "z": 1, "face": 0, "optionId": 2 },
  { "x": 3, "z": 1, "face": 1, "optionId": 2 },
  { "x": 0, "z": 2, "face": 1, "optionId": 20 }
]`;

// ═════════════════════════════════════════════════════════════
// Part 3: Response Parser (from parser.js)
// ═════════════════════════════════════════════════════════════

const VALID_IDS = new Set(Object.keys(OPTION_REGISTRY).map(Number));

/**
 * Parse LLM output text into structured ParticleCell data.
 * Handles markdown fences, extra text, etc.
 */
export function parseAIResponse(text) {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?```\s*$/i, '');
    cleaned = cleaned.trim();

    // Try to find JSON object in the text
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('No JSON object found in AI response');
    }
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`Invalid JSON: ${e.message}`);
    }

    return validateAndNormalize(parsed);
}

function validateAndNormalize(data) {
    if (!data.cells || !Array.isArray(data.cells)) {
        throw new Error('Missing or invalid "cells" array');
    }

    const gridX = data.gridX || 0;
    const gridZ = data.gridZ || 0;
    const description = data.description || '';

    const normalizedCells = [];

    for (const cell of data.cells) {
        if (!cell.position || !Array.isArray(cell.position) || cell.position.length < 3) {
            console.warn('Skipping cell with invalid position:', cell);
            continue;
        }

        if (!cell.faceOptions || !Array.isArray(cell.faceOptions) || cell.faceOptions.length !== 6) {
            console.warn('Skipping cell with invalid faceOptions:', cell);
            continue;
        }

        // Normalize faceOptions: ensure each element is an array with valid IDs
        const normalizedOptions = cell.faceOptions.map((opts, i) => {
            if (!Array.isArray(opts) || opts.length === 0) return [];
            const id = Number(opts[0]);
            if (!VALID_IDS.has(id)) {
                console.warn(`Invalid option ID ${id}, defaulting to 10 (brick wall)`);
                return [10];
            }
            return [id];
        });

        normalizedCells.push({
            position: [cell.position[0], 0, cell.position[2]],
            size: [1, 1, 1],
            faceStates: 0b111111,
            room: cell.room || null,
            faceOptions: normalizedOptions,
        });
    }

    if (normalizedCells.length === 0) {
        throw new Error('No valid cells found in AI response');
    }

    return {
        gridX,
        gridZ,
        description,
        cells: normalizedCells,
    };
}

// ═════════════════════════════════════════════════════════════
// Part 4: Recursive Grid Manager (from recursive-core.js)
// ═════════════════════════════════════════════════════════════

export class RecursiveGridManager {
    /**
     * 1. 【局部提取】为 AI 准备局部重绘的上下文 prompt 和参数
     * 当用户选中一个边界复杂或细节较多的大格子（Macro-cell）时，调用此方法。
     *
     * @param {Object} parentCell - 父级网格节点 (例如一个浴室的格子)
     * @param {number} subGridSize - 目标切割精度 (例如 4 代表 4x4)
     * @returns {Object} 包含给大模型的上下文提示数据
     */
    static createSubGridPromptContext(parentCell, subGridSize = 4) {
        // AI 在处理局部区域时，必须参考外围已经定死的主墙面状态（防止大模型把承重墙改成开放门）
        const parentFaceConstraints = {
            posX: parentCell.faceOptions[0],
            negX: parentCell.faceOptions[1],
            posZ: parentCell.faceOptions[4],
            negZ: parentCell.faceOptions[5]
        };

        return {
            roomType: parentCell.room,
            resolution: `${subGridSize}x${subGridSize}`,
            boundaryConstraints: parentFaceConstraints,
            instruction: `This is a local refinement for a ${parentCell.room}. ` +
                `Divide the space into a ${subGridSize}x${subGridSize} grid. ` +
                `Do not violate the external boundary conditions: ${JSON.stringify(parentFaceConstraints)}.`
        };
    }

    /**
     * 2. 【结果整合】将 AI 重新计算的局部高精度结果合并回父级弦粒子
     *
     * @param {Object} parentCell - 原来的宏观格子
     * @param {Object} aiResultJSON - AI 吐出的针对该局部的 4x4 Cells
     * @returns {Object} 经过数据更新和校验后的 ParentCell
     */
    /**
     * Single-cell refinement: attaches AI result as cell.refinement (SPP-Core v1.1).
     * For multi-cell regions, use integratePerCellRefinement instead.
     */
    static integrateSubGrid(parentCell, aiResultJSON) {
        parentCell.refinement = {
            gridX: aiResultJSON.gridX,
            gridZ: aiResultJSON.gridZ,
            cells: aiResultJSON.cells,
        };
        return parentCell;
    }

    /**
     * Region refinement: splits AI's unified NxM sub-grid into per-cell refinements.
     * Each selectedCell gets a scale×scale sub-chunk (ParticleCell.refinement = ParticleChunk).
     *
     * @param {Array} selectedCells - parentCells in the main grid (need position + faceOptions)
     * @param {Object} aiOutput - { scale, gridX, gridZ, cells } from AI (unified sub-grid,
     *   positions [0..gridX-1, 0, 0..gridZ-1] covering the full selection area)
     * @returns {Array} selectedCells with .refinement set on each
     */
    static integratePerCellRefinement(selectedCells, aiOutput) {
        const { scale, cells: subCells } = aiOutput;

        const xs = selectedCells.map(c => c.position[0]);
        const zs = selectedCells.map(c => c.position[2]);
        const minX = Math.min(...xs);
        const minZ = Math.min(...zs);

        for (const parent of selectedCells) {
            const [px, , pz] = parent.position;
            // offset of this parent cell within the selection (in sub-grid coords)
            const ox = (px - minX) * scale;
            const oz = (pz - minZ) * scale;

            parent.refinement = {
                gridX: scale,
                gridZ: scale,
                cells: subCells
                    .filter(c =>
                        c.position[0] >= ox && c.position[0] < ox + scale &&
                        c.position[2] >= oz && c.position[2] < oz + scale
                    )
                    .map(c => ({
                        ...c,
                        position: [c.position[0] - ox, 0, c.position[2] - oz],
                    })),
            };
        }

        return selectedCells;
    }

    /**
     * 3. 【递归铺平与坐标映射】将递归的树状结构降维铺平，供 Three.js 等引擎渲染
     * 采用标准的数学坐标映射矩阵（类似四叉树展开），将逐级的相对坐标转化为绝对的世界坐标。
     *
     * @param {Array} cells - 当前层级的节点数组
     * @param {Array} parentWorldPos - 父级在世界中的起点 [x, y, z]
     * @param {number} parentWorldScale - 父级在世界中的尺寸缩放
     * @returns {Array} 铺平后带有 worldPosition 和 worldScale 的叶子节点（真实的物理像素/网格）
     */
    static flattenRecursiveCells(cells, parentWorldPos = [0, 0, 0], parentWorldScale = 1.0, depth = 0, parentCell = null) {
        let flattenedLeaves = [];

        for (const cell of cells) {
            // SPP-Core v1.1: refinement field (ParticleCell.refinement?: ParticleChunk)
            const sub = cell.refinement || cell.subGrid; // subGrid kept for backward compat
            if (sub && Array.isArray(sub.cells)) {
                // 内部节点：子网格跨度决定每个子 cell 的尺寸
                const gridSpan = Math.max(sub.gridX, sub.gridZ);
                const subCellSize = parentWorldScale / gridSpan;
                const worldX = parentWorldPos[0] + (cell.position[0] * parentWorldScale);
                const worldY = parentWorldPos[1] + (cell.position[1] * parentWorldScale);
                const worldZ = parentWorldPos[2] + (cell.position[2] * parentWorldScale);

                const subCellLeaves = this.flattenRecursiveCells(
                    sub.cells,
                    [worldX, worldY, worldZ],
                    subCellSize,
                    depth + 1,
                    cell  // pass current cell as parent for reverse-lookup
                );
                flattenedLeaves.push(...subCellLeaves);
            } else {
                // 叶子节点：用父级的 scale 作为单格尺寸
                const worldX = parentWorldPos[0] + (cell.position[0] * parentWorldScale);
                const worldY = parentWorldPos[1] + (cell.position[1] * parentWorldScale);
                const worldZ = parentWorldPos[2] + (cell.position[2] * parentWorldScale);
                flattenedLeaves.push({
                    ...cell,
                    worldPosition: [worldX, worldY, worldZ],
                    worldScale: parentWorldScale,
                    _depth: depth,
                    _parentCell: parentCell,  // null for root-level cells
                });
            }
        }

        return flattenedLeaves;
    }

    /**
     * 3b. 【内部节点收集】收集所有有 refinement 的内部节点，附带世界坐标。
     * 供渲染器将这些节点绘制为半透明（表示"已被细化，退为背景"）。
     * 与 flattenRecursiveCells 互补：flat 输出叶子，此函数输出内部节点。
     *
     * @param {Array} cells - 根层 cells
     * @param {Array} parentWorldPos - [x, y, z]
     * @param {number} parentWorldScale - 根 cell 的世界尺寸
     * @param {number} depth - 当前深度
     * @returns {Array} 内部节点数组，每项带 worldPosition, worldScale, _depth
     */
    static collectInteriorNodes(cells, parentWorldPos = [0, 0, 0], parentWorldScale = 1.0, depth = 0) {
        const interiorNodes = [];

        for (const cell of cells) {
            const sub = cell.refinement || cell.subGrid;
            if (sub && Array.isArray(sub.cells)) {
                const gridSpan = Math.max(sub.gridX, sub.gridZ);
                const subCellSize = parentWorldScale / gridSpan;
                const worldX = parentWorldPos[0] + (cell.position[0] * parentWorldScale);
                const worldY = parentWorldPos[1] + (cell.position[1] * parentWorldScale);
                const worldZ = parentWorldPos[2] + (cell.position[2] * parentWorldScale);

                // this cell is an interior node — include it for semi-transparent rendering
                interiorNodes.push({
                    ...cell,
                    worldPosition: [worldX, worldY, worldZ],
                    worldScale: parentWorldScale,
                    _depth: depth,
                });

                // recurse: deeper levels may also have their own interior nodes
                const deeper = this.collectInteriorNodes(
                    sub.cells,
                    [worldX, worldY, worldZ],
                    subCellSize,
                    depth + 1
                );
                interiorNodes.push(...deeper);
            }
        }

        return interiorNodes;
    }

    /**
     * 4. 【批量细化上下文】为多选区域生成统一的 AI Prompt 上下文。
     * 计算选中 cells 的最小外接矩形，提取边界约束（外边缘 faceOptions 不可违背）。
     *
     * @param {Array} selectedCells - 用户选中的 cell 数组（需含 position, room, faceOptions）
     * @param {number} subGridSize - 目标细化精度（AI 可自行选择 2/3/4）
     * @returns {Object} 包含 boundingBox, rooms, boundaryConstraints, instruction
     */
    static createBatchRefineContext(selectedCells) {
        const xs = selectedCells.map(c => c.position[0]);
        const zs = selectedCells.map(c => c.position[2]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minZ = Math.min(...zs), maxZ = Math.max(...zs);

        const selectedSet = new Set(selectedCells.map(c => `${c.position[0]},${c.position[2]}`));

        // For each of the 4 edges, check if any boundary face is Open (id=0).
        // face 1 (-X) → left edge (cells at x=minX, neighbor x-1 outside)
        // face 0 (+X) → right edge (cells at x=maxX, neighbor x+1 outside)
        // face 4 (+Z) → top edge (cells at z=minZ, neighbor z-1 outside per FACE_NEIGHBOR)
        // face 5 (-Z) → bottom edge (cells at z=maxZ, neighbor z+1 outside)
        const EDGE_FACE = {
            left:   { faceIdx: 1, test: c => c.position[0] === minX },
            right:  { faceIdx: 0, test: c => c.position[0] === maxX },
            top:    { faceIdx: 4, test: c => c.position[2] === minZ },
            bottom: { faceIdx: 5, test: c => c.position[2] === maxZ },
        };

        const constraints = {};
        for (const [side, { faceIdx, test }] of Object.entries(EDGE_FACE)) {
            const edgeCells = selectedCells.filter(test);
            const hasOpen = edgeCells.some(c => (c.faceOptions[faceIdx]?.[0] ?? 10) === 0);
            constraints[side] = hasOpen ? 'open' : 'wall';
        }

        const rooms = [...new Set(selectedCells.map(c => c.room).filter(Boolean))];

        return {
            boundingBox: { minX, maxX, minZ, maxZ },
            rooms,
            constraints,   // { left, right, top, bottom } — 'open' | 'wall'
            instruction:
                `Refine the selected region (${minX},${minZ})-(${maxX},${maxZ}) ` +
                `containing rooms: ${rooms.join(', ')}. ` +
                `Choose a scale (2, 3, or 4) based on visual complexity. ` +
                `Boundary connectivity: ${JSON.stringify(constraints)}.`,
        };
    }
}

// ═════════════════════════════════════════════════════════════
// Part 5: Engine Orchestrator
// ═════════════════════════════════════════════════════════════

/**
 * SPPInverseEngine — Orchestrates the full inverse modeling pipeline.
 *
 * The LLM interaction is abstracted via a provider callback, making this
 * engine independent of any specific AI service (Qwen, Gemini, local, etc.).
 */
export class SPPInverseEngine {
    /**
     * @param {Object} options
     * @param {Function} options.llmProvider - async (imageDataUrl, systemPrompt, userText) => string
     *   The callback that performs the actual LLM API call. Receives the image data URL,
     *   the system prompt, and the user text prompt. Must return the raw text response.
     * @param {Function} [options.onStatus] - (message: string) => void
     *   Optional status callback for progress reporting.
     */
    constructor({ llmProvider, onStatus } = {}) {
        if (typeof llmProvider !== 'function') {
            throw new Error('SPPInverseEngine requires a llmProvider function');
        }
        this.llmProvider = llmProvider;
        this.onStatus = onStatus || (() => { });
    }

    /**
     * Step 1: Detect crop bounds + fine-grained grid + room layout.
     *
     * Global call (Phase 1):
     *   analyzeGridSize(imageDataUrl)
     *   → detects crop + overlays grid on full floor plan
     *
     * Local call (Phase 5 recursive):
     *   analyzeGridSize(cropImageDataUrl, { constraints, parentLayout })
     *   → constraints: { left, right, top, bottom: 'open'|'wall' }
     *   → parentLayout: string[][] sub-matrix of parent grid covering this region
     *   → uses STEP1_LOCAL_PROMPT; returns { scale, gridX, gridZ, layout } (no crop field)
     *
     * @param {string} imageDataUrl
     * @param {Object} [localContext] - if provided, runs local refinement mode
     * @returns {Object} { crop?, gridX, gridZ, layout, scale? }
     */
    async analyzeGridSize(imageDataUrl, localContext = null) {
        const isLocal = localContext !== null;

        if (isLocal) {
            const { constraints, parentLayout } = localContext;
            const cols = parentLayout?.[0]?.length ?? '?';
            const rows = parentLayout?.length ?? '?';
            const constraintLines = Object.entries(constraints)
                .map(([side, val]) => `${side}: ${val}`)
                .join('\n');
            const layoutDesc = parentLayout
                ? parentLayout.map(row => row.map(c => c || '(exterior)').join(' | ')).join('\n')
                : '(unknown)';

            const prompt = STEP1_LOCAL_PROMPT
                .replace('__CONSTRAINTS__', constraintLines)
                .replace('__PARENT_LAYOUT__', layoutDesc)
                .replace('__COLS__', String(cols))
                .replace('__ROWS__', String(rows));

            this.onStatus('Phase 5 local Step 1: Refining local grid...');
            const text = await this.llmProvider(
                imageDataUrl,
                prompt,
                'Analyze this cropped floor plan region and generate a fine-grained sub-grid. Return ONLY the JSON.'
            );

            let gridInfo;
            try {
                const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
                gridInfo = JSON.parse(cleaned);
            } catch (e) {
                throw new Error(`Local Step 1 failed to parse: ${e.message}\nRaw: ${text.slice(0, 200)}`);
            }
            if (!gridInfo.gridX || !gridInfo.gridZ || !gridInfo.layout) {
                throw new Error(`Local Step 1 returned invalid grid info: ${JSON.stringify(gridInfo).slice(0, 200)}`);
            }
            this.onStatus(`Local Step 1 done: ${gridInfo.gridX}×${gridInfo.gridZ} sub-grid (scale=${gridInfo.scale}).`);
            return gridInfo;
        }

        this.onStatus('Step 1: Detecting floor plan bounds & analyzing grid layout...');

        const text = await this.llmProvider(
            imageDataUrl,
            STEP1_PROMPT,
            'Analyze this floor plan. First detect the floor plan bounds (crop), then output a fine-grained grid with semantic room names. Return ONLY the JSON.'
        );

        let gridInfo;
        try {
            const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            gridInfo = JSON.parse(cleaned);
        } catch (e) {
            throw new Error(`Step 1 failed to parse grid info: ${e.message}\nRaw: ${text.slice(0, 200)}`);
        }

        if (!gridInfo.gridX || !gridInfo.gridZ || !gridInfo.layout) {
            throw new Error(`Step 1 returned invalid grid info: ${JSON.stringify(gridInfo).slice(0, 200)}`);
        }

        this.onStatus(`Step 1 done: ${gridInfo.gridX}×${gridInfo.gridZ} grid detected.`);
        return gridInfo;
    }

    /**
     * Step 2: Classify each cell's faces based on the grid layout from Step 1.
     *
     * @param {string} imageDataUrl - Base64 data URL of the floor plan image
     * @param {Object} gridInfo - The grid info result from Step 1 { gridX, gridZ, layout }
     * @returns {Object} { gridX, gridZ, description, cells }
     */
    async classifyFaces(imageDataUrl, gridInfo) {
        const layoutStr = gridInfo.layout
            .map((row, z) => `  Row ${z}: ${row.map(c => c || '(exterior)').join(' | ')}`)
            .join('\n');

        const prompt = STEP2_PROMPT
            .replace(/__GRID_X__/g, String(gridInfo.gridX))
            .replace(/__GRID_Z__/g, String(gridInfo.gridZ))
            .replace('__LAYOUT__', layoutStr);

        this.onStatus(`Step 2/2: Classifying ${gridInfo.gridX}×${gridInfo.gridZ} grid faces...`);

        const text = await this.llmProvider(
            imageDataUrl,
            prompt,
            `Classify each cell's face connections. Same-room cells must use open(0) between them. Return ONLY the JSON.`
        );

        const result = parseAIResponse(text);
        this.onStatus(`Step 2 done: ${result.cells.length} cells classified.`);
        return result;
    }

    /**
     * Full two-step reconstruction pipeline.
     *
     * @param {string} imageDataUrl - Base64 data URL of the floor plan image
     * @returns {Object} { gridInfo, cells, description }
     *   - gridInfo: { crop, gridX, gridZ, layout } from Step 1
     *   - cells: normalized ParticleCell array from Step 2
     *   - description: brief description from the AI
     */
    async reconstruct(imageDataUrl) {
        // Phase 1: Detect crop bounds + fine-grained grid + semantic room names
        const gridInfo = await this.analyzeGridSize(imageDataUrl);

        // Phase 2: Binary topology (Wall / Open only — no doors/windows yet)
        const classification = await this.classifyFaces(imageDataUrl, gridInfo);
        const { cells } = classification;

        // Phase 3: AI detects door & window positions from the floor plan image
        let annotations = [];
        try {
            annotations = await this.detectFeatures(imageDataUrl, cells, gridInfo);
        } catch (e) {
            console.warn('Phase 3 feature detection failed, skipping:', e.message);
        }

        // Phase 4: Deterministic piercing — write door/window IDs into faceOptions
        const finalCells = this.pierceFeatures(cells, annotations);

        this.onStatus(`✓ Reconstructed ${finalCells.length} cells (${gridInfo.gridX}×${gridInfo.gridZ} grid)`);

        return {
            gridInfo,
            cells: finalCells,
            description: classification.description,
            gridX: gridInfo.gridX,
            gridZ: gridInfo.gridZ,
        };
    }

    /**
     * Phase 3: Feature Detection
     * Third AI call — given the floor plan image and binary topology,
     * identifies door and window positions as face-level annotations.
     *
     * @param {string} imageDataUrl
     * @param {Array} cells - cells from Phase 2 (with room field)
     * @param {Object} gridInfo - { gridX, gridZ }
     * @returns {Array} annotations: [{ x, z, face, optionId }, ...]
     */
    async detectFeatures(imageDataUrl, cells, gridInfo) {
        this.onStatus('Step 3/3: Detecting doors and windows...');

        // Build wall-face list for the prompt
        const wallFaces = [];
        for (const cell of cells) {
            const [x, , z] = cell.position;
            cell.faceOptions.forEach((opts, face) => {
                if (opts[0] === 10) wallFaces.push({ x, z, face });
            });
        }

        const prompt = STEP3_PROMPT
            .replace(/__GRID_X__/g, String(gridInfo.gridX))
            .replace(/__GRID_Z__/g, String(gridInfo.gridZ))
            .replace('__WALL_FACES__', JSON.stringify(wallFaces));

        const text = await this.llmProvider(
            imageDataUrl,
            prompt,
            'Identify all doors and windows in the floor plan. Return ONLY the JSON array.'
        );

        // Parse: expect a JSON array
        let cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const arrStart = cleaned.indexOf('[');
        const arrEnd = cleaned.lastIndexOf(']');
        if (arrStart === -1 || arrEnd === -1) {
            console.warn('Phase 3: no JSON array found, assuming no doors/windows');
            return [];
        }
        const annotations = JSON.parse(cleaned.substring(arrStart, arrEnd + 1));

        this.onStatus(`Step 3 done: ${annotations.length} features detected.`);
        return annotations;
    }

    /**
     * Phase 4: Feature Piercing (deterministic)
     * Writes door/window option IDs into the cells' faceOptions.
     * Only replaces faces currently set to Wall (id=10) — never touches Open faces.
     *
     * @param {Array} cells - cells from Phase 2
     * @param {Array} annotations - [{ x, z, face, optionId }, ...] from Phase 3
     * @returns {Array} updated cells
     */
    pierceFeatures(cells, annotations) {
        if (!annotations || annotations.length === 0) return cells;

        const cellMap = new Map(
            cells.map(c => [`${c.position[0]},${c.position[2]}`, c])
        );

        for (const ann of annotations) {
            const cell = cellMap.get(`${ann.x},${ann.z}`);
            if (!cell) continue;
            if (ann.face < 0 || ann.face > 5) continue;
            const currentId = cell.faceOptions[ann.face]?.[0];
            // Only pierce walls — never overwrite Open connections
            if (currentId === 10) {
                cell.faceOptions[ann.face] = [ann.optionId];
            }
        }

        return cells;
    }
}
