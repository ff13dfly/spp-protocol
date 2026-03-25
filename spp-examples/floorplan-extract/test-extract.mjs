/**
 * test-extract.mjs
 * 验证 AI 能否从房型图中分步提取结构数据：
 *   Step 1: 外墙轮廓（闭合多边形）
 *   Step 2: 内墙分隔（线段列表）
 *   Step 3: 门窗位置
 *   Step 4: Canvas 绘制纯几何图
 *
 * Usage: node spp-examples/floorplan-extract/test-extract.mjs
 */

import fs   from 'fs';
import path from 'path';
import https from 'https';
import { createCanvas, loadImage } from '../../scripts/node_modules/canvas/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const IMAGE_PATH   = path.resolve('spp-examples/inverse-demo-v2/assets/floorplan.png');
const OUTPUT_JSON  = path.resolve('spp-examples/floorplan-extract/extract-result.json');
const OUTPUT_IMAGE = path.resolve('spp-examples/floorplan-extract/extracted-outline.png');

// ─── Prompts ─────────────────────────────────────────────────────────────────

const STEP1_OUTLINE_PROMPT = `You are analyzing an architectural floor plan image.

Extract the OUTER WALL boundary of the building as a closed polygon.
All corners are 90-degree angles (orthogonal only).

Rules:
1. Trace the outermost wall line of the building.
2. Output coordinates as [x, y] pairs, normalized to 0-1 range
   where (0,0) = top-left of the floor plan area and (1,1) = bottom-right.
3. List points in clockwise order starting from the top-left corner.
4. All segments must be horizontal or vertical — no diagonals.
5. The polygon must be closed (last point connects back to first).
6. Only include the building outline, ignore balconies, porches, or exterior features.

Return ONLY a JSON object:
{ "outline": [[x,y], [x,y], ...] }`;

const STEP2_INNER_WALLS_PROMPT = `You are analyzing an architectural floor plan image.

The outer wall boundary has been identified as:
__OUTLINE__

Now extract all INTERIOR WALLS that divide the building into separate rooms.

Rules:
1. Each wall is a straight line segment: { "from": [x,y], "to": [x,y] }
2. All segments must be horizontal or vertical — no diagonals.
3. Wall endpoints must connect to the outer boundary or to other interior walls.
4. Do NOT include door openings as walls — only continuous solid wall segments.
   If a wall has a door in the middle, split it into two segments (one on each side of the door).
5. Use the same 0-1 normalized coordinate system as the outline.
6. Include ALL interior walls visible in the floor plan.

Return ONLY a JSON object:
{ "innerWalls": [{ "from": [x,y], "to": [x,y] }, ...] }`;

const STEP3_DOORS_WINDOWS_PROMPT = `You are analyzing an architectural floor plan image.

The building structure has been identified:
Outline: __OUTLINE__
Interior walls: __INNER_WALLS__

Now identify all DOORS and WINDOWS visible in the floor plan.

Rules:
1. A door appears as an arc symbol (quarter-circle swing path) on a wall.
2. A window appears as parallel short lines on an exterior wall.
3. For each, report the center point (on the wall) and approximate width.
4. Use the same 0-1 normalized coordinate system.
5. A door/window center must lie on a wall segment (outer or inner).

Return ONLY a JSON object:
{
  "doors": [{ "center": [x,y], "width": 0.05 }, ...],
  "windows": [{ "center": [x,y], "width": 0.08 }, ...]
}`;

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

async function callQwen(base64, mime, prompt, userText) {
    const payload = JSON.stringify({
        model: 'qwen-vl-max',
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
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

function parseJSONObject(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('No JSON object found');
    return JSON.parse(cleaned.substring(s, e + 1));
}

// ─── Canvas drawing ──────────────────────────────────────────────────────────

function drawStructure(data, w, h) {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.lineCap = 'square';

    // 1. Outer wall outline
    if (data.outline && data.outline.length > 0) {
        const pts = data.outline;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
        }
        ctx.closePath();
        ctx.stroke();
    }

    // 2. Inner walls
    ctx.lineWidth = 2;
    if (data.innerWalls) {
        for (const wall of data.innerWalls) {
            ctx.beginPath();
            ctx.moveTo(wall.from[0] * w, wall.from[1] * h);
            ctx.lineTo(wall.to[0] * w, wall.to[1] * h);
            ctx.stroke();
        }
    }

    // 3. Doors — draw as gaps (white) on walls
    if (data.doors) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 6;
        for (const door of data.doors) {
            const cx = door.center[0] * w;
            const cy = door.center[1] * h;
            const halfW = (door.width * w) / 2;
            // Determine direction — check if door is on a horizontal or vertical wall
            const isHorizontal = isOnHorizontalWall(door.center, data);
            ctx.beginPath();
            if (isHorizontal) {
                ctx.moveTo(cx - halfW, cy);
                ctx.lineTo(cx + halfW, cy);
            } else {
                ctx.moveTo(cx, cy - halfW);
                ctx.lineTo(cx, cy + halfW);
            }
            ctx.stroke();
        }
    }

    // 4. Windows — draw as dashed lines on outer walls
    if (data.windows) {
        ctx.strokeStyle = '#4488ff';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        for (const win of data.windows) {
            const cx = win.center[0] * w;
            const cy = win.center[1] * h;
            const halfW = (win.width * w) / 2;
            const isHorizontal = isOnHorizontalWall(win.center, data);
            ctx.beginPath();
            if (isHorizontal) {
                ctx.moveTo(cx - halfW, cy);
                ctx.lineTo(cx + halfW, cy);
            } else {
                ctx.moveTo(cx, cy - halfW);
                ctx.lineTo(cx, cy + halfW);
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    return canvas;
}

function isOnHorizontalWall(center, data) {
    const [cx, cy] = center;
    const eps = 0.02;

    // Check inner walls
    if (data.innerWalls) {
        for (const w of data.innerWalls) {
            if (Math.abs(w.from[1] - w.to[1]) < eps) {
                // Horizontal wall
                if (Math.abs(cy - w.from[1]) < eps) return true;
            }
        }
    }

    // Check outline segments
    if (data.outline) {
        const pts = data.outline;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            if (Math.abs(a[1] - b[1]) < eps) {
                if (Math.abs(cy - a[1]) < eps) return true;
            }
        }
    }

    return false;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateOutline(outline) {
    const issues = [];
    if (!outline || outline.length < 4) {
        issues.push('Outline has fewer than 4 points');
        return issues;
    }
    // Check orthogonal
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        const dx = Math.abs(a[0] - b[0]);
        const dy = Math.abs(a[1] - b[1]);
        if (dx > 0.01 && dy > 0.01) {
            issues.push(`Segment ${i}→${i+1} is diagonal: (${a}) → (${b})`);
        }
    }
    // Check range
    for (const [x, y] of outline) {
        if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) {
            issues.push(`Point (${x}, ${y}) out of 0-1 range`);
        }
    }
    return issues;
}

function validateInnerWalls(walls) {
    const issues = [];
    if (!walls) return issues;
    for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        const dx = Math.abs(w.from[0] - w.to[0]);
        const dy = Math.abs(w.from[1] - w.to[1]);
        if (dx > 0.01 && dy > 0.01) {
            issues.push(`Inner wall ${i} is diagonal: (${w.from}) → (${w.to})`);
        }
    }
    return issues;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('============================================================');
    console.log('房型图结构提取测试');
    console.log('============================================================');

    // Load image
    const imgBuf = fs.readFileSync(IMAGE_PATH);
    const base64 = imgBuf.toString('base64');
    const img = await loadImage(IMAGE_PATH);
    console.log(`图片: ${img.width}×${img.height}\n`);

    const result = {};

    // ── Step 1: Extract outer wall outline ──
    console.log('── Step 1: 提取外墙轮廓 ──');
    const step1Raw = await callQwen(base64, 'image/png',
        STEP1_OUTLINE_PROMPT,
        'Extract the outer wall boundary of this floor plan. Return ONLY the JSON.'
    );
    console.log('原始输出:', step1Raw.substring(0, 500));

    try {
        const step1 = parseJSONObject(step1Raw);
        result.outline = step1.outline;
        const issues1 = validateOutline(result.outline);
        console.log(`→ ${result.outline.length} 个顶点`);
        if (issues1.length > 0) {
            console.log('  验证问题:', issues1.join('; '));
        } else {
            console.log('  验证通过: 所有线段正交，坐标在范围内');
        }
    } catch (e) {
        console.error('Step 1 解析失败:', e.message);
        result.outline = [];
    }

    // ── Step 2: Extract interior walls ──
    console.log('\n── Step 2: 提取内墙 ──');
    const step2Prompt = STEP2_INNER_WALLS_PROMPT
        .replace('__OUTLINE__', JSON.stringify(result.outline));
    const step2Raw = await callQwen(base64, 'image/png',
        step2Prompt,
        'Extract all interior walls. Return ONLY the JSON.'
    );
    console.log('原始输出:', step2Raw.substring(0, 500));

    try {
        const step2 = parseJSONObject(step2Raw);
        result.innerWalls = step2.innerWalls;
        const issues2 = validateInnerWalls(result.innerWalls);
        console.log(`→ ${result.innerWalls.length} 段内墙`);
        if (issues2.length > 0) {
            console.log('  验证问题:', issues2.join('; '));
        } else {
            console.log('  验证通过: 所有内墙正交');
        }
    } catch (e) {
        console.error('Step 2 解析失败:', e.message);
        result.innerWalls = [];
    }

    // ── Step 3: Extract doors and windows ──
    console.log('\n── Step 3: 提取门窗 ──');
    const step3Prompt = STEP3_DOORS_WINDOWS_PROMPT
        .replace('__OUTLINE__', JSON.stringify(result.outline))
        .replace('__INNER_WALLS__', JSON.stringify(result.innerWalls));
    const step3Raw = await callQwen(base64, 'image/png',
        step3Prompt,
        'Identify all doors and windows. Return ONLY the JSON.'
    );
    console.log('原始输出:', step3Raw.substring(0, 500));

    try {
        const step3 = parseJSONObject(step3Raw);
        result.doors = step3.doors || [];
        result.windows = step3.windows || [];
        console.log(`→ ${result.doors.length} 个门, ${result.windows.length} 个窗`);
    } catch (e) {
        console.error('Step 3 解析失败:', e.message);
        result.doors = [];
        result.windows = [];
    }

    // ── Step 4: Draw structure ──
    console.log('\n── Step 4: Canvas 绘制 ──');
    const canvas = drawStructure(result, 800, 800);
    const pngBuf = canvas.toBuffer('image/png');
    fs.writeFileSync(OUTPUT_IMAGE, pngBuf);
    console.log(`→ 已保存: ${OUTPUT_IMAGE}`);

    // Save JSON result
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2));
    console.log(`→ 已保存: ${OUTPUT_JSON}`);

    console.log('\n✅ 完成。检查 extracted-outline.png 看提取效果。');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
