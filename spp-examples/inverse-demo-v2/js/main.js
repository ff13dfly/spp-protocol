/**
 * main.js — SPP Inverse Modeling Demo V2
 *
 * Reconstruction pipeline (structural-refinement architecture):
 *   Phase 1: AI coarse grid detection (Step1A rooms → Step1B grid size → Step1C fill)
 *   Phase 2: Deterministic wall topology (generateCellsFromLayout)
 *   Phase 3: Structural recursive refinement
 *            - scan cells for structural complexity (multi-room junctions / single-cell rooms)
 *            - crop region image → AI sub-grid (STEP1_LOCAL_PROMPT) → integrate
 *            - recurse on sub-cells until MAX_DEPTH or no complex cells remain
 *   Phase 4: AI door/window detection (on leaf cells, after all structural refinement)
 *   Phase 5: Deterministic feature piercing
 */

import { LayerRenderer, CELL_SIZE } from './renderer.js?v=19';
import { SelectionManager }         from './selection.js?v=16';
import { FloorTexture }             from './floor-texture.js?v=16';
import { RegressionEngine }         from './regression.js?v=17';
import {
    SPPInverseEngine,
    RecursiveGridManager,
    generateCellsFromLayout,
    scanComplexCells,
} from './shim.js';

// ─── Model definitions ────────────────────────────────────────

const MODELS = {
    'qwen-vl-max':       { name: 'Qwen VL Max',       provider: 'qwen',   model: 'qwen-vl-max' },
    'qwen-vl-plus':      { name: 'Qwen VL Plus',      provider: 'qwen',   model: 'qwen-vl-plus' },
    'gemini-2.0-flash':  { name: 'Gemini 2.0 Flash',  provider: 'gemini', model: 'gemini-2.0-flash' },
    'gemini-2.0-pro':    { name: 'Gemini 2.0 Pro',    provider: 'gemini', model: 'gemini-2.0-pro' },
};
const DEFAULT_MODEL = 'qwen-vl-max';
const MOCK = new URLSearchParams(location.search).has('mock');
const MAX_DEPTH = 3;

// ─── State ────────────────────────────────────────────────────

const state = {
    imageDataUrl:        null,
    autoCrop:            null,   // pixel-detected crop — set on upload, reused on analyze
    croppedImageDataUrl: null,   // image pre-cropped to floor plan bounds — used for all AI calls
    cropInfo:            null,
    rootCells:           [],
    gridInfo:            null,
    engine:              null,
};

// ─── Module instances ─────────────────────────────────────────

let layerRenderer, selectionMgr, floorTex, regressionEng;

// ─── DOM refs ─────────────────────────────────────────────────

const canvas        = document.getElementById('viewport');
const uploadBtn     = document.getElementById('uploadBtn');
const fileInput     = document.getElementById('fileInput');
const analyzeBtn    = document.getElementById('analyzeBtn');
const phase5Btn     = document.getElementById('phase5Btn');
const topViewBtn    = document.getElementById('topViewBtn');
const exportBtn     = document.getElementById('exportBtn');
const modelSelect   = document.getElementById('modelSelect');
const apiKeyInput   = document.getElementById('apiKey');
const toastEl       = document.getElementById('toast');
const actionBar     = document.getElementById('actionBar');
const selectedCount = document.getElementById('selectedCount');
const refineBtn     = document.getElementById('refineBtn');
const deleteBtn     = document.getElementById('deleteBtn');
const selectBtn     = document.getElementById('selectBtn');
const floorOpacity  = document.getElementById('floorOpacity');
const depthLegend   = document.getElementById('depthLegend');
const cellTooltip   = document.getElementById('cellTooltip');
const viewBtn       = document.getElementById('viewBtn');
const logBtn        = document.getElementById('logBtn');
const logPanel      = document.getElementById('logPanel');
const logEntries    = document.getElementById('logEntries');
const logClearBtn   = document.getElementById('logClearBtn');
const tabLog        = document.getElementById('tabLog');
const tabInspector  = document.getElementById('tabInspector');
const logContent    = document.getElementById('logContent');
const inspectorContent = document.getElementById('inspectorContent');
const inspCell      = document.getElementById('inspCell');
const aiCallsList   = document.getElementById('aiCallsList');
const jsonOverlay   = document.getElementById('jsonOverlay');
const jsonContent   = document.getElementById('jsonContent');
const jsonTitle     = document.getElementById('jsonTitle');
const jsonCopyBtn   = document.getElementById('jsonCopyBtn');
const jsonCloseBtn  = document.getElementById('jsonCloseBtn');

// ─── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    layerRenderer = new LayerRenderer();
    layerRenderer.init(canvas);

    selectionMgr = new SelectionManager();
    selectionMgr.init(
        canvas,
        () => layerRenderer.getCamera(),
        () => layerRenderer.getFloorMeshes(),
        onSelectionChange
    );

    floorTex      = new FloorTexture();
    regressionEng = new RegressionEngine();

    // Populate model selector
    for (const [key, m] of Object.entries(MODELS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = m.name;
        modelSelect.appendChild(opt);
    }
    modelSelect.value = localStorage.getItem('spp_model') || DEFAULT_MODEL;
    modelSelect.addEventListener('change', () => {
        localStorage.setItem('spp_model', modelSelect.value);
        const prov = MODELS[modelSelect.value]?.provider || '';
        apiKeyInput.value = localStorage.getItem(`spp_apikey_${prov}`) || '';
    });

    // Restore saved API key
    const initProv = MODELS[modelSelect.value]?.provider || '';
    apiKeyInput.value = localStorage.getItem(`spp_apikey_${initProv}`) || '';
    apiKeyInput.addEventListener('change', () => {
        const prov = MODELS[modelSelect.value]?.provider || '';
        localStorage.setItem(`spp_apikey_${prov}`, apiKeyInput.value);
    });

    // Drag-and-drop onto canvas
    canvas.addEventListener('dragover', e => e.preventDefault());
    canvas.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) loadFile(file);
    });

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) loadFile(fileInput.files[0]);
    });

    analyzeBtn.addEventListener('click', runReconstruct);
    phase5Btn.addEventListener('click', () => runPhase5Loop());
    selectBtn.addEventListener('click', toggleSelectMode);
    topViewBtn.addEventListener('click', () => layerRenderer.toggleTopView());
    exportBtn.addEventListener('click', exportJSON);

    // Log panel + tabs
    logBtn.addEventListener('click', () => {
        logPanel.classList.toggle('open');
        logBtn.classList.toggle('active', logPanel.classList.contains('open'));
    });
    tabLog.addEventListener('click', () => switchTab('log'));
    tabInspector.addEventListener('click', () => switchTab('inspector'));
    logClearBtn.addEventListener('click', () => {
        if (_activeTab === 'log') {
            logEntries.innerHTML = '';
        } else {
            aiCallsList.innerHTML = '<div class="insp-placeholder">No AI calls yet.</div>';
            inspCell.innerHTML    = '<div class="insp-placeholder">Hover over a cell…</div>';
        }
    });

    // JSON viewer
    viewBtn.addEventListener('click', viewJSON);
    jsonCloseBtn.addEventListener('click', () => jsonOverlay.classList.remove('open'));
    jsonOverlay.addEventListener('click', e => {
        if (e.target === jsonOverlay) jsonOverlay.classList.remove('open');
    });
    jsonCopyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(buildJSONText()).then(() => {
            jsonCopyBtn.textContent = 'Copied ✓';
            jsonCopyBtn.classList.add('copied');
            setTimeout(() => { jsonCopyBtn.textContent = 'Copy'; jsonCopyBtn.classList.remove('copied'); }, 1500);
        });
    });

    floorOpacity.addEventListener('input', () => floorTex.setOpacity(Number(floorOpacity.value)));

    // Cell hover — tooltip + inspector panel
    canvas.addEventListener('mousemove', e => {
        const cell = layerRenderer.hitTest(e.clientX, e.clientY);
        if (cell) {
            const html = formatCellTooltip(cell);
            cellTooltip.innerHTML = html;
            const bx = e.clientX + 16;
            const by = e.clientY - 10;
            cellTooltip.style.left = Math.min(bx, window.innerWidth  - 210) + 'px';
            cellTooltip.style.top  = Math.min(by, window.innerHeight - 130) + 'px';
            cellTooltip.classList.add('visible');
            updateInspectorCell(cell);
        } else {
            cellTooltip.classList.remove('visible');
        }
    });
    canvas.addEventListener('mouseleave', () => cellTooltip.classList.remove('visible'));

    refineBtn.addEventListener('click', refineSelected);
    deleteBtn.addEventListener('click', deleteRefinement);
    window.addEventListener('keydown', onKeyDown);

    if (MOCK) {
        toast('Mock mode — using preset data', 'info');
        setTimeout(loadMockData, 100);  // defer so the renderer is ready
    } else {
        toast('Drag a floor plan onto the canvas, or click Upload.  Right-drag to rotate · Left-click to select.');
    }
});

// ─── File loading ─────────────────────────────────────────────

function loadFile(file) {
    if (!file.type.startsWith('image/')) {
        toast('Please upload an image file (PNG / JPG / WebP)', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = async e => {
        state.imageDataUrl = e.target.result;
        analyzeBtn.disabled = false;
        toast('Image loaded — click Analyze to start reconstruction.');
        await previewImage(state.imageDataUrl);
    };
    reader.readAsDataURL(file);
}

async function previewImage(dataUrl) {
    // Auto-detect crop bounds from pixels and save for reuse in analysis
    const crop = await detectFloorPlanBounds(dataUrl);
    state.autoCrop = crop;

    const dims = await getImageDimensions(dataUrl);
    const aspect = (dims.width * crop.w) / (dims.height * crop.h);
    const gridZ = 4;
    const gridX = Math.max(1, Math.round(gridZ * aspect));

    layerRenderer.render([], gridX, gridZ);
    layerRenderer.focusScene();

    floorTex.dispose();
    await floorTex.init(layerRenderer.scene, dataUrl, crop, gridX, gridZ, CELL_SIZE);
    floorTex.setOpacity(Number(floorOpacity.value));
}

function getImageDimensions(dataUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.src = dataUrl;
    });
}

/**
 * Pixel-based floor plan boundary detection.
 * Scans for the bounding box of non-white content (walls, text, lines).
 * Fast, deterministic, no AI needed.
 */
function detectFloorPlanBounds(dataUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const W = img.naturalWidth, H = img.naturalHeight;
            // Sample at reduced resolution for speed
            const scale = Math.min(1, 600 / Math.max(W, H));
            const sw = Math.round(W * scale), sh = Math.round(H * scale);

            const canvas = document.createElement('canvas');
            canvas.width = sw; canvas.height = sh;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, sw, sh);
            const data = ctx.getImageData(0, 0, sw, sh).data;

            // A pixel is "content" if it isn't near-white
            function isContent(x, y) {
                const i = (y * sw + x) * 4;
                return !(data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230);
            }

            let minX = sw, maxX = 0, minY = sh, maxY = 0, found = false;
            for (let y = 0; y < sh; y++) {
                for (let x = 0; x < sw; x++) {
                    if (isContent(x, y)) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                        found = true;
                    }
                }
            }

            if (!found || maxX <= minX || maxY <= minY) {
                resolve({ x: 0, y: 0, w: 1, h: 1 });
                return;
            }

            const pad = 0.01;
            const x = Math.max(0, minX / sw - pad);
            const y = Math.max(0, minY / sh - pad);
            const w = Math.min(1 - x, (maxX - minX) / sw + pad * 2);
            const h = Math.min(1 - y, (maxY - minY) / sh + pad * 2);
            resolve({ x, y, w, h });
        };
        img.onerror = () => resolve({ x: 0, y: 0, w: 1, h: 1 });
        img.src = dataUrl;
    });
}

/**
 * Remove all-null border rows/columns from a layout grid.
 * AI sometimes adds them as safety margin, which inflates gridX/gridZ
 * and causes the floor texture to be stretched over empty space.
 * Handles both JSON null and the string "null" that some models return.
 */
function trimNullBorders(layout) {
    if (!layout || layout.length === 0) return layout;

    // Treat JSON null, undefined, empty string, and the string "null" all as empty
    const isEmpty  = c  => !c || c === 'null' || c === 'exterior';
    const emptyRow = row => row.every(isEmpty);

    const rows = layout.length;
    const cols = layout[0]?.length || 0;
    if (cols === 0) return layout;

    let top = 0, bottom = rows - 1, left = 0, right = cols - 1;

    while (top    <= bottom && emptyRow(layout[top]))                        top++;
    while (bottom >= top    && emptyRow(layout[bottom]))                     bottom--;
    while (left   <= right  && layout.every(row => isEmpty(row[left])))      left++;
    while (right  >= left   && layout.every(row => isEmpty(row[right])))     right--;

    if (top > bottom || left > right) return layout; // all null — return as-is

    // Normalize: convert any "null" strings → actual null within the trimmed region
    return layout.slice(top, bottom + 1).map(row =>
        row.slice(left, right + 1).map(c => isEmpty(c) ? null : c)
    );
}

/** Crop an image to a normalized rect, returns a new data URL */
function cropToDataUrl(dataUrl, crop) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const W = img.naturalWidth, H = img.naturalHeight;
            const canvas = document.createElement('canvas');
            canvas.width  = Math.round(W * crop.w);
            canvas.height = Math.round(H * crop.h);
            canvas.getContext('2d').drawImage(
                img,
                W * crop.x, H * crop.y, W * crop.w, H * crop.h,
                0, 0, canvas.width, canvas.height
            );
            resolve(canvas.toDataURL('image/jpeg', 0.92));
        };
        img.src = dataUrl;
    });
}

/**
 * Preprocess a floor plan image: threshold to pure black-and-white.
 * Pixels with luminance < THRESHOLD become solid black (walls/lines),
 * all others become white (empty space).
 * This eliminates double-line wall confusion where two thin parallel lines
 * get mis-classified as two separate walls instead of one.
 */
function preprocessFloorPlan(dataUrl, threshold = 160) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const W = img.naturalWidth, H = img.naturalHeight;
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imgData = ctx.getImageData(0, 0, W, H);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                // Perceived luminance (BT.601)
                const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                const v = lum < threshold ? 0 : 255;
                d[i] = d[i + 1] = d[i + 2] = v;
                d[i + 3] = 255; // fully opaque
            }
            ctx.putImageData(imgData, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(dataUrl); // fall back to original if anything fails
        img.src = dataUrl;
    });
}

// ─── Build engine ─────────────────────────────────────────────

let _currentCallLabel = '';

function buildEngine() {
    const apiKey   = apiKeyInput.value.trim();
    const modelDef = MODELS[modelSelect.value];

    if (!apiKey) {
        toast('Please enter an API Key', 'error');
        return null;
    }

    return new SPPInverseEngine({
        llmProvider: async (imageDataUrl, systemPrompt, userText) => {
            const start = Date.now();
            const label = _currentCallLabel || 'AI Call';
            const result = await callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef);
            addAiCallRecord(label, systemPrompt, userText, result, Date.now() - start);
            return result;
        },
        onStatus: msg => {
            toast(msg, 'info');
            log(msg, 'running');
            _currentCallLabel = msg.replace(/\.\.\.$/, '').trim();
        },
    });
}

// ─── Main reconstruction (Phase 1–4) ─────────────────────────

// ─── Step 0/1: Door sealing helpers ───────────────────────────

/**
 * Draw wall lines over each detected door opening, producing a "sealed" image
 * where all doors appear as solid walls. Used so layout AI sees clean boundaries.
 *
 * @param {string} imageDataUrl
 * @param {Array}  doorSymbols  - [{ cx, cy, width, angle }, ...] normalized 0–1
 * @returns {Promise<string>}   - sealed image data URL
 */
function sealDoorOpenings(imageDataUrl, doorSymbols) {
    return new Promise(resolve => {
        if (!doorSymbols || doorSymbols.length === 0) { resolve(imageDataUrl); return; }
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // Wall-line style: black, thickness ≈ 0.6% of image width
            ctx.strokeStyle = '#000000';
            ctx.lineWidth   = Math.max(3, img.naturalWidth * 0.006);
            ctx.lineCap     = 'round';

            for (const door of doorSymbols) {
                const cx  = door.cx    * img.naturalWidth;
                const cy  = door.cy    * img.naturalHeight;
                const hl  = (door.width * img.naturalWidth) / 2;
                const ang = door.angle || 0;

                ctx.beginPath();
                if (Math.abs(ang - 90) < 45) {
                    // Door in vertical wall → seal with vertical segment
                    ctx.moveTo(cx, cy - hl);
                    ctx.lineTo(cx, cy + hl);
                } else {
                    // Door in horizontal wall → seal with horizontal segment
                    ctx.moveTo(cx - hl, cy);
                    ctx.lineTo(cx + hl, cy);
                }
                ctx.stroke();
            }
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(imageDataUrl); // fallback: use original
        img.src = imageDataUrl;
    });
}

/**
 * Map door symbol pixel positions → grid (x, z, face) annotations.
 * Called after layout analysis so we have cropInfo + gridInfo.
 *
 * @param {Array}  doorSymbols  - [{ cx, cy, width, angle }, ...] normalized 0–1
 * @param {Object} cropInfo     - { x, y, w, h } floor plan region within image
 * @param {Object} gridInfo     - { gridX, gridZ }
 * @returns {Array}             - [{ x, z, face, optionId }, ...]
 */
function mapDoorsToGrid(doorSymbols, cropInfo, gridInfo) {
    if (!doorSymbols || doorSymbols.length === 0) return [];
    const { gridX, gridZ } = gridInfo;
    const annotations = [];

    for (const door of doorSymbols) {
        // Translate full-image pixel coords into floor-plan-relative coords (0–1)
        const relX = (door.cx - cropInfo.x) / cropInfo.w;
        const relZ = (door.cy - cropInfo.y) / cropInfo.h;

        // Skip anything outside the floor plan bounds
        if (relX < 0 || relX > 1 || relZ < 0 || relZ > 1) continue;

        const ang = door.angle || 0;

        if (Math.abs(ang - 90) < 45) {
            // Vertical wall: door is between cell (gx, gz) and (gx+1, gz)
            // The boundary is at integer grid X values; round to nearest
            const gx = Math.round(relX * gridX) - 1; // left cell of the pair
            const gz = Math.floor(relZ * gridZ);
            if (gx >= 0 && gx < gridX - 1 && gz >= 0 && gz < gridZ) {
                annotations.push({ x: gx, z: gz, face: 0, optionId: 2 }); // face 0 = +X
            }
        } else {
            // Horizontal wall: door is between cell (gx, gz) and (gx, gz+1)
            const gx = Math.floor(relX * gridX);
            const gz = Math.round(relZ * gridZ) - 1; // top cell of the pair
            if (gx >= 0 && gx < gridX && gz >= 0 && gz < gridZ - 1) {
                annotations.push({ x: gx, z: gz, face: 4, optionId: 2 }); // face 4 = +Z
            }
        }
    }

    // Deduplicate (same x/z/face)
    const seen = new Set();
    return annotations.filter(a => {
        const key = `${a.x},${a.z},${a.face}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Structural refinement helpers ────────────────────────────

/**
 * Compute the normalized crop for a group of cells within their parent grid.
 * Returns coordinates relative to the full source image.
 */
function calculateRegionCrop(parentCropInfo, gridInfo, cells) {
    const { gridX, gridZ } = gridInfo;
    const xs = cells.map(c => c.position[0]);
    const zs = cells.map(c => c.position[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    return {
        x: parentCropInfo.x + parentCropInfo.w * (minX / gridX),
        y: parentCropInfo.y + parentCropInfo.h * (minZ / gridZ),
        w: parentCropInfo.w * ((maxX - minX + 1) / gridX),
        h: parentCropInfo.h * ((maxZ - minZ + 1) / gridZ),
    };
}

/**
 * Structural recursive refinement.
 * Scans cells for structural complexity, groups adjacent complex cells into regions,
 * crops the source image for each region, calls AI for a finer sub-grid, integrates
 * the result, and recurses on the new sub-cells.
 *
 * @param {Array}  cells        - cells at the current depth level
 * @param {Object} gridInfo     - { gridX, gridZ, layout } for this level
 * @param {Object} cropInfo     - normalized { x, y, w, h } within the full source image
 * @param {number} depth        - current recursion depth (starts at 0)
 */
async function runStructuralRefinement(cells, gridInfo, cropInfo, depth = 0) {
    if (depth >= MAX_DEPTH) return;
    if (!gridInfo.layout) return;

    const complexCells = scanComplexCells(cells, gridInfo.layout);
    if (complexCells.length === 0) {
        log(`  Depth ${depth}: no complex cells — done`, 'success');
        return;
    }

    log(`Structural depth ${depth}: ${complexCells.length} complex cell(s) → grouping...`);
    const divergentCoords = complexCells.map(c => ({ gx: c.position[0], gz: c.position[2] }));
    const regions = regressionEng.groupDivergentRegions(divergentCoords, cells, gridInfo);
    log(`  ${regions.length} region(s) identified`);

    for (const [i, region] of regions.entries()) {
        const roomNames = [...new Set(region.cells.map(c => c.room))].join(', ');
        log(`  Region ${i + 1}/${regions.length}: ${region.cells.length} cell(s) [${roomNames}]`, 'running');

        const regionCropInfo = calculateRegionCrop(cropInfo, gridInfo, region.cells);

        let aiOutput;
        if (MOCK) {
            const scale = 3;
            const mockResult = buildMockSubGrid(region.cells, scale);
            // Build layout from sub-cells so recursion can evaluate their complexity
            const subLayout = Array.from({ length: mockResult.gridZ }, (_, rz) =>
                Array.from({ length: mockResult.gridX }, (_, rx) => {
                    const minX = Math.min(...region.cells.map(c => c.position[0]));
                    const minZ = Math.min(...region.cells.map(c => c.position[2]));
                    const parent = region.cells.find(c =>
                        c.position[0] - minX === Math.floor(rx / scale) &&
                        c.position[2] - minZ === Math.floor(rz / scale)
                    );
                    return parent?.room || null;
                })
            );
            aiOutput = { ...mockResult, layout: subLayout };
        } else {
            const constraints = regressionEng.extractConstraints(region.cells);
            const cropImage   = await regressionEng.cropRegion(state.imageDataUrl, regionCropInfo);

            const localGridInfo = await state.engine.analyzeGridSize(cropImage, {
                constraints,
                parentLayout: region.parentLayout,
            });
            const localCells = generateCellsFromLayout(
                localGridInfo.layout, localGridInfo.gridX, localGridInfo.gridZ, []
            );
            aiOutput = {
                scale:   localGridInfo.scale || 3,
                gridX:   localGridInfo.gridX,
                gridZ:   localGridInfo.gridZ,
                cells:   localCells,
                layout:  localGridInfo.layout,
            };
        }

        RecursiveGridManager.integratePerCellRefinement(region.cells, aiOutput);

        // Tag sub-cells with depth metadata
        for (const parent of region.cells) {
            for (const sub of parent.refinement?.cells || []) {
                sub._depth      = depth + 1;
                sub._parentCell = parent;
            }
        }

        log(`  Region ${i + 1} integrated: ${aiOutput.cells.length} sub-cells`, 'success');

        // Recurse on sub-cells
        const subCells = region.cells.flatMap(c => c.refinement?.cells || []);
        if (subCells.length > 0) {
            const subGridInfo = { gridX: aiOutput.gridX, gridZ: aiOutput.gridZ, layout: aiOutput.layout };
            await runStructuralRefinement(subCells, subGridInfo, regionCropInfo, depth + 1);
        }
    }

    layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
}

async function runReconstruct() {
    if (!state.imageDataUrl) return;

    const engine = MOCK ? null : buildEngine();
    if (!engine && !MOCK) return;
    state.engine = engine;

    setAnalyzing(true);
    selectionMgr.clear();
    log('─── Reconstruction started ───', 'phase');

    try {
        let gridInfo, cells;

        if (MOCK) {
            log('Mock mode — using preset data');
            ({ gridInfo, cells } = buildMockData());

            state.gridInfo  = gridInfo;
            state.rootCells = cells;
            state.cropInfo  = gridInfo.crop || { x: 0, y: 0, w: 1, h: 1 };
        } else {
            // ── Step 0: Door symbol detection (full image, before sealing) ──
            log('Step 0: Detecting door symbols...', 'running');
            let doorSymbols = [];
            try {
                doorSymbols = await engine.detectDoorSymbols(state.imageDataUrl);
                log(`Step 0 done: ${doorSymbols.length} door symbol(s) detected`);
            } catch (e) {
                log(`Step 0 skipped: ${e.message}`);
            }

            // ── Step 1: Seal door openings → clean wall image ────
            log('Step 1: Sealing door openings...', 'running');
            const sealedImage = await sealDoorOpenings(state.imageDataUrl, doorSymbols);
            log(`Step 1 done${doorSymbols.length ? ` (${doorSymbols.length} opening(s) sealed)` : ' (no doors to seal)'}`);

            // ── Step 2: Auto-detect crop on original image ────────
            log('Step 2: Auto-detecting floor plan bounds...', 'running');
            const autoCrop = state.autoCrop || await detectFloorPlanBounds(state.imageDataUrl);
            state.autoCrop = autoCrop;
            log(`Crop: x=${autoCrop.x.toFixed(3)}, y=${autoCrop.y.toFixed(3)}, w=${autoCrop.w.toFixed(3)}, h=${autoCrop.h.toFixed(3)}`);

            // ── Step 3: Layout analysis on sealed image ───────────
            log('Step 3: Cropping and preprocessing sealed image...', 'running');
            const croppedSealed   = await cropToDataUrl(sealedImage, autoCrop);
            const processedSealed = await preprocessFloorPlan(croppedSealed);
            state.croppedImageDataUrl = processedSealed;

            const dims        = await getImageDimensions(state.imageDataUrl);
            const aspectRatio = (dims.width * autoCrop.w) / (dims.height * autoCrop.h);

            log('Step 3: AI layout analysis (rooms → grid size → fill)...', 'running');
            const layoutResult  = await engine.analyzeLayoutOnly(processedSealed, aspectRatio);
            const trimmedLayout = trimNullBorders(layoutResult.layout);
            const trimmedGridX  = trimmedLayout[0]?.length || layoutResult.gridX;
            const trimmedGridZ  = trimmedLayout.length     || layoutResult.gridZ;

            gridInfo = { ...layoutResult, layout: trimmedLayout, gridX: trimmedGridX, gridZ: trimmedGridZ, crop: autoCrop };
            log(`Step 3 done: ${trimmedGridX}×${trimmedGridZ} grid`);
            gridInfo.layout.forEach((row, z) => log(`  row ${z}: ${row.map(r => r || '·').join(' | ')}`));

            // ── Step 4: Deterministic wall topology ───────────────
            log('Step 4: Generating walls from layout...');
            cells = generateCellsFromLayout(gridInfo.layout, gridInfo.gridX, gridInfo.gridZ, []);
            log(`Step 4 done: ${cells.length} cells`);

            // Preview after step 4
            state.gridInfo  = gridInfo;
            state.rootCells = cells;
            state.cropInfo  = autoCrop;

            layerRenderer.render(state.rootCells, gridInfo.gridX, gridInfo.gridZ);
            layerRenderer.focusScene();
            floorTex.dispose();
            await floorTex.init(
                layerRenderer.scene, state.imageDataUrl, state.cropInfo,
                gridInfo.gridX, gridInfo.gridZ, CELL_SIZE
            );
            floorTex.setOpacity(Number(floorOpacity.value));
            log('Step 4 preview rendered — starting structural refinement...', 'success');

            // ── Step 5: Structural recursive refinement ───────────
            log('Step 5: Structural complexity scan & recursive refinement...', 'running');
            await runStructuralRefinement(cells, gridInfo, autoCrop, 0);
            log('Step 5 structural refinement complete', 'success');

            // ── Step 6: Map door symbols → grid annotations ───────
            const doorAnnotations = mapDoorsToGrid(doorSymbols, autoCrop, gridInfo);
            log(`Step 6: ${doorAnnotations.length} door(s) mapped to grid`);

            // ── Step 7: Pierce doors into root cell faceOptions ───
            if (doorAnnotations.length > 0) {
                cells = engine.pierceFeatures(state.rootCells, doorAnnotations);
                state.rootCells = cells;
                log(`Step 7: ${doorAnnotations.length} door(s) pierced`);
            }
        }

        layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        if (MOCK) {
            layerRenderer.focusScene();
            floorTex.dispose();
            await floorTex.init(
                layerRenderer.scene, state.imageDataUrl, state.cropInfo,
                state.gridInfo.gridX, state.gridInfo.gridZ, CELL_SIZE
            );
            floorTex.setOpacity(Number(floorOpacity.value));
        }

        depthLegend.style.display = 'flex';
        phase5Btn.classList.add('visible');
        phase5Btn.disabled = false;
        exportBtn.style.display = 'inline-block';
        viewBtn.style.display   = 'inline-block';

        log(`✓ Reconstruction complete`, 'success');
        toast(`✓ ${state.gridInfo.gridX}×${state.gridInfo.gridZ} grid, ${state.rootCells.length} cells`, 'success');

    } catch (err) {
        console.error(err);
        log(`✗ ${err.message}`, 'error');
        toast(`Reconstruction failed: ${err.message}`, 'error');
    } finally {
        setAnalyzing(false);
    }
}

// ─── Phase 5: manual structural re-refinement ─────────────────
// Triggered by the "Auto Refine" button after initial reconstruction.
// Re-runs structural complexity scan on the current leaf cells, going one
// level deeper. Useful after the user edits or deletes refinements.

async function runPhase5Loop() {
    if (!state.rootCells.length) return;
    if (!state.imageDataUrl) return;
    if (!MOCK && !state.engine) { toast('Run initial analysis first', 'error'); return; }

    phase5Btn.disabled = true;
    log('─── Structural re-refinement pass ───', 'phase');

    try {
        // Collect current leaf cells (cells without refinement)
        const leafCells = state.rootCells.filter(c => !c.refinement);
        const currentDepth = 0; // operate at root depth; scanComplexCells uses layout

        if (!state.gridInfo.layout) {
            toast('No layout available — run reconstruction first', 'error');
            return;
        }

        await runStructuralRefinement(leafCells, state.gridInfo, state.cropInfo, currentDepth);

        layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        toast('Structural re-refinement complete', 'success');
    } catch (err) {
        console.error(err);
        log(`✗ Re-refinement failed: ${err.message}`, 'error');
        toast(`Re-refinement failed: ${err.message}`, 'error');
    } finally {
        phase5Btn.disabled = false;
    }
}

// ─── Manual refinement (selected cells) ───────────────────────

async function refineSelected() {
    const selected = [...selectionMgr.selectedCells];
    if (selected.length === 0) return;

    const rootCells = selected.filter(c => (c._depth || 0) === 0);
    if (rootCells.length === 0) {
        toast('Select depth-0 (coarse) cells to refine', 'error');
        return;
    }

    log('─── Manual refinement ───', 'phase');
    toast('Manual refinement: running local Phase 1-4...', 'info');
    try {
        const parentLayout = buildParentLayout(rootCells);
        await refineRegion(rootCells, parentLayout);
        layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        selectionMgr.clear();
        log('✓ Manual refinement complete', 'success');
        toast('Manual refinement complete', 'success');
    } catch (err) {
        log(`✗ ${err.message}`, 'error');
        toast(`Refinement failed: ${err.message}`, 'error');
    }
}

/** Core refinement logic — shared by Phase 5 loop and manual refinement */
async function refineRegion(selectedCells, parentLayout) {
    const maxCurrentDepth = Math.max(...selectedCells.map(c => c._depth || 0));
    if (maxCurrentDepth >= MAX_DEPTH) {
        log(`Max depth (${MAX_DEPTH}) reached — skipping`);
        toast(`Max refinement depth (${MAX_DEPTH}) reached — skipping.`);
        return;
    }

    const constraints = regressionEng.extractConstraints(selectedCells);
    log(`Cropping region (${selectedCells.length} cells)...`, 'running');
    const cropImage   = await regressionEng.cropToCells(
        state.imageDataUrl, state.cropInfo, state.gridInfo, selectedCells
    );

    let aiOutput;
    if (MOCK) {
        log('Building mock sub-grid...');
        aiOutput = buildMockSubGrid(selectedCells, 3);
    } else {
        log('Local Phase 1: sub-grid layout (AI)...', 'running');
        const localGridInfo = await state.engine.analyzeGridSize(cropImage, { constraints, parentLayout });
        log(`Local grid: ${localGridInfo.gridX}×${localGridInfo.gridZ} (scale=${localGridInfo.scale || '?'})`);

        log('Local Phase 2: generating walls from layout...');
        const localCells = generateCellsFromLayout(
            localGridInfo.layout, localGridInfo.gridX, localGridInfo.gridZ, []
        );
        log(`Local Phase 2 done: ${localCells.length} sub-cells`);

        log('Local Phase 3: detecting doors/windows (AI)...', 'running');
        let localAnn = [];
        try {
            localAnn = await state.engine.detectFeatures(cropImage, localCells, localGridInfo);
            log(`Found ${localAnn.length} feature annotation(s)`);
        } catch (e) {
            log(`Local Phase 3 skipped: ${e.message}`);
        }

        log('Local Phase 4: piercing features...');
        const localFinal = state.engine.pierceFeatures(localCells, localAnn);

        aiOutput = {
            scale: localGridInfo.scale || 3,
            gridX: localGridInfo.gridX,
            gridZ: localGridInfo.gridZ,
            cells: localFinal,
        };
    }

    RecursiveGridManager.integratePerCellRefinement(selectedCells, aiOutput);
    log(`Integrated ${aiOutput.cells.length} sub-cells`);
}

// ─── Delete refinement ────────────────────────────────────────

function deleteRefinement() {
    const selected = [...selectionMgr.selectedCells];
    if (selected.length === 0) return;

    let blocked = false;
    for (const cell of selected) {
        const parent = cell._parentCell;
        if (!parent) continue;

        const hasDeeper = parent.refinement?.cells?.some(c => c.refinement);
        if (hasDeeper) {
            toast('Delete deeper refinement layers first', 'error');
            blocked = true;
            break;
        }
        delete parent.refinement;
    }

    if (!blocked) {
        layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        selectionMgr.clear();
        toast('Refinement layer removed', 'success');
    }
}

// ─── Connectivity analysis ────────────────────────────────────

/**
 * BFS flood-fill through OPEN (optionId=0) faces to find connected room islands.
 * Face layout in faceOptions: [+X, -X, +Y, -Y, z-1, z+1]
 * Returns Map<cell, componentId>.
 */
function computeRoomComponents(leafCells) {
    // Build position lookup (rounded to avoid float key issues)
    const byPos = new Map();
    for (const cell of leafCells) {
        const [x, , z] = cell.position;
        byPos.set(`${Math.round(x * 100)},${Math.round(z * 100)}`, cell);
    }

    // [myFaceIdx, dx, dz] — matches faceOptions after the POS_Z/NEG_Z fix
    const DIRS = [
        [0,  1,  0],   // faceOptions[0]: POS_X → neighbor at x+1
        [1, -1,  0],   // faceOptions[1]: NEG_X → neighbor at x-1
        [4,  0,  1],   // faceOptions[4]: POS_Z → neighbor at z+1
        [5,  0, -1],   // faceOptions[5]: NEG_Z → neighbor at z-1
    ];

    const componentId = new Map();
    let nextId = 0;

    for (const startCell of leafCells) {
        if (componentId.has(startCell)) continue;
        const id = nextId++;
        const queue = [startCell];
        componentId.set(startCell, id);

        while (queue.length) {
            const cell = queue.shift();
            const [cx, , cz] = cell.position;

            for (const [myFace, dx, dz] of DIRS) {
                const optId = cell.faceOptions?.[myFace]?.[0];
                if (optId !== 0) continue;  // only OPEN faces (same room)

                const nk = `${Math.round((cx + dx) * 100)},${Math.round((cz + dz) * 100)}`;
                const neighbor = byPos.get(nk);
                if (!neighbor || componentId.has(neighbor)) continue;
                componentId.set(neighbor, id);
                queue.push(neighbor);
            }
        }
    }

    return componentId;
}

// ─── Selection change callback ────────────────────────────────

function onSelectionChange(selectedCells) {
    const count = selectedCells.size;
    selectedCount.textContent = count;
    actionBar.classList.toggle('hidden', count === 0);

    if (count > 0 && state.rootCells.length > 0) {
        // Show connectivity: color all leaf cells by connected-room component
        const leafCells = RecursiveGridManager.flattenRecursiveCells(
            state.rootCells, [0, 0, 0], CELL_SIZE
        );
        const componentMap = computeRoomComponents(leafCells);
        layerRenderer.highlightComponents(componentMap, selectedCells);
    } else {
        // Restore normal depth-based colors
        layerRenderer.highlightSelection(selectedCells);
    }
}

// ─── Keyboard shortcuts ───────────────────────────────────────

function onKeyDown(e) {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toUpperCase()) {
        case 'S': toggleSelectMode(); break;
        case 'T': layerRenderer.toggleTopView(); break;
        case 'E': exportJSON(); break;
        case 'V': viewJSON(); break;
        case 'ESCAPE':
            if (jsonOverlay.classList.contains('open')) jsonOverlay.classList.remove('open');
            else selectionMgr.clear();
            break;
        case 'DELETE':
        case 'BACKSPACE': deleteRefinement(); break;
    }
}

// ─── Export & View ────────────────────────────────────────────

function buildJSONText() {
    return JSON.stringify({
        gridX: state.gridInfo.gridX,
        gridZ: state.gridInfo.gridZ,
        cells: state.rootCells,
    }, null, 2);
}

function exportJSON() {
    if (!state.rootCells.length) return;
    const blob = new Blob([buildJSONText()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spp-reconstruction.json';
    a.click();
}

function viewJSON() {
    if (!state.rootCells.length) return;
    const cellCount    = state.rootCells.length;
    const refinedCount = state.rootCells.filter(c => c.refinement).length;
    jsonTitle.textContent =
        `SPP JSON — ${state.gridInfo.gridX}×${state.gridInfo.gridZ}  ·  ${cellCount} cells` +
        (refinedCount ? `  ·  ${refinedCount} refined` : '');
    jsonContent.innerHTML = syntaxHighlight(buildJSONText());
    jsonCopyBtn.textContent = 'Copy';
    jsonCopyBtn.classList.remove('copied');
    jsonOverlay.classList.add('open');
}

function syntaxHighlight(json) {
    return json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(
            /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
            match => {
                if (/^"/.test(match)) {
                    return /:$/.test(match)
                        ? `<span class="jk">${match}</span>`
                        : `<span class="js">${match}</span>`;
                }
                if (/true|false|null/.test(match)) return `<span class="jb">${match}</span>`;
                return `<span class="jn">${match}</span>`;
            }
        );
}

// ─── Select mode toggle ───────────────────────────────────────

function toggleSelectMode() {
    const on = !selectionMgr.selectMode;
    selectionMgr.selectMode = on;
    layerRenderer.setSelectMode(on);
    selectBtn.classList.toggle('active', on);
    selectBtn.title = on ? 'Select mode ON — left-drag to paint, click to toggle  (S)' : 'Enter select mode  (S)';
}

// ─── Helpers ──────────────────────────────────────────────────

function setAnalyzing(on) {
    analyzeBtn.disabled = on;
    analyzeBtn.textContent = on ? 'Analyzing...' : '▶ Analyze';
    analyzeBtn.classList.toggle('spinner', on);
    if (on) {
        logPanel.classList.add('open');
        logBtn.classList.add('active');
    }
}

let _runningEntryEl = null;
function log(msg, type = 'info') {
    // Always clear the previous running spinner — even if the new entry is also 'running'
    if (_runningEntryEl) {
        _runningEntryEl.classList.remove('log-running');
        _runningEntryEl = null;
    }
    const now = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const el = document.createElement('div');
    el.className = `log-entry log-${type}`;
    el.innerHTML = `<span class="log-time">${now}</span><span class="log-msg">${msg}</span>`;
    logEntries.appendChild(el);
    logEntries.scrollTop = logEntries.scrollHeight;
    if (type === 'running') _runningEntryEl = el;
}

// ─── Tab switching ────────────────────────────────────────────

let _activeTab = 'log';
function switchTab(tab) {
    _activeTab = tab;
    tabLog.classList.toggle('active', tab === 'log');
    tabInspector.classList.toggle('active', tab === 'inspector');
    logContent.classList.toggle('active', tab === 'log');
    inspectorContent.classList.toggle('active', tab === 'inspector');
    if (tab === 'inspector') tabInspector.textContent = 'Inspector';
}

// ─── Inspector: cell info ─────────────────────────────────────

function updateInspectorCell(cell) {
    const OPT = { 0: ['open','open'], 1: ['arch','arch'], 2: ['door','door'],
                  10: ['wall','wall'], 20: ['win','win'] };
    // 0=POS_X(right col), 1=NEG_X(left col), 4=POS_Z(next row down), 5=NEG_Z(prev row up)
    const FACES = [[0,'→R'],[1,'←L'],[4,'↓B'],[5,'↑T']];
    const [px, , pz] = cell.position;
    const facesHtml = FACES.map(([idx, lbl]) => {
        const optId = cell.faceOptions?.[idx]?.[0];
        const [cls, name] = OPT[optId] ?? ['', optId === undefined ? '?' : `#${optId}`];
        return `<span>${lbl}: <b class="${cls}">${name}</b></span>`;
    }).join('');
    inspCell.innerHTML =
        `<div class="insp-room">${cell.room || '<i>null</i>'}</div>` +
        `<div class="insp-pos">col ${px}  row ${pz} · depth ${cell._depth || 0}</div>` +
        `<div class="insp-faces">${facesHtml}</div>`;
}

// ─── Inspector: AI call records ───────────────────────────────

let _aiCallCount = 0;
function addAiCallRecord(label, systemPrompt, userText, response, durationMs) {
    _aiCallCount++;
    // Remove placeholder
    const placeholder = aiCallsList.querySelector('.insp-placeholder');
    if (placeholder) placeholder.remove();

    const sec = (durationMs / 1000).toFixed(1);
    const el = document.createElement('div');
    el.className = 'ai-call';
    el.innerHTML =
        `<div class="ai-call-header">` +
            `<span class="ai-call-label">#${_aiCallCount} ${label}</span>` +
            `<span><span class="ai-call-meta">${sec}s</span> <span class="ai-call-arrow">▶</span></span>` +
        `</div>` +
        `<div class="ai-call-body">` +
            `<div class="ai-section-label">System Prompt</div>` +
            `<pre class="ai-text">${escHtml(systemPrompt)}</pre>` +
            `<div class="ai-section-label">User Message</div>` +
            `<pre class="ai-text">${escHtml(userText)}</pre>` +
            `<div class="ai-section-label">Response</div>` +
            `<pre class="ai-text">${escHtml(response)}</pre>` +
        `</div>`;

    el.querySelector('.ai-call-header').addEventListener('click', () => {
        el.classList.toggle('open');
    });

    aiCallsList.appendChild(el);
    aiCallsList.scrollTop = aiCallsList.scrollHeight;

    // Auto-switch to inspector tab so user sees the new record
    if (_activeTab !== 'inspector') {
        // Just badge the tab instead of forcing a switch
        tabInspector.textContent = `Inspector (${_aiCallCount})`;
    }
}

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Format cell debug info for the hover tooltip bubble */
function formatCellTooltip(cell) {
    const OPT = { 0: ['open', 'open'], 1: ['arch', 'arch'], 2: ['door', 'door'],
                  10: ['wall', 'wall'], 20: ['win', 'win'] };
    // faceOptions: 0=POS_X(→right col), 1=NEG_X(←left col), 4=POS_Z(↓next row), 5=NEG_Z(↑prev row)
    const FACES = [
        [0, '→R'], [1, '←L'], [4, '↓B'], [5, '↑T'],
    ];
    const [px, , pz] = cell.position;
    const faceHtml = FACES.map(([idx, label]) => {
        const optId = cell.faceOptions?.[idx]?.[0];
        const [cls, name] = OPT[optId] ?? ['', optId === undefined ? '?' : `#${optId}`];
        return `<span class="tt-face">${label}: <b class="${cls}">${name}</b></span>`;
    }).join('');
    return `<div class="tt-room">${cell.room || '<i>null</i>'}</div>` +
           `<div class="tt-pos">col ${px}  row ${pz}  depth ${cell._depth || 0}</div>` +
           `<div class="tt-faces">${faceHtml}</div>`;
}

function buildParentLayout(cells) {
    const xs = cells.map(c => c.position[0]);
    const zs = cells.map(c => c.position[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const cellMap = new Map(cells.map(c => [`${c.position[0]},${c.position[2]}`, c]));
    return Array.from({ length: maxZ - minZ + 1 }, (_, rz) =>
        Array.from({ length: maxX - minX + 1 }, (_, rx) =>
            cellMap.get(`${minX + rx},${minZ + rz}`)?.room || null
        )
    );
}

let _toastTimer = null;
function toast(msg, type = 'info') {
    toastEl.textContent = msg;
    toastEl.className = 'visible' + (type !== 'info' ? ` toast-${type}` : '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 4000);
}

// ─── API callers ──────────────────────────────────────────────

async function callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef) {
    if (modelDef.provider === 'qwen') {
        return callQwen(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    } else if (modelDef.provider === 'gemini') {
        return callGemini(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    }
    throw new Error(`Unknown provider: ${modelDef.provider}`);
}

async function callQwen(apiKey, imageDataUrl, systemPrompt, userText, modelId) {
    const body = {
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: imageDataUrl } },
                { type: 'text', text: userText },
            ]},
        ],
        temperature: 0.1,
        max_tokens: 8192,
    };
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Qwen API error (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

async function callGemini(apiKey, imageDataUrl, systemPrompt, userText, modelId) {
    const base64 = imageDataUrl.split(',')[1];
    const mime   = (imageDataUrl.match(/data:([^;]+);/) || [])[1] || 'image/png';
    const body = {
        contents: [{ parts: [
            { text: systemPrompt },
            { inline_data: { mime_type: mime, data: base64 } },
            { text: userText },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Gemini API error (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── Mock data ────────────────────────────────────────────────

async function loadMockData() {
    setAnalyzing(true);
    selectionMgr.clear();
    try {
        state.imageDataUrl = await loadImageAsDataUrl('assets/mock-floorplan.png');

        const { gridInfo, cells } = buildMockData();
        state.gridInfo  = gridInfo;
        state.rootCells = cells;
        state.cropInfo  = gridInfo.crop;

        layerRenderer.render(state.rootCells, gridInfo.gridX, gridInfo.gridZ);
        layerRenderer.focusScene();

        floorTex.dispose();
        await floorTex.init(
            layerRenderer.scene,
            state.imageDataUrl,
            state.cropInfo,
            gridInfo.gridX,
            gridInfo.gridZ,
            CELL_SIZE
        );
        floorTex.setOpacity(Number(floorOpacity.value));

        analyzeBtn.disabled = false;
        depthLegend.style.display = 'flex';
        phase5Btn.classList.add('visible');
        phase5Btn.disabled = false;
        exportBtn.style.display = 'inline-block';
        viewBtn.style.display   = 'inline-block';

        toast(`✓ Mock ready: ${gridInfo.gridX}×${gridInfo.gridZ} grid, ${cells.length} cells`, 'success');
    } catch (err) {
        console.error(err);
        toast(`Mock load failed: ${err.message}`, 'error');
    } finally {
        setAnalyzing(false);
    }
}

function loadImageAsDataUrl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
        img.src = src;
    });
}

function buildMockData() {
    // Qwen qwen-vl-max output — Step1A+1C only, no Step3 doors (2026-03-18, prompt v2)
    const layout = [
        ['Kitchen',     'Kitchen',     'Kitchen',     'Hallway', 'Bathroom', 'Bathroom', 'Bathroom'],
        ['Kitchen',     'Kitchen',     'Kitchen',     'Hallway', 'Bathroom', 'Bathroom', 'Bathroom'],
        ['Kitchen',     'Kitchen',     'Kitchen',     'Hallway', 'Bedroom',  'Bedroom',  'Bedroom'],
        ['Living Room', 'Living Room', 'Living Room', 'Hallway', 'Bedroom',  'Bedroom',  'Bedroom'],
        ['Living Room', 'Living Room', 'Living Room', 'Hallway', 'Bedroom',  'Bedroom',  'Bedroom'],
        ['Living Room', 'Living Room', 'Living Room', 'Hallway', 'Bedroom',  'Bedroom',  'Bedroom'],
        ['Living Room', 'Living Room', 'Living Room', 'Hallway', 'Bedroom',  'Bedroom',  'Bedroom'],
    ];
    const gridX = 7, gridZ = 7;

    // No Step3 — doors/windows omitted to evaluate layout quality alone
    const cells = generateCellsFromLayout(layout, gridX, gridZ, []);

    return {
        cells,
        gridInfo: {
            crop: { x: 0.12, y: 0.12, w: 0.76, h: 0.76 },
            gridX, gridZ, layout,
        },
    };
}

function buildMockSubGrid(selectedCells, scale) {
    const xs   = selectedCells.map(c => c.position[0]);
    const zs   = selectedCells.map(c => c.position[2]);
    const minX = Math.min(...xs);
    const minZ = Math.min(...zs);
    const cols = Math.max(...xs) - minX + 1;
    const rows = Math.max(...zs) - minZ + 1;
    const gX   = cols * scale;
    const gZ   = rows * scale;

    const subCells = [];
    for (let sz = 0; sz < gZ; sz++) {
        for (let sx = 0; sx < gX; sx++) {
            const px = Math.floor(sx / scale);
            const pz = Math.floor(sz / scale);
            const parent = selectedCells.find(
                c => c.position[0] - minX === px && c.position[2] - minZ === pz
            );
            subCells.push({
                position:    [sx, 0, sz],
                size:        [1, 1, 1],
                faceStates:  0b111111,
                room:        parent?.room || null,
                faceOptions: [
                    sx < gX - 1 ? [0] : [10],  // +X
                    sx > 0      ? [0] : [10],  // -X
                    [], [],
                    sz > 0      ? [0] : [10],  // +Z
                    sz < gZ - 1 ? [0] : [10],  // -Z
                ],
            });
        }
    }

    return { scale, gridX: gX, gridZ: gZ, cells: subCells };
}
