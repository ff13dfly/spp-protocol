/**
 * run-new-pipeline.mjs
 * 用新的"门优先"流程对 mock-floorplan.png 跑一遍：
 *   Step 0: 千问检测门符号
 *   Step 1: 封闭门洞（canvas）
 *   Step 3A: 千问识别房间列表（在封闭图上）
 *   Step 3B: 计算网格尺寸（确定性）
 *   Step 3C: 千问填充网格（在封闭图上）
 *   Step 6: 门坐标映射到网格
 * 把结果存到 pipeline-result.json，供更新 mock 数据使用
 */

import fs   from 'fs';
import path from 'path';
import https from 'https';
import { createCanvas, loadImage } from '../scripts/node_modules/canvas/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const QWEN_API_KEY = 'REDACTED-QWEN-KEY';
const IMAGE_PATH   = path.resolve('spp-examples/inverse-demo-v2/assets/floorplan.png');
const OUTPUT_FILE  = path.resolve('scripts/pipeline-result.json');

// ─── Prompts (与 spp-inverse-engine.js 一致) ──────────────────────────────────
const STEP0_DOOR_PROMPT = `You are analyzing an architectural floor plan image.

Detect ALL door symbols visible in the image. Door symbols appear as:
- An arc (quarter-circle) showing the door's swing path
- A straight line at the base of the arc (the door leaf)
- Together they indicate a door opening cut into a wall

For each door, return its position as normalized coordinates (0.0–1.0 relative to the FULL image size).

Return ONLY a JSON array — no markdown, no explanation:
[
  { "cx": 0.45, "cy": 0.32, "width": 0.05, "angle": 90 },
  ...
]

Where:
- cx, cy : center of the door opening (normalized 0–1 relative to full image)
- width  : door opening width as a fraction of image width (typically 0.03–0.10)
- angle  : 0 = door is in a HORIZONTAL wall (wall runs left-right),
           90 = door is in a VERTICAL wall (wall runs up-down)

Return [] if no door symbols are visible.`;

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
Reference room names (use these for consistency, but prioritize what you visually see over this list): __ROOM_LIST__

## Coordinate system
- Row 0 = TOP of the floor plan image; last row = BOTTOM.
- Column 0 = LEFT side; last column = RIGHT.

## Rules
1. Output EXACTLY __GRID_Z__ rows, each with EXACTLY __GRID_X__ elements.
2. Each cell must be a room name string, OR null if outside the outer walls.
3. Each room should ideally form a contiguous rectangular block. However, follow the actual visual boundaries — corridors, hallways, and irregular spaces may be L-shaped or non-rectangular.
4. Larger rooms occupy more cells; smaller rooms occupy fewer.
5. CRITICAL: No row may be entirely null. No column may be entirely null. The grid must be flush with the floor plan boundary on all four sides — do NOT add null padding at the left, right, top, or bottom.
6. Every distinct space visible in the floor plan must appear at least once.
7. Use standard English title case for room names (e.g. "Kitchen", "Living Room") — do NOT write them in ALL CAPS.

## Output
Return ONLY a JSON 2D array. No explanations, no markdown fences.
[
  ["RoomName", ...],   ← row 0 = TOP; element 0 = LEFT, element __GRID_X_LAST__ = RIGHT
  ...
]`;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function httpPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST', headers }, res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

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

function parseJSON(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
    return JSON.parse(cleaned.substring(s, e + 1));
}

function computeGridDimensions(aspectRatio, roomCount) {
    const targetCells = Math.max(48, roomCount * 10);
    let gridZ = Math.round(Math.sqrt(targetCells / Math.max(0.5, aspectRatio)));
    let gridX = Math.round(gridZ * Math.max(0.5, aspectRatio));
    gridX = Math.max(5, Math.min(14, gridX));
    gridZ = Math.max(4, Math.min(12, gridZ));
    return { gridX, gridZ };
}

function mapDoorsToGrid(doorSymbols, cropInfo, gridInfo) {
    const { gridX, gridZ } = gridInfo;
    const annotations = [];
    const seen = new Set();
    for (const door of doorSymbols) {
        const relX = (door.cx - cropInfo.x) / cropInfo.w;
        const relZ = (door.cy - cropInfo.y) / cropInfo.h;
        if (relX < 0 || relX > 1 || relZ < 0 || relZ > 1) continue;
        const ang = door.angle || 0;
        let x, z, face;
        if (Math.abs(ang - 90) < 45) {
            x = Math.round(relX * gridX) - 1;
            z = Math.floor(relZ * gridZ);
            face = 0;
        } else {
            x = Math.floor(relX * gridX);
            z = Math.round(relZ * gridZ) - 1;
            face = 4;
        }
        if (x < 0 || x >= gridX || z < 0 || z >= gridZ) continue;
        const key = `${x},${z},${face}`;
        if (!seen.has(key)) { seen.add(key); annotations.push({ x, z, face, optionId: 2 }); }
    }
    return annotations;
}

// ─── Step 1: Seal door openings using canvas ──────────────────────────────────
async function sealDoorOpenings(imgBuffer, doorSymbols) {
    const img    = await loadImage(imgBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    if (doorSymbols.length > 0) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth   = Math.max(3, img.width * 0.006);
        ctx.lineCap     = 'round';

        for (const door of doorSymbols) {
            const cx  = door.cx * img.width;
            const cy  = door.cy * img.height;
            const hl  = (door.width * img.width) / 2;
            const ang = door.angle || 0;
            ctx.beginPath();
            if (Math.abs(ang - 90) < 45) {
                ctx.moveTo(cx, cy - hl); ctx.lineTo(cx, cy + hl);
            } else {
                ctx.moveTo(cx - hl, cy); ctx.lineTo(cx + hl, cy);
            }
            ctx.stroke();
        }
    }
    return canvas.toBuffer('image/png');
}

// ─── PNG dimensions ───────────────────────────────────────────────────────────
function getPngDimensions(buf) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log('新流程测试: mock-floorplan.png');
console.log('='.repeat(60));

const imgBuf    = fs.readFileSync(IMAGE_PATH);
const { width, height } = getPngDimensions(imgBuf);
const aspectRatio = width / height;
console.log(`图片: ${width}×${height}, aspect=${aspectRatio.toFixed(2)}`);

// Crop 用 mock 已知值（和 buildMockData 一致）
const cropInfo = { x: 0.12, y: 0.12, w: 0.76, h: 0.76 };

// ─── Step 0: 门符号检测 ───────────────────────────────────────────────────────
console.log('\n── Step 0: 检测门符号 ──');
const origBase64 = imgBuf.toString('base64');
const doorRaw    = await callQwen(origBase64, 'image/png', STEP0_DOOR_PROMPT,
    'Detect all door symbols in this floor plan. Return ONLY the JSON array.');
console.log('原始输出:', doorRaw);

let doorSymbols = [];
try { doorSymbols = parseJSON(doorRaw); } catch {}
console.log(`→ 检测到 ${doorSymbols.length} 个门:`);
doorSymbols.forEach((d, i) => console.log(`  [${i}] cx=${d.cx.toFixed(3)} cy=${d.cy.toFixed(3)} w=${d.width} angle=${d.angle}`));

// ─── Step 1: 封闭门洞 ────────────────────────────────────────────────────────
console.log('\n── Step 1: 封闭门洞 ──');
const sealedBuf    = await sealDoorOpenings(imgBuf, doorSymbols);
const sealedBase64 = sealedBuf.toString('base64');
fs.writeFileSync('scripts/sealed-floorplan.png', sealedBuf);
console.log(`→ 已保存封闭图: scripts/sealed-floorplan.png`);

// ─── Step 3A: 房间列表（封闭图） ─────────────────────────────────────────────
console.log('\n── Step 3A: 识别房间（封闭图）──');
const roomsRaw = await callQwen(sealedBase64, 'image/png', STEP1A_ROOMS_PROMPT,
    'List all rooms visible in this floor plan. Return ONLY the JSON array.');
console.log('原始输出:', roomsRaw);
let rooms = [];
try { rooms = parseJSON(roomsRaw); } catch {}
console.log(`→ ${rooms.length} 个房间: ${rooms.join(', ')}`);

// ─── Step 3B: 计算网格尺寸 ───────────────────────────────────────────────────
const { gridX, gridZ } = computeGridDimensions(aspectRatio, rooms.length);
console.log(`\n── Step 3B: 网格尺寸 → ${gridX}×${gridZ} (aspect=${aspectRatio.toFixed(2)}, rooms=${rooms.length})`);

// ─── Step 3C: 填充网格（封闭图） ─────────────────────────────────────────────
console.log('\n── Step 3C: 填充网格（封闭图）──');
const gridPrompt = STEP1C_GRID_PROMPT
    .replace(/__GRID_X_LAST__/g, String(gridX - 1))
    .replace(/__GRID_X__/g, String(gridX))
    .replace(/__GRID_Z__/g, String(gridZ))
    .replace('__ROOM_LIST__', rooms.map(r => `"${r}"`).join(', '));
const layoutRaw = await callQwen(sealedBase64, 'image/png', gridPrompt,
    `Fill the ${gridX}×${gridZ} grid with room names. Return ONLY the JSON 2D array.`);
console.log('原始输出:', layoutRaw);
let layout = [];
try {
    const cleaned = layoutRaw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
    layout = JSON.parse(cleaned.substring(s, e + 1))
        .map(row => row.map(cell =>
            (cell === null || cell === 'null' || cell === 'NULL' || cell === '') ? null : cell
        ));
} catch (err) { console.error('layout 解析失败:', err.message); }
console.log(`→ layout ${layout.length} rows × ${layout[0]?.length} cols:`);
layout.forEach((row, z) => console.log(`  row${z}: ${row.map(r => r || '·').join(' | ')}`));

// ─── Step 6: 门坐标映射 ───────────────────────────────────────────────────────
console.log('\n── Step 6: 门坐标映射到网格 ──');
const doorAnnotations = mapDoorsToGrid(doorSymbols, cropInfo, { gridX, gridZ });
console.log(`→ ${doorAnnotations.length} 个门注解:`);
doorAnnotations.forEach(a => console.log(`  (x=${a.x}, z=${a.z}, face=${a.face}, optionId=${a.optionId})`));

// ─── 保存结果 ─────────────────────────────────────────────────────────────────
const result = {
    testedAt: new Date().toISOString(),
    image: 'mock-floorplan.png',
    cropInfo,
    step0_doorSymbols: doorSymbols,
    step3_rooms: rooms,
    step3_gridX: gridX,
    step3_gridZ: gridZ,
    step3_layout: layout,
    step6_doorAnnotations: doorAnnotations,
};
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
console.log(`\n✅ 结果保存到 ${OUTPUT_FILE}`);
