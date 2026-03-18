/**
 * compare-llm.mjs — 全流程对比 Qwen vs Claude
 * 用法: node scripts/compare-llm.mjs [image-path]
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

// ─── Config ───────────────────────────────────────────────────────────────────
const QWEN_API_KEY    = 'REDACTED-QWEN-KEY';
const CLAUDE_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const OUTPUT_FILE     = path.resolve('scripts/compare-result.json');

// ─── Prompts ──────────────────────────────────────────────────────────────────
const STEP1A_ROOMS_PROMPT = `You are analyzing a floor plan image.

List every clearly enclosed room or functional space that has its own surrounding walls.

Return ONLY a JSON array of room name strings. No extra text, no markdown.
Example: ["Kitchen", "Living Room", "Bedroom", "Bathroom", "Hallway"]

Rules:
- Only include spaces that are clearly enclosed by walls on the floor plan
- Do NOT list "Entrance", "Entry", "Foyer", or "Corridor" unless it is a large, clearly labeled dedicated room with its own four walls — small transitional areas near the front door are part of the hallway
- Use standard English names
- If there are multiple bedrooms, name them "Bedroom 1", "Bedroom 2", etc.
- Do NOT include null, exterior, or outside areas`;

const STEP1C_GRID_PROMPT = `You are filling a floor plan grid.

The floor plan has been divided into a __GRID_X__ × __GRID_Z__ grid (__GRID_X__ columns, __GRID_Z__ rows).
Known rooms in this floor plan: __ROOM_LIST__

## Coordinate system
- Row 0 = TOP of the floor plan image; last row = BOTTOM.
- Column 0 = LEFT side of the floor plan image; last column = RIGHT.
- layout[row][col]: row increases downward, col increases rightward.
- A room on the LEFT side of the image must occupy columns 0, 1, 2 … (low col index).
- A room on the RIGHT side of the image must occupy columns __GRID_X_LAST__, … (high col index).
- A room at the TOP of the image must occupy rows 0, 1, 2 … (low row index).
- A room at the BOTTOM must occupy high row indices.

## Your task
Assign each grid cell a room name from the list above so the grid accurately represents the floor plan layout.

## Rules
1. Output EXACTLY __GRID_Z__ rows, each with EXACTLY __GRID_X__ elements.
2. Each cell must be one of the room names listed above, OR null if it is clearly outside the outer walls.
3. Each room must form a single contiguous rectangular block — no L-shapes, no diagonal assignments.
4. Larger rooms occupy more cells; smaller rooms occupy fewer — preserve real proportions.
5. CRITICAL: No row may be entirely null. No column may be entirely null. The grid must be tight to the floor plan boundary.
6. Every room from the list must appear at least once.

## Output
Return ONLY a JSON 2D array. No explanations, no markdown fences.
[
  ["RoomName", "RoomName", ...],   ← row 0 = TOP of floor plan; element 0 = LEFT, element __GRID_X_LAST__ = RIGHT
  ["RoomName", "RoomName", ...],   ← row 1
  ...                               ← __GRID_Z__ rows total
]`;

const STEP3_PROMPT = `You are an SPP feature detector. Given a floor plan image and an existing binary wall topology, identify all doors and windows.

## Coordinate system
- x = column index, 0 = LEFT side of image, increases rightward.
- z = row index, 0 = TOP of image, increases downward.
- Cell (x=0, z=0) is the top-left corner of the floor plan.

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
   - face 4 = +Z (bottom edge of cell)
   - face 5 = -Z (top edge of cell)
2. Classify it:
   - optionId 1 = single door (small opening)
   - optionId 2 = double door (wider opening)
   - optionId 20 = window (exterior wall only)

## Output
Return ONLY a JSON array:
[
  { "x": <col>, "z": <row>, "face": <0|1|4|5>, "optionId": <1|2|20> },
  ...
]

Return [] if no doors or windows are visible.`;

// ─── Deterministic helpers (ported from spp-inverse-engine.js) ────────────────
function parseRoomList(text) {
    try {
        const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
        if (s === -1 || e === -1) throw new Error('no array');
        const arr = JSON.parse(cleaned.substring(s, e + 1));
        if (Array.isArray(arr) && arr.length > 0 && arr.every(r => typeof r === 'string')) {
            return arr.filter(r => r.trim().length > 0);
        }
    } catch {}
    return ['Living Room', 'Kitchen', 'Bedroom', 'Bathroom', 'Hallway'];
}

function computeGridDimensions(aspectRatio, roomCount) {
    const targetCells = Math.max(48, roomCount * 10);
    let gridZ = Math.round(Math.sqrt(targetCells / Math.max(0.5, aspectRatio)));
    let gridX = Math.round(gridZ * Math.max(0.5, aspectRatio));
    gridX = Math.max(5, Math.min(14, gridX));
    gridZ = Math.max(4, Math.min(12, gridZ));
    return { gridX, gridZ };
}

function generateCellsFromLayout(layout, gridX, gridZ) {
    const windowRooms = new Set(['Kitchen', 'Living Room', 'Bedroom', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3']);
    function faceValue(x, z, nx, nz) {
        const room = layout[z]?.[x];
        const neighbor = layout[nz]?.[nx];
        if (nx < 0 || nx >= gridX || nz < 0 || nz >= gridZ || !neighbor) {
            return windowRooms.has(room) ? [20] : [10];
        }
        if (room === neighbor) return [0];
        return [10];
    }
    const cells = [];
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const room = layout[z]?.[x];
            if (!room) continue;
            cells.push({
                position: [x, 0, z],
                room,
                faceOptions: [
                    faceValue(x, z, x + 1, z),
                    faceValue(x, z, x - 1, z),
                    [], [],
                    faceValue(x, z, x, z + 1),
                    faceValue(x, z, x, z - 1),
                ],
            });
        }
    }
    return cells;
}

function pierceFeatures(cells, annotations) {
    if (!annotations || annotations.length === 0) return cells;
    const cellMap = new Map(cells.map(c => [`${c.position[0]},${c.position[2]}`, c]));
    const FACE_DIR = { 0: [1,0], 1: [-1,0], 4: [0,1], 5: [0,-1] };
    const MIRROR   = { 0: 1, 1: 0, 4: 5, 5: 4 };
    const MAX_ANNOTATIONS = Math.max(8, cells.length * 2);
    if (annotations.length > MAX_ANNOTATIONS) return cells;

    for (const { x, z, face, optionId } of annotations) {
        const cell = cellMap.get(`${x},${z}`);
        if (!cell) continue;
        if (![0,1,4,5].includes(face)) continue;
        if (![1,2,20].includes(optionId)) continue;
        if ((cell.faceOptions[face]?.[0] ?? 10) !== 10) continue;
        const [dx, dz] = FACE_DIR[face];
        const neighbor = cellMap.get(`${x+dx},${z+dz}`);
        if (!neighbor) continue; // exterior — skip
        cell.faceOptions[face] = [optionId];
        neighbor.faceOptions[MIRROR[face]] = [optionId];
    }
    return cells;
}

function parseLayout(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('no array found');
    return JSON.parse(cleaned.substring(s, e + 1));
}

function parseAnnotations(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    return JSON.parse(cleaned.substring(s, e + 1));
}

// ─── PNG dimensions reader ────────────────────────────────────────────────────
function getPngDimensions(filePath) {
    const buf = fs.readFileSync(filePath);
    // PNG: bytes 16-19 = width, 20-23 = height (big-endian)
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { width: w, height: h };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── LLM Providers ───────────────────────────────────────────────────────────
async function callQwen(base64, mime, systemPrompt, userText) {
    const payload = JSON.stringify({
        model: 'qwen-vl-max',
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
                { type: 'text', text: systemPrompt + '\n\n' + userText },
            ],
        }],
        max_tokens: 3000,
    });
    const res = await httpPost(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        { 'Content-Type': 'application/json', Authorization: `Bearer ${QWEN_API_KEY}` },
        payload
    );
    if (res.status !== 200) throw new Error(`Qwen ${res.status}: ${res.body}`);
    return JSON.parse(res.body).choices?.[0]?.message?.content ?? '';
}

async function callClaude(base64, mime, systemPrompt, userText) {
    if (!CLAUDE_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const payload = JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
                { type: 'text', text: userText },
            ],
        }],
    });
    const res = await httpPost(
        'https://api.anthropic.com/v1/messages',
        { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        payload
    );
    if (res.status !== 200) throw new Error(`Claude ${res.status}: ${res.body}`);
    return JSON.parse(res.body).content?.[0]?.text ?? '';
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────
async function runPipeline(modelName, callFn, base64, mime, aspectRatio) {
    const log = (msg) => console.log(`  [${modelName}] ${msg}`);
    const result = {
        model: modelName,
        steps: {},
        error: null,
        finalCells: null,
        summary: {},
    };

    try {
        // ── Step 1A: Room list ────────────────────────────────────────────────
        log('Step 1A: 识别房间...');
        const t1a = Date.now();
        const roomsRaw = await callFn(base64, mime,
            STEP1A_ROOMS_PROMPT,
            'List all rooms visible in this floor plan. Return ONLY the JSON array.'
        );
        const rooms = parseRoomList(roomsRaw);
        result.steps.step1a = { durationMs: Date.now() - t1a, raw: roomsRaw, parsed: rooms };
        log(`  → ${rooms.length} 个房间: ${rooms.join(', ')}`);

        // ── Step 1B: Compute grid size ────────────────────────────────────────
        const { gridX, gridZ } = computeGridDimensions(aspectRatio, rooms.length);
        result.steps.step1b = { gridX, gridZ, aspectRatio, roomCount: rooms.length };
        log(`Step 1B: 网格尺寸 ${gridX}×${gridZ} (aspect=${aspectRatio.toFixed(2)})`);

        // ── Step 1C: Fill grid ────────────────────────────────────────────────
        log('Step 1C: 填充网格...');
        const gridPrompt = STEP1C_GRID_PROMPT
            .replace(/__GRID_X_LAST__/g, String(gridX - 1))
            .replace(/__GRID_X__/g, String(gridX))
            .replace(/__GRID_Z__/g, String(gridZ))
            .replace('__ROOM_LIST__', rooms.map(r => `"${r}"`).join(', '));
        const t1c = Date.now();
        const layoutRaw = await callFn(base64, mime,
            gridPrompt,
            `Fill the ${gridX}×${gridZ} grid with room names. Return ONLY the JSON 2D array.`
        );
        const layout = parseLayout(layoutRaw);
        result.steps.step1c = { durationMs: Date.now() - t1c, raw: layoutRaw, parsed: layout };
        log(`  → layout ${layout.length} rows × ${layout[0]?.length ?? 0} cols`);

        // ── Phase 2: Deterministic wall topology ──────────────────────────────
        const cells = generateCellsFromLayout(layout, gridX, gridZ);
        const wallFaces = [];
        for (const c of cells) {
            const [x,,z] = c.position;
            c.faceOptions.forEach((opts, face) => {
                if (opts[0] === 10) wallFaces.push({ x, z, face });
            });
        }
        result.steps.phase2 = { cellCount: cells.length, wallFaceCount: wallFaces.length };
        log(`Phase 2: ${cells.length} cells, ${wallFaces.length} wall faces (deterministic)`);

        // ── Step 3: Detect doors & windows ───────────────────────────────────
        log('Step 3: 检测门窗...');
        const step3Prompt = STEP3_PROMPT
            .replace(/__GRID_X__/g, String(gridX))
            .replace(/__GRID_Z__/g, String(gridZ))
            .replace('__WALL_FACES__', JSON.stringify(wallFaces));
        const t3 = Date.now();
        const annotationsRaw = await callFn(base64, mime,
            step3Prompt,
            'Identify all doors and windows in the floor plan. Return ONLY the JSON array.'
        );
        const annotations = parseAnnotations(annotationsRaw);
        result.steps.step3 = { durationMs: Date.now() - t3, raw: annotationsRaw, parsed: annotations };
        log(`  → ${annotations.length} 个门/窗`);

        // ── Phase 4: Pierce features ──────────────────────────────────────────
        const finalCells = pierceFeatures(cells, annotations);
        const doors = finalCells.flatMap(c =>
            c.faceOptions.flatMap((opts, fi) =>
                [1,2].includes(opts[0]) ? [{ pos: c.position, face: fi, type: opts[0] }] : []
            )
        );
        const windows = finalCells.flatMap(c =>
            c.faceOptions.flatMap((opts, fi) =>
                opts[0] === 20 ? [{ pos: c.position, face: fi }] : []
            )
        );
        result.steps.phase4 = { doorsInserted: doors.length / 2, windowFaces: windows.length };
        result.finalCells = finalCells;
        result.summary = {
            gridX, gridZ,
            rooms: rooms.length,
            roomNames: rooms,
            cells: finalCells.length,
            wallFaces: wallFaces.length,
            doorsDetected: annotations.filter(a => [1,2].includes(a.optionId)).length,
            windowsDetected: annotations.filter(a => a.optionId === 20).length,
            totalDurationMs:
                (result.steps.step1a.durationMs || 0) +
                (result.steps.step1c.durationMs || 0) +
                (result.steps.step3.durationMs || 0),
        };
        log(`✓ 完成 — 总耗时 ${result.summary.totalDurationMs}ms`);

    } catch (err) {
        result.error = err.message;
        log(`✗ 错误: ${err.message}`);
    }

    return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const imagePath = process.argv[2] || path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../spp-examples/inverse-demo-v2/assets/mock-floorplan.png'
);

if (!fs.existsSync(imagePath)) {
    console.error(`图片不存在: ${imagePath}`);
    process.exit(1);
}

const ext = path.extname(imagePath).toLowerCase();
const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
const base64 = fs.readFileSync(imagePath).toString('base64');
const { width, height } = ext === '.png'
    ? getPngDimensions(imagePath)
    : { width: 1, height: 1 };  // JPEG: fallback to 1:1 (or use jimp)
const aspectRatio = width / height;

console.log(`\n图片: ${path.basename(imagePath)}  (${width}×${height}, aspect=${aspectRatio.toFixed(2)})`);
console.log('='.repeat(60));

const models = [
    { name: 'Qwen (qwen-vl-max)', fn: callQwen },
    ...(CLAUDE_API_KEY ? [{ name: 'Claude (claude-opus-4-6)', fn: callClaude }] : []),
];

if (!CLAUDE_API_KEY) {
    console.log('⚠️  未设置 ANTHROPIC_API_KEY，跳过 Claude 对比\n');
}

const results = [];
for (const { name, fn } of models) {
    console.log(`\n▶ ${name}`);
    const r = await runPipeline(name, fn, base64, mime, aspectRatio);
    results.push(r);
}

// ── Save JSON ─────────────────────────────────────────────────────────────────
const output = {
    testedAt: new Date().toISOString(),
    image: path.basename(imagePath),
    imageDimensions: { width, height, aspectRatio },
    results,
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
console.log(`\n✅ 结果已保存到 ${OUTPUT_FILE}`);

// ── Print diff summary ────────────────────────────────────────────────────────
if (results.length >= 2) {
    const [a, b] = results;
    console.log('\n' + '─'.repeat(60));
    console.log('对比摘要:');
    console.log(`  房间数:   ${a.summary.rooms ?? 'err'} vs ${b.summary.rooms ?? 'err'}`);
    console.log(`  网格:     ${a.summary.gridX}×${a.summary.gridZ} vs ${b.summary.gridX}×${b.summary.gridZ}`);
    console.log(`  Cell数:   ${a.summary.cells ?? 'err'} vs ${b.summary.cells ?? 'err'}`);
    console.log(`  门检测:   ${a.summary.doorsDetected ?? 'err'} vs ${b.summary.doorsDetected ?? 'err'}`);
    console.log(`  窗检测:   ${a.summary.windowsDetected ?? 'err'} vs ${b.summary.windowsDetected ?? 'err'}`);
    console.log(`  总耗时:   ${a.summary.totalDurationMs}ms vs ${b.summary.totalDurationMs}ms`);
}
