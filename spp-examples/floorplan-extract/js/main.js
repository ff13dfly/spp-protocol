/**
 * main.js — Floor Plan Structure Extraction
 *
 * Pipeline:
 *   Step 1: [AI] Extract outer wall outline → closed polygon
 *   Step 2: [AI] Extract inner walls → line segments
 *   Step 3: [AI] Extract doors & windows → positions on walls
 *   Step 4: [Canvas] Draw clean geometry from extracted data
 */

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
    imageDataUrl: null,
    imageWidth: 0,
    imageHeight: 0,
    result: null,       // { outline, innerWalls, doors, windows }
};

// ─── DOM ─────────────────────────────────────────────────────────────────────

const uploadBtn     = document.getElementById('uploadBtn');
const fileInput     = document.getElementById('fileInput');
const extractBtn    = document.getElementById('extractBtn');
const apiKeyInput   = document.getElementById('apiKeyInput');
const sourceCanvas  = document.getElementById('sourceCanvas');
const resultCanvas  = document.getElementById('resultCanvas');
const overlayCtrl   = document.getElementById('overlay-controls');
const overlayToggle = document.getElementById('overlayToggle');
const overlayOpacity= document.getElementById('overlayOpacity');
const exportBtn     = document.getElementById('exportBtn');
const logOutput     = document.getElementById('logOutput');
const toastEl       = document.getElementById('toast');

// Restore API key from localStorage
apiKeyInput.value = localStorage.getItem('fp-extract-api-key') || '';

// ─── Prompts ─────────────────────────────────────────────────────────────────

const STEP1_PROMPT = `You are analyzing an architectural floor plan image.

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

const STEP2_PROMPT = `You are analyzing an architectural floor plan image.

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

Return ONLY a JSON object:
{ "innerWalls": [{ "from": [x,y], "to": [x,y] }, ...] }`;

const STEP3_PROMPT = `You are analyzing an architectural floor plan image.

The building structure has been identified:
Outline: __OUTLINE__
Interior walls: __INNER_WALLS__

Now identify all DOORS and WINDOWS visible in the floor plan.

Rules:
1. A door appears as an arc symbol (quarter-circle swing path) on a wall.
2. A window appears as parallel short lines on an exterior wall.
3. For each, report the center point (on the wall) and approximate width.
4. Use the same 0-1 normalized coordinate system.

Return ONLY a JSON object:
{
  "doors": [{ "center": [x,y], "width": 0.05 }, ...],
  "windows": [{ "center": [x,y], "width": 0.08 }, ...]
}`;

// ─── AI Call ─────────────────────────────────────────────────────────────────

async function callAI(imageDataUrl, systemPrompt, userText) {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) throw new Error('No API key set');
    localStorage.setItem('fp-extract-api-key', apiKey);

    const payload = {
        model: 'qwen-vl-max',
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: imageDataUrl } },
                { type: 'text', text: systemPrompt + '\n\n' + userText },
            ],
        }],
        max_tokens: 4000,
    };

    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
}

function parseJSONObject(text) {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('No JSON object found in response');
    return JSON.parse(cleaned.substring(s, e + 1));
}

// ─── Post-processing: coordinate snapping + topology fix ─────────────────────

function snapData(data) {
    // 1. Collect all unique coordinate values (x and y separately)
    const allX = new Set();
    const allY = new Set();

    if (data.outline) {
        for (const [x, y] of data.outline) { allX.add(x); allY.add(y); }
    }
    if (data.innerWalls) {
        for (const w of data.innerWalls) {
            allX.add(w.from[0]); allY.add(w.from[1]);
            allX.add(w.to[0]);   allY.add(w.to[1]);
        }
    }

    // 2. Cluster nearby values (within threshold) into canonical values
    const SNAP = 0.025; // snap threshold: 2.5% of image
    function clusterValues(vals) {
        const sorted = [...vals].sort((a, b) => a - b);
        const clusters = [];
        for (const v of sorted) {
            const match = clusters.find(c => Math.abs(c.center - v) < SNAP);
            if (match) {
                match.members.push(v);
                match.center = match.members.reduce((s, m) => s + m, 0) / match.members.length;
            } else {
                clusters.push({ center: v, members: [v] });
            }
        }
        return clusters;
    }

    const xClusters = clusterValues(allX);
    const yClusters = clusterValues(allY);

    function snapX(x) {
        let best = x, dist = Infinity;
        for (const c of xClusters) {
            const d = Math.abs(x - c.center);
            if (d < dist) { dist = d; best = c.center; }
        }
        return Math.round(best * 1000) / 1000;
    }
    function snapY(y) {
        let best = y, dist = Infinity;
        for (const c of yClusters) {
            const d = Math.abs(y - c.center);
            if (d < dist) { dist = d; best = c.center; }
        }
        return Math.round(best * 1000) / 1000;
    }
    function snapPt(pt) { return [snapX(pt[0]), snapY(pt[1])]; }

    // 3. Apply snapping
    if (data.outline) {
        data.outline = data.outline.map(snapPt);
        // Remove duplicate consecutive points
        data.outline = data.outline.filter((p, i, arr) => {
            const prev = arr[(i - 1 + arr.length) % arr.length];
            return !(Math.abs(p[0] - prev[0]) < 0.001 && Math.abs(p[1] - prev[1]) < 0.001);
        });
    }

    if (data.innerWalls) {
        data.innerWalls = data.innerWalls.map(w => ({
            from: snapPt(w.from),
            to:   snapPt(w.to),
        }));
        // Force orthogonal: for each wall, snap the varying axis
        data.innerWalls = data.innerWalls.map(w => {
            const dx = Math.abs(w.from[0] - w.to[0]);
            const dy = Math.abs(w.from[1] - w.to[1]);
            if (dx < dy) {
                // Mostly vertical → force same X
                const avgX = (w.from[0] + w.to[0]) / 2;
                const sx = snapX(avgX);
                return { from: [sx, w.from[1]], to: [sx, w.to[1]] };
            } else {
                // Mostly horizontal → force same Y
                const avgY = (w.from[1] + w.to[1]) / 2;
                const sy = snapY(avgY);
                return { from: [w.from[0], sy], to: [w.to[0], sy] };
            }
        });
        // Remove zero-length walls
        data.innerWalls = data.innerWalls.filter(w =>
            Math.abs(w.from[0] - w.to[0]) > 0.005 || Math.abs(w.from[1] - w.to[1]) > 0.005
        );
    }

    if (data.doors) {
        data.doors = data.doors.map(d => ({ ...d, center: snapPt(d.center) }));
    }
    if (data.windows) {
        data.windows = data.windows.map(d => ({ ...d, center: snapPt(d.center) }));
    }

    return data;
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function drawResult(data, w, h) {
    resultCanvas.width = w;
    resultCanvas.height = h;
    const ctx = resultCanvas.getContext('2d');

    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, w, h);

    const LW = 3;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';

    // 1. Outline — fill interior white, then stroke
    if (data.outline && data.outline.length > 2) {
        const pts = data.outline;
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = LW;
        ctx.stroke();
    }

    // 2. Inner walls — same line width as outline
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = LW;
    if (data.innerWalls) {
        for (const wall of data.innerWalls) {
            ctx.beginPath();
            ctx.moveTo(wall.from[0] * w, wall.from[1] * h);
            ctx.lineTo(wall.to[0] * w, wall.to[1] * h);
            ctx.stroke();
        }
    }

    // 3. Doors — white gaps on walls
    if (data.doors) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 6;
        for (const door of data.doors) {
            const cx = door.center[0] * w;
            const cy = door.center[1] * h;
            const hw = (door.width * Math.max(w, h)) / 2;
            const horiz = isOnHorizontalSegment(door.center, data);
            ctx.beginPath();
            if (horiz) {
                ctx.moveTo(cx - hw, cy);
                ctx.lineTo(cx + hw, cy);
            } else {
                ctx.moveTo(cx, cy - hw);
                ctx.lineTo(cx, cy + hw);
            }
            ctx.stroke();
        }
    }

    // 4. Windows — blue marks
    if (data.windows) {
        ctx.strokeStyle = '#4488ff';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        for (const win of data.windows) {
            const cx = win.center[0] * w;
            const cy = win.center[1] * h;
            const hw = (win.width * Math.max(w, h)) / 2;
            const horiz = isOnHorizontalSegment(win.center, data);
            ctx.beginPath();
            if (horiz) {
                ctx.moveTo(cx - hw, cy);
                ctx.lineTo(cx + hw, cy);
            } else {
                ctx.moveTo(cx, cy - hw);
                ctx.lineTo(cx, cy + hw);
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }
}

function isOnHorizontalSegment(center, data) {
    const [cx, cy] = center;
    const eps = 0.03;

    const segments = [];
    if (data.outline) {
        for (let i = 0; i < data.outline.length; i++) {
            const a = data.outline[i];
            const b = data.outline[(i + 1) % data.outline.length];
            segments.push(a, b);
        }
    }
    if (data.innerWalls) {
        for (const w of data.innerWalls) {
            segments.push(w.from, w.to);
        }
    }

    // Simple check: find nearest wall and check its orientation
    if (data.innerWalls) {
        for (const w of data.innerWalls) {
            if (Math.abs(w.from[1] - w.to[1]) < eps && Math.abs(cy - w.from[1]) < eps) return true;
            if (Math.abs(w.from[0] - w.to[0]) < eps && Math.abs(cx - w.from[0]) < eps) return false;
        }
    }
    if (data.outline) {
        for (let i = 0; i < data.outline.length; i++) {
            const a = data.outline[i];
            const b = data.outline[(i + 1) % data.outline.length];
            if (Math.abs(a[1] - b[1]) < eps && Math.abs(cy - a[1]) < eps) return true;
            if (Math.abs(a[0] - b[0]) < eps && Math.abs(cx - a[0]) < eps) return false;
        }
    }

    return false;
}

function drawOverlay() {
    if (!state.result || !state.imageDataUrl) return;

    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const ctx = sourceCanvas.getContext('2d');

    // Redraw source image
    const img = new Image();
    img.onload = () => {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        if (overlayToggle.checked) {
            const alpha = overlayOpacity.value / 100;
            ctx.globalAlpha = alpha;

            // Draw extracted structure on top
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tctx = tempCanvas.getContext('2d');
            // Copy result canvas content
            tctx.drawImage(resultCanvas, 0, 0);

            ctx.drawImage(tempCanvas, 0, 0);
            ctx.globalAlpha = 1;
        }
    };
    img.src = state.imageDataUrl;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validate(data) {
    const issues = [];

    // Outline
    if (!data.outline || data.outline.length < 4) {
        issues.push('Outline: fewer than 4 points');
    } else {
        for (let i = 0; i < data.outline.length; i++) {
            const a = data.outline[i];
            const b = data.outline[(i + 1) % data.outline.length];
            const dx = Math.abs(a[0] - b[0]);
            const dy = Math.abs(a[1] - b[1]);
            if (dx > 0.01 && dy > 0.01) {
                issues.push(`Outline segment ${i} is diagonal`);
            }
        }
    }

    // Inner walls
    if (data.innerWalls) {
        for (let i = 0; i < data.innerWalls.length; i++) {
            const w = data.innerWalls[i];
            const dx = Math.abs(w.from[0] - w.to[0]);
            const dy = Math.abs(w.from[1] - w.to[1]);
            if (dx > 0.01 && dy > 0.01) {
                issues.push(`Inner wall ${i} is diagonal`);
            }
        }
    }

    return issues;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    logOutput.textContent += msg + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
}

function toast(msg, type = 'success') {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${type}`;
    setTimeout(() => { toastEl.className = 'toast'; }, 3000);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runExtraction() {
    if (!state.imageDataUrl) return;

    extractBtn.disabled = true;
    logOutput.textContent = '';
    const result = {};

    try {
        // Step 1: Outline
        log('── Step 1: 提取外墙轮廓 ──');
        toast('Step 1: Extracting outline...');
        const raw1 = await callAI(state.imageDataUrl, STEP1_PROMPT,
            'Extract the outer wall boundary. Return ONLY the JSON.');
        log('Response: ' + raw1.substring(0, 300));
        const parsed1 = parseJSONObject(raw1);
        result.outline = parsed1.outline;
        log(`→ ${result.outline.length} vertices\n`);

        // Step 2: Inner walls
        log('── Step 2: 提取内墙 ──');
        toast('Step 2: Extracting inner walls...');
        const prompt2 = STEP2_PROMPT.replace('__OUTLINE__', JSON.stringify(result.outline));
        const raw2 = await callAI(state.imageDataUrl, prompt2,
            'Extract all interior walls. Return ONLY the JSON.');
        log('Response: ' + raw2.substring(0, 300));
        const parsed2 = parseJSONObject(raw2);
        result.innerWalls = parsed2.innerWalls;
        log(`→ ${result.innerWalls.length} wall segments\n`);

        // Step 3: Doors & Windows
        log('── Step 3: 提取门窗 ──');
        toast('Step 3: Extracting doors/windows...');
        const prompt3 = STEP3_PROMPT
            .replace('__OUTLINE__', JSON.stringify(result.outline))
            .replace('__INNER_WALLS__', JSON.stringify(result.innerWalls));
        const raw3 = await callAI(state.imageDataUrl, prompt3,
            'Identify all doors and windows. Return ONLY the JSON.');
        log('Response: ' + raw3.substring(0, 300));
        const parsed3 = parseJSONObject(raw3);
        result.doors = parsed3.doors || [];
        result.windows = parsed3.windows || [];
        log(`→ ${result.doors.length} doors, ${result.windows.length} windows\n`);

        // Validate
        const issues = validate(result);
        if (issues.length > 0) {
            log('⚠ Validation issues:');
            issues.forEach(i => log('  - ' + i));
        } else {
            log('✓ Validation passed');
        }

        // Post-process: snap coordinates to grid + fix topology
        log('\n── Post-processing: 坐标吸附 ──');
        snapData(result);
        log('→ Coordinates snapped to grid');

        // Draw
        state.result = result;
        drawResult(result, sourceCanvas.width, sourceCanvas.height);
        drawOverlay();
        overlayCtrl.style.display = 'flex';

        toast('Extraction complete!', 'success');
        log('\n✅ Done.');

    } catch (err) {
        log(`\n❌ Error: ${err.message}`);
        toast(err.message, 'error');
    } finally {
        extractBtn.disabled = false;
    }
}

// ─── Events ──────────────────────────────────────────────────────────────────

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        state.imageDataUrl = ev.target.result;
        const img = new Image();
        img.onload = () => {
            state.imageWidth = img.naturalWidth;
            state.imageHeight = img.naturalHeight;

            // Draw source
            const maxW = 560;
            const scale = Math.min(maxW / img.naturalWidth, maxW / img.naturalHeight);
            const w = Math.round(img.naturalWidth * scale);
            const h = Math.round(img.naturalHeight * scale);
            sourceCanvas.width = w;
            sourceCanvas.height = h;
            sourceCanvas.getContext('2d').drawImage(img, 0, 0, w, h);

            resultCanvas.width = w;
            resultCanvas.height = h;

            extractBtn.disabled = false;
            toast('Image loaded', 'success');
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
});

extractBtn.addEventListener('click', runExtraction);

overlayToggle.addEventListener('change', drawOverlay);
overlayOpacity.addEventListener('input', drawOverlay);

exportBtn.addEventListener('click', () => {
    if (!state.result) return;
    const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'floorplan-extract.json';
    a.click();
});
