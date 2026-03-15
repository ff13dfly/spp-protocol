/**
 * main.js — SPP Inverse Modeling Demo V2
 *
 * Full 5-phase reconstruction pipeline:
 *   Phase 1: AI coarse grid detection
 *   Phase 2: AI binary topology (Wall / Open)
 *   Phase 3: AI door/window detection
 *   Phase 4: Deterministic feature piercing
 *   Phase 5: Top-view regression → local Phase 1-4 recursive refinement
 */

import { LayerRenderer, CELL_SIZE } from './renderer.js';
import { SelectionManager }         from './selection.js';
import { FloorTexture }             from './floor-texture.js';
import { RegressionEngine }         from './regression.js';
import {
    SPPInverseEngine,
    RecursiveGridManager,
    generateCellsFromLayout,
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
    imageDataUrl: null,
    cropInfo:     null,
    rootCells:    [],
    gridInfo:     null,
    engine:       null,
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
const floorOpacity  = document.getElementById('floorOpacity');
const selBoxEl      = document.getElementById('selectionBox');
const depthLegend   = document.getElementById('depthLegend');
const viewBtn       = document.getElementById('viewBtn');
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
        onSelectionChange,
        selBoxEl
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
    topViewBtn.addEventListener('click', () => layerRenderer.toggleTopView());
    exportBtn.addEventListener('click', exportJSON);

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
    reader.onload = e => {
        state.imageDataUrl = e.target.result;
        analyzeBtn.disabled = false;
        toast('Image loaded — click Analyze to start reconstruction.');
    };
    reader.readAsDataURL(file);
}

// ─── Build engine ─────────────────────────────────────────────

function buildEngine() {
    const apiKey   = apiKeyInput.value.trim();
    const modelDef = MODELS[modelSelect.value];

    if (!apiKey) {
        toast('Please enter an API Key', 'error');
        return null;
    }

    return new SPPInverseEngine({
        llmProvider: async (imageDataUrl, systemPrompt, userText) =>
            callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef),
        onStatus: msg => toast(msg, 'info'),
    });
}

// ─── Main reconstruction (Phase 1–4) ─────────────────────────

async function runReconstruct() {
    if (!state.imageDataUrl) return;

    const engine = MOCK ? null : buildEngine();
    if (!engine && !MOCK) return;
    state.engine = engine;

    setAnalyzing(true);
    selectionMgr.clear();

    try {
        let gridInfo, cells;

        if (MOCK) {
            ({ gridInfo, cells } = buildMockData());
        } else {
            const result = await engine.reconstruct(state.imageDataUrl);
            gridInfo = result.gridInfo;
            cells    = result.cells;
        }

        state.gridInfo  = gridInfo;
        state.rootCells = cells;
        state.cropInfo  = gridInfo.crop || { x: 0, y: 0, w: 1, h: 1 };

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

        depthLegend.style.display = 'flex';
        phase5Btn.classList.add('visible');
        phase5Btn.disabled = false;
        exportBtn.style.display = 'inline-block';
        viewBtn.style.display   = 'inline-block';

        toast(`✓ Reconstruction complete: ${gridInfo.gridX}×${gridInfo.gridZ} grid, ${cells.length} cells`, 'success');

    } catch (err) {
        console.error(err);
        toast(`Reconstruction failed: ${err.message}`, 'error');
    } finally {
        setAnalyzing(false);
    }
}

// ─── Phase 5: top-view regression loop ────────────────────────

async function runPhase5Loop(maxIterations = 3) {
    if (!state.rootCells.length) return;
    if (!state.imageDataUrl) return;
    if (!MOCK && !state.engine) { toast('Run initial analysis first', 'error'); return; }

    phase5Btn.disabled = true;
    toast('Phase 5: starting top-view regression...', 'info');

    try {
        for (let iter = 0; iter < maxIterations; iter++) {
            const topView  = layerRenderer.renderTopView();
            const divergent = await regressionEng.compareWithSource(
                topView, state.imageDataUrl, state.cropInfo, state.gridInfo
            );

            if (divergent.length === 0) {
                toast(`Phase 5: converged after ${iter + 1} round(s).`, 'success');
                break;
            }

            toast(`Phase 5 round ${iter + 1}: ${divergent.length} divergent cells — refining...`);

            const regions = regressionEng.groupDivergentRegions(divergent, state.rootCells, state.gridInfo);
            for (const region of regions) {
                await refineRegion(region.cells, region.parentLayout);
            }

            layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        }
    } catch (err) {
        console.error(err);
        toast(`Phase 5 failed: ${err.message}`, 'error');
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

    toast('Manual refinement: running local Phase 1-4...', 'info');
    try {
        const parentLayout = buildParentLayout(rootCells);
        await refineRegion(rootCells, parentLayout);
        layerRenderer.render(state.rootCells, state.gridInfo.gridX, state.gridInfo.gridZ);
        selectionMgr.clear();
        toast('Manual refinement complete', 'success');
    } catch (err) {
        toast(`Refinement failed: ${err.message}`, 'error');
    }
}

/** Core refinement logic — shared by Phase 5 loop and manual refinement */
async function refineRegion(selectedCells, parentLayout) {
    const maxCurrentDepth = Math.max(...selectedCells.map(c => c._depth || 0));
    if (maxCurrentDepth >= MAX_DEPTH) {
        toast(`Max refinement depth (${MAX_DEPTH}) reached — skipping.`);
        return;
    }

    const constraints = regressionEng.extractConstraints(selectedCells);
    const cropImage   = await regressionEng.cropToCells(
        state.imageDataUrl, state.cropInfo, state.gridInfo, selectedCells
    );

    let aiOutput;
    if (MOCK) {
        aiOutput = buildMockSubGrid(selectedCells, 3);
    } else {
        const localGridInfo = await state.engine.analyzeGridSize(cropImage, { constraints, parentLayout });
        const localResult   = await state.engine.classifyFaces(cropImage, localGridInfo);
        let localAnn = [];
        try {
            localAnn = await state.engine.detectFeatures(cropImage, localResult.cells, localGridInfo);
        } catch { /* non-blocking — proceed without door annotations */ }
        const localFinal = state.engine.pierceFeatures(localResult.cells, localAnn);

        aiOutput = {
            scale: localGridInfo.scale || 3,
            gridX: localGridInfo.gridX,
            gridZ: localGridInfo.gridZ,
            cells: localFinal,
        };
    }

    RecursiveGridManager.integratePerCellRefinement(selectedCells, aiOutput);
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

// ─── Selection change callback ────────────────────────────────

function onSelectionChange(selectedCells) {
    const count = selectedCells.size;
    selectedCount.textContent = count;
    actionBar.classList.toggle('hidden', count === 0);
    layerRenderer.highlightSelection(selectedCells);
}

// ─── Keyboard shortcuts ───────────────────────────────────────

function onKeyDown(e) {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toUpperCase()) {
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

// ─── Helpers ──────────────────────────────────────────────────

function setAnalyzing(on) {
    analyzeBtn.disabled = on;
    analyzeBtn.textContent = on ? 'Analyzing...' : '▶ Analyze';
    analyzeBtn.classList.toggle('spinner', on);
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
    // 6×5 two-bedroom apartment layout (z = row, x = col)
    const layout = [
        ['Kitchen',  'Kitchen',  'Hallway', 'Bedroom',     'Bedroom',     'Bedroom'],
        ['Kitchen',  'Kitchen',  'Hallway', 'Bedroom',     'Bedroom',     'Bedroom'],
        ['Bathroom', 'Bathroom', 'Hallway', 'Living Room', 'Living Room', 'Living Room'],
        ['Bathroom', 'Bathroom', 'Hallway', 'Living Room', 'Living Room', 'Living Room'],
        [null,       null,       'Hallway', 'Master Bed',  'Master Bed',  'Master Bed'],
    ];
    const gridX = 6, gridZ = 5;

    const cells = generateCellsFromLayout(layout, gridX, gridZ, []);

    // Door annotations (both sides of each doorway)
    const annotations = [
        { x: 1, z: 0, face: 0, optionId: 2 }, { x: 2, z: 0, face: 1, optionId: 2 },  // Kitchen ↔ Hallway
        { x: 3, z: 1, face: 1, optionId: 2 }, { x: 2, z: 1, face: 0, optionId: 2 },  // Bedroom ↔ Hallway
        { x: 1, z: 2, face: 0, optionId: 2 }, { x: 2, z: 2, face: 1, optionId: 2 },  // Bathroom ↔ Hallway
        { x: 3, z: 3, face: 1, optionId: 1 }, { x: 2, z: 3, face: 0, optionId: 1 },  // Living Room ↔ Hallway (arch)
        { x: 3, z: 4, face: 1, optionId: 2 }, { x: 2, z: 4, face: 0, optionId: 2 },  // Master Bed ↔ Hallway
    ];

    const engine = new SPPInverseEngine({ llmProvider: async () => '', onStatus: () => {} });
    const finalCells = engine.pierceFeatures(cells, annotations);

    return {
        cells: finalCells,
        gridInfo: {
            crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
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
