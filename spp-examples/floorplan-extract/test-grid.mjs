/**
 * test-grid.mjs
 * 网格分类方案：AI 在粗网格上做空间分类，不输出坐标
 *   Step 1: AI 粗网格分类（8×8 → 每格填空间 ID）
 *   Step 2: 识别边界格
 *   Step 3: AI 对边界格递归细化（裁剪子图 → 细分类）
 *   Step 4: Canvas 绘制结果
 *
 * Usage: node spp-examples/floorplan-extract/test-grid.mjs
 */

import fs   from 'fs';
import path from 'path';
import https from 'https';
import { createCanvas, loadImage } from '../../scripts/node_modules/canvas/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const IMAGE_PATH   = path.resolve('spp-examples/inverse-demo-v2/assets/floorplan.png');
const OUTPUT_IMAGE = path.resolve('spp-examples/floorplan-extract/grid-result.png');
const OUTPUT_JSON  = path.resolve('spp-examples/floorplan-extract/grid-result.json');

const GRID_X = 8;
const GRID_Z = 6;
const REFINE_SCALE = 3;
const MAX_DEPTH = 2;

// ─── Prompts ─────────────────────────────────────────────────────────────────

const COARSE_PROMPT = `你正在分析一张户型图（房屋平面图）。

仔细观察图片中的墙壁（黑色粗线），识别每个独立封闭区域（房间）。

对每个房间，输出一行 JSON 对象：
{"id":"A", "name":"主卧", "x1":15, "y1":0, "x2":45, "y2":40}

其中 x1,y1,x2,y2 是该房间在图片中的百分比范围（0-100）。
x 从左到右，y 从上到下。

规则：
- 每个被墙壁围起来的独立区域都是一个房间
- 建筑外部区域（花园、阳台等室外部分）也列出，标注 "outside":true
- 门是墙上的开口，门两边是不同的房间
- 注意走廊、卫生间等小空间也要独立识别

仅返回 JSON 数组，不要其他文字：
[{"id":"A","name":"主卧","x1":15,"y1":0,"x2":45,"y2":40}, ...]`;

const REFINE_PROMPT = `You are analyzing a CROPPED region of a floor plan.

This region covers one cell from the parent grid.
Subdivide it into a __SX__ × __SZ__ sub-grid.

Boundary constraints from the parent grid:
- Left edge:   __LEFT__
- Right edge:  __RIGHT__
- Top edge:    __TOP__
- Bottom edge: __BOTTOM__

(same = this edge connects to the same space; wall = boundary/different space; outside = exterior)

For each sub-cell, assign a letter ID matching the parent's space labels.
Respect the boundary constraints:
- "same" edge → all sub-cells on that edge must be the SAME letter as the neighbor
- "wall" edge → sub-cells on that edge may differ from the neighbor
- "outside" edge → sub-cells on that edge may be null

Return ONLY a JSON 2D array (__SZ__ rows, __SX__ elements each):
[["A","A","B"], ["A","B","B"], ...]`;

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

async function callQwen(imageBase64OrDataUrl, prompt, userText) {
    const imageUrl = imageBase64OrDataUrl.startsWith('data:')
        ? imageBase64OrDataUrl
        : `data:image/png;base64,${imageBase64OrDataUrl}`;
    const payload = JSON.stringify({
        model: 'qwen-vl-max',
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: prompt + '\n\n' + userText },
            ],
        }],
        max_tokens: 4000,
    });
    const res = await httpPost(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        { 'Content-Type': 'application/json', Authorization: `Bearer ${QWEN_API_KEY}` },
        payload
    );
    if (res.status !== 200) throw new Error(`Qwen ${res.status}: ${res.body}`);
    return JSON.parse(res.body).choices?.[0]?.message?.content ?? '';
}

function parseGrid(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('[');
    const e = cleaned.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('No array found');
    let grid = JSON.parse(cleaned.substring(s, e + 1));
    // Normalize: "null" string → null
    grid = grid.map(row => row.map(cell =>
        (cell === null || cell === 'null' || cell === 'NULL' || cell === '') ? null : cell
    ));
    return grid;
}

// ─── SPP Cell Generation ─────────────────────────────────────────────────────

function generateCells(grid, gx, gz) {
    const cells = [];
    for (let z = 0; z < gz; z++) {
        for (let x = 0; x < gx; x++) {
            const id = grid[z]?.[x];
            if (!id) continue;
            cells.push({
                position: [x, 0, z],
                size: [1, 1, 1],
                faceStates: 0b111111,
                room: id,
                faceOptions: [
                    x + 1 < gx && grid[z][x + 1] === id ? [0] : [10],  // +X
                    x - 1 >= 0 && grid[z][x - 1] === id ? [0] : [10],  // -X
                    [], [],
                    z + 1 < gz && grid[z + 1]?.[x] === id ? [0] : [10],  // +Z
                    z - 1 >= 0 && grid[z - 1]?.[x] === id ? [0] : [10],  // -Z
                ],
                refinement: null,
            });
        }
    }
    return cells;
}

function findBoundaryCells(cells) {
    return cells.filter(c =>
        c.faceOptions.some((opts, fi) => fi !== 2 && fi !== 3 && opts[0] === 10)
    );
}

function getFaceConstraint(cell, fi, grid, gx, gz) {
    const [x, , z] = cell.position;
    const DIRS = { 0: [1, 0], 1: [-1, 0], 4: [0, 1], 5: [0, -1] };
    const dir = DIRS[fi];
    if (!dir) return 'same';
    const nx = x + dir[0], nz = z + dir[1];
    if (nx < 0 || nx >= gx || nz < 0 || nz >= gz) return 'outside';
    const neighbor = grid[nz]?.[nx];
    if (!neighbor) return 'outside';
    return neighbor === cell.room ? 'same' : 'wall';
}

// ─── Image Cropping ──────────────────────────────────────────────────────────

function cropCellImage(img, x, z, gx, gz) {
    const cellW = img.width / gx;
    const cellH = img.height / gz;
    // Add small margin for context
    const margin = Math.min(cellW, cellH) * 0.1;
    const sx = Math.max(0, x * cellW - margin);
    const sy = Math.max(0, z * cellH - margin);
    const sw = Math.min(img.width - sx, cellW + margin * 2);
    const sh = Math.min(img.height - sy, cellH + margin * 2);

    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 200, 200);
    return canvas.toDataURL('image/png');
}

// ─── Visualization ───────────────────────────────────────────────────────────

const COLORS = {
    'A': '#e74c3c', 'B': '#3498db', 'C': '#2ecc71', 'D': '#f39c12',
    'E': '#9b59b6', 'F': '#1abc9c', 'G': '#e67e22', 'H': '#34495e',
    'I': '#e91e63', 'J': '#00bcd4', 'K': '#8bc34a', 'L': '#ff5722',
};

function drawGrid(img, grid, gx, gz, cells, title) {
    const W = 800, H = Math.round(800 * img.height / img.width);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Draw source image faded
    ctx.globalAlpha = 0.3;
    ctx.drawImage(img, 0, 0, W, H);
    ctx.globalAlpha = 1;

    const cellW = W / gx;
    const cellH = H / gz;

    // Draw colored cells
    for (let z = 0; z < gz; z++) {
        for (let x = 0; x < gx; x++) {
            const id = grid[z]?.[x];
            if (!id) continue;
            ctx.fillStyle = COLORS[id] || '#888';
            ctx.globalAlpha = 0.35;
            ctx.fillRect(x * cellW, z * cellH, cellW, cellH);
            ctx.globalAlpha = 1;

            // Label
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${Math.min(cellW, cellH) * 0.4}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(id, (x + 0.5) * cellW, (z + 0.5) * cellH);
        }
    }

    // Draw walls (thick black lines between different IDs)
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    for (const cell of cells) {
        const [x, , z] = cell.position;
        for (const [fi, dx, dz, startX, startY, endX, endY] of [
            [0, 1, 0, (x+1)*cellW, z*cellH, (x+1)*cellW, (z+1)*cellH],      // +X
            [1, -1, 0, x*cellW, z*cellH, x*cellW, (z+1)*cellH],              // -X
            [4, 0, 1, x*cellW, (z+1)*cellH, (x+1)*cellW, (z+1)*cellH],      // +Z
            [5, 0, -1, x*cellW, z*cellH, (x+1)*cellW, z*cellH],             // -Z
        ]) {
            if (cell.faceOptions[fi]?.[0] === 10) {
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();
            }
        }
    }

    // Draw grid lines (thin)
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= gx; x++) {
        ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, H); ctx.stroke();
    }
    for (let z = 0; z <= gz; z++) {
        ctx.beginPath(); ctx.moveTo(0, z * cellH); ctx.lineTo(W, z * cellH); ctx.stroke();
    }

    // Title
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 10, 10);

    return canvas;
}

function drawRefinedGrid(img, grid, gx, gz, cells) {
    const W = 800, H = Math.round(800 * img.height / img.width);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Draw source image faded
    ctx.globalAlpha = 0.3;
    ctx.drawImage(img, 0, 0, W, H);
    ctx.globalAlpha = 1;

    const cellW = W / gx;
    const cellH = H / gz;

    for (const cell of cells) {
        const [x, , z] = cell.position;

        if (cell.refinement && cell.refinement.cells) {
            // Draw sub-grid
            const sub = cell.refinement;
            const subCellW = cellW / sub.gridX;
            const subCellH = cellH / sub.gridZ;
            for (const sc of sub.cells) {
                const [sx, , sz] = sc.position;
                const id = sc.room;
                if (!id) continue;
                ctx.fillStyle = COLORS[id] || '#888';
                ctx.globalAlpha = 0.4;
                ctx.fillRect(
                    x * cellW + sx * subCellW,
                    z * cellH + sz * subCellH,
                    subCellW, subCellH
                );
                ctx.globalAlpha = 1;
            }
            // Draw sub-cell walls
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            for (const sc of sub.cells) {
                const [sx, , sz] = sc.position;
                const px = x * cellW + sx * subCellW;
                const pz = z * cellH + sz * subCellH;
                for (const [fi, x1, y1, x2, y2] of [
                    [0, px + subCellW, pz, px + subCellW, pz + subCellH],
                    [1, px, pz, px, pz + subCellH],
                    [4, px, pz + subCellH, px + subCellW, pz + subCellH],
                    [5, px, pz, px + subCellW, pz],
                ]) {
                    if (sc.faceOptions[fi]?.[0] === 10) {
                        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
                    }
                }
            }
        } else {
            // Draw coarse cell
            const id = cell.room;
            if (!id) continue;
            ctx.fillStyle = COLORS[id] || '#888';
            ctx.globalAlpha = 0.35;
            ctx.fillRect(x * cellW, z * cellH, cellW, cellH);
            ctx.globalAlpha = 1;
        }
    }

    // Title
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('After refinement', 10, 10);

    return canvas;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('============================================================');
    console.log('网格分类方案测试');
    console.log('============================================================');

    const imgBuf = fs.readFileSync(IMAGE_PATH);
    const base64 = imgBuf.toString('base64');
    const img = await loadImage(IMAGE_PATH);
    console.log(`图片: ${img.width}×${img.height}\n`);

    // ── Step 1: AI识别房间 + 程序填充网格 ──
    console.log(`── Step 1: AI识别房间位置 ──`);
    const prompt1 = COARSE_PROMPT;
    const raw1 = await callQwen(base64, prompt1,
        `请识别这张户型图中的所有房间，返回JSON数组。`);
    console.log('AI输出:\n', raw1.substring(0, 1200));
    console.log('');

    // Parse room list
    const cleaned1 = raw1.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s1 = cleaned1.indexOf('[');
    const e1 = cleaned1.lastIndexOf(']');
    if (s1 === -1 || e1 === -1) throw new Error('No room array found');
    const rooms = JSON.parse(cleaned1.substring(s1, e1 + 1));
    console.log(`识别到 ${rooms.length} 个房间:`);
    for (const r of rooms) {
        console.log(`  ${r.id}: ${r.name} (${r.x1}%-${r.x2}%, ${r.y1}%-${r.y2}%)${r.outside ? ' [外部]' : ''}`);
    }
    console.log('');

    // Programmatically fill grid based on room bounding boxes
    console.log(`── 程序填充 ${GRID_X}×${GRID_Z} 网格 ──`);
    const grid = [];
    for (let z = 0; z < GRID_Z; z++) {
        const row = [];
        for (let x = 0; x < GRID_X; x++) {
            // Cell center in percentage
            const cx = ((x + 0.5) / GRID_X) * 100;
            const cy = ((z + 0.5) / GRID_Z) * 100;

            // Find best matching room (smallest area that contains this point)
            let bestRoom = null;
            let bestArea = Infinity;
            for (const r of rooms) {
                if (cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2) {
                    const area = (r.x2 - r.x1) * (r.y2 - r.y1);
                    if (area < bestArea) {
                        bestArea = area;
                        bestRoom = r;
                    }
                }
            }
            row.push(bestRoom ? bestRoom.id : null);
        }
        grid.push(row);
    }
    console.log(`→ ${grid.length} rows × ${grid[0].length} cols`);
    for (let z = 0; z < grid.length; z++) {
        console.log(`  row${z}: ${grid[z].map(c => c || '.').join(' ')}`);
    }

    // Generate SPP cells
    const cells = generateCells(grid, GRID_X, GRID_Z);
    const boundary = findBoundaryCells(cells);
    console.log(`→ ${cells.length} cells, ${boundary.length} boundary cells\n`);

    // Save coarse result image
    const coarseCanvas = drawGrid(img, grid, GRID_X, GRID_Z, cells,
        `Coarse ${GRID_X}×${GRID_Z} — ${cells.length} cells, ${boundary.length} boundary`);
    fs.writeFileSync(OUTPUT_IMAGE.replace('.png', '-coarse.png'), coarseCanvas.toBuffer('image/png'));
    console.log('→ 粗网格图已保存\n');

    // ── Step 2: Refine boundary cells ──
    console.log(`── Step 2: 边界格细化 (scale=${REFINE_SCALE}) ──`);
    let refined = 0;
    for (const cell of boundary) {
        const [x, , z] = cell.position;
        const constraints = {
            right:  getFaceConstraint(cell, 0, grid, GRID_X, GRID_Z),
            left:   getFaceConstraint(cell, 1, grid, GRID_X, GRID_Z),
            bottom: getFaceConstraint(cell, 4, grid, GRID_X, GRID_Z),
            top:    getFaceConstraint(cell, 5, grid, GRID_X, GRID_Z),
        };

        console.log(`  Cell (${x},${z}) room=${cell.room} constraints: L=${constraints.left} R=${constraints.right} T=${constraints.top} B=${constraints.bottom}`);

        const cropDataUrl = cropCellImage(img, x, z, GRID_X, GRID_Z);
        const prompt = REFINE_PROMPT
            .replace(/__SX__/g, String(REFINE_SCALE))
            .replace(/__SZ__/g, String(REFINE_SCALE))
            .replace('__LEFT__', constraints.left)
            .replace('__RIGHT__', constraints.right)
            .replace('__TOP__', constraints.top)
            .replace('__BOTTOM__', constraints.bottom);

        try {
            const raw = await callQwen(cropDataUrl, prompt,
                `Subdivide into ${REFINE_SCALE}×${REFINE_SCALE}. Return ONLY the JSON array.`);
            const subGrid = parseGrid(raw);
            console.log(`    → sub: ${subGrid.map(r => r.map(c=>c||'.').join('')).join(' | ')}`);

            const subCells = generateCells(subGrid, REFINE_SCALE, REFINE_SCALE);
            cell.refinement = {
                gridX: REFINE_SCALE,
                gridZ: REFINE_SCALE,
                cells: subCells,
            };
            refined++;
        } catch (err) {
            console.log(`    → failed: ${err.message}`);
        }
    }
    console.log(`\n→ ${refined}/${boundary.length} cells refined\n`);

    // Save refined result image
    const refinedCanvas = drawRefinedGrid(img, grid, GRID_X, GRID_Z, cells);
    fs.writeFileSync(OUTPUT_IMAGE, refinedCanvas.toBuffer('image/png'));

    // Save JSON
    const result = { grid, gridX: GRID_X, gridZ: GRID_Z, cells, refinedCount: refined };
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2));

    console.log(`✅ 结果已保存:`);
    console.log(`   ${OUTPUT_IMAGE.replace('.png', '-coarse.png')}`);
    console.log(`   ${OUTPUT_IMAGE}`);
    console.log(`   ${OUTPUT_JSON}`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
