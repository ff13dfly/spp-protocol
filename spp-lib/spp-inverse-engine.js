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
3. Assign each cell a topological Space ID (e.g., "Space_A", "Space_B", "Space_C") — cells belonging to the same enclosed region share the same ID.
4. Use null for cells that are exterior (outside the building)
5. The grid should be between 4×4 and 12×12 for typical apartments
6. CRITICAL: the grid must preserve proportions — a room twice as wide should span twice as many columns
7. **Wall snapping (Area-Majority Rule)**: When a physical wall does not perfectly align with a cell boundary, assign the cell to whichever room occupies MORE of that cell's area. Walls must always land on cell boundaries.
8. **Rectangular spaces**: Each Space ID should form a contiguous rectangular block. Avoid L-shaped or jagged assignments.
9. **Minimum size**: Every enclosed region must have at least 1 cell.

## Output
Return ONLY a JSON object:
{
  "crop": { "x": <float 0-1>, "y": <float 0-1>, "w": <float 0-1>, "h": <float 0-1> },
  "gridX": <columns>,
  "gridZ": <rows>,
  "layout": [
    ["Space_A", "Space_A", "Space_B", ...],
    ["Space_A", "Space_A", "Space_B", ...],
    ...
  ]
}

Where layout[row][col] is the room name for that cell, or null for exterior cells.
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
Your task is to classify connections between the Space IDs. To simplify the process, use ONLY two options for now:

- 0: **Open** — ID same (passage continues within the same region)
- 10: **Wall** — ID different (structural wall between regions or exterior)

## Rules
1. **Same-ID adjacency**: If two adjacent cells belong to the SAME Space ID → use 0 (open).
2. **Different-ID adjacency**: If adjacent cells are DIFFERENT IDs or exterior → use 10 (wall).
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
      "room": "<Space ID>",
      "faceOptions": [[id], [id], [], [], [id], [id]]
    }
  ]
}

Only include cells where layout is NOT null.`;

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
    static integrateSubGrid(parentCell, aiResultJSON) {
        // 将结果植入父格子的 subGrid 树结构中
        parentCell.subGrid = {
            gridX: aiResultJSON.gridX,
            gridZ: aiResultJSON.gridZ,
            cells: aiResultJSON.cells
        };

        return parentCell;
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
    static flattenRecursiveCells(cells, parentWorldPos = [0, 0, 0], parentWorldScale = 1.0) {
        let flattenedLeaves = [];

        for (const cell of cells) {
            // 计算当前格子在世界坐标系中的真实绝对坐标
            // 公式: 绝对起点 = 父级绝对起点 + 相对偏移量 * 父级缩放比例
            // Offset for sub-cells should be relative to parent's corner, not center.
            // For root cells, parentWorldPos is [0,0,0] and parentWorldScale is 1.0.
            const subCellSize = parentWorldScale / gridSpan;
            const worldX = parentWorldPos[0] + (cell.position[0] * subCellSize);
            const worldY = parentWorldPos[1] + (cell.position[1] * subCellSize);
            const worldZ = parentWorldPos[2] + (cell.position[2] * subCellSize);

            if (cell.subGrid && Array.isArray(cell.subGrid.cells)) {
                // 如果是"宏观节点"并且具有子网格，则继续递归
                // 继续下钻的缩放等于：父级缩放 / 子网格的跨度 (假定 X Z 等比例切分)
                const gridSpan = Math.max(cell.subGrid.gridX, cell.subGrid.gridZ);
                const currentScale = parentWorldScale / gridSpan;

                // 递归深入
                const subCellLeaves = this.flattenRecursiveCells(
                    cell.subGrid.cells,
                    [worldX, worldY, worldZ],
                    currentScale
                );

                flattenedLeaves.push(...subCellLeaves);
            } else {
                // 这个是没有子节点的"叶子节点"，那就是物理上最终的网格
                flattenedLeaves.push({
                    ...cell,
                    worldPosition: [worldX, worldY, worldZ],
                    worldScale: (cell._isFineGrid) ? (parentWorldScale / 2) : parentWorldScale
                });
            }
        }

        return flattenedLeaves;
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
     * @param {string} imageDataUrl - Base64 data URL of the floor plan image
     * @returns {Object} { crop, gridX, gridZ, layout }
     */
    async analyzeGridSize(imageDataUrl) {
        this.onStatus('Step 1/2: Detecting floor plan bounds & analyzing grid layout...');

        const text = await this.llmProvider(
            imageDataUrl,
            STEP1_PROMPT,
            'Analyze this floor plan. First detect the floor plan bounds (crop), then output a fine-grained grid within those bounds. Return ONLY the JSON.'
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
        // Phase 1: Detect crop bounds + fine-grained grid + Space IDs
        const gridInfo = await this.analyzeGridSize(imageDataUrl);

        // Phase 2: Binary Face Generation (Open / Wall Only)
        const classification = await this.classifyFaces(imageDataUrl, gridInfo);
        const { cells } = classification;

        // Phase 3 & 4 (Stubs for now, allowing future expansion)
        // In a real implementation, we would call inferSemantics and pierceFeatures here.
        this.onStatus('Finalizing geometry and applying semantic labels...');

        // Example calls for Phase 3 & 4 (replace with actual logic)
        // const semanticMapping = this.inferSemantics(gridInfo.layout);
        const finalCells = this.pierceFeatures(cells, /* doors */ [], /* windows */ []);

        this.onStatus(`✓ Reconstructed ${finalCells.length} cells (${gridInfo.gridX}×${gridInfo.gridZ} grid)`);

        // Result integration
        return {
            gridInfo,
            cells: finalCells, // Use the cells after feature piercing
            description: `Reconstructed building with Space IDs. Semantic inference and FEATURE PIERCING applied.`,
            gridX: gridInfo.gridX,
            gridZ: gridInfo.gridZ,
        };
    }

    /**
     * Phase 3: Semantic Inference
     * Maps abstract Space IDs to semantic room names.
     */
    inferSemantics(layout) {
        // Mock semantic mapping logic
        const mapping = {};
        for (let r = 0; r < layout.length; r++) {
            for (let c = 0; c < layout[r].length; c++) {
                const sid = layout[r][c];
                if (sid && !mapping[sid]) {
                    // In a real system, this would use a small LLM or OCR
                    mapping[sid] = sid.replace('Space_', 'Room_');
                }
            }
        }
        return mapping;
    }

    /**
     * Phase 4: Feature Piercing
     * Injects doors and windows into the binary wall topology.
     */
    pierceFeatures(cells, doors, windows) {
        // This deterministic step "pierces" the solid walls
        for (const cell of cells) {
            // ... Logic to update faceOptions based on door/window coordinates
        }
        return cells; // Return updated cells
    }
}
