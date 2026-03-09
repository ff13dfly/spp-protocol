/**
 * main.js — Inverse Modeling Demo
 * Upload a floor plan → AI analyzes → 3D rendering
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeGridSize, classifyFaces, MODELS, DEFAULT_MODEL } from './prompt.js';
import { parseAIResponse } from './parser.js';
import { renderCells, rebuildCellWalls, CELL_SIZE } from './renderer-3d.js';
import { FACE_NAMES, OPTION_REGISTRY, ALL_IDS, cycleOption, getResolvedOption, expandScaledCells, optimizeGrid, generateCellsFromLayout } from './particle.js';
import { drawGridOverlay } from './grid-overlay.js';

// ─── Helpers ────────────────────────────────────────────────

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ─── State ──────────────────────────────────────────────────

let scene, camera, renderer, controls;
let currentGroup = null;
let currentCellMap = null;
let currentAllKeys = null;
let currentCells = null;
let raycaster, mouse;

// ─── DOM ────────────────────────────────────────────────────

const canvas = document.getElementById('canvas3d');
const fileInput = document.getElementById('fileInput');
const imagePreview = document.getElementById('imagePreview');
const imageWrapper = document.getElementById('imageWrapper');
const gridOverlayCanvas = document.getElementById('gridOverlayCanvas');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusText = document.getElementById('statusText');
const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('modelSelect');
const jsonOutput = document.getElementById('jsonOutput');
const descriptionText = document.getElementById('descriptionText');
const editInfo = document.getElementById('editInfo');

// ─── Populate Model Dropdown ────────────────────────────────

for (const [key, model] of Object.entries(MODELS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = model.name;
    modelSelect.appendChild(opt);
}

const savedModel = localStorage.getItem('spp_model') || DEFAULT_MODEL;
modelSelect.value = savedModel;
modelSelect.addEventListener('change', () => {
    localStorage.setItem('spp_model', modelSelect.value);
    // Load saved key for this model's provider
    const provider = MODELS[modelSelect.value]?.provider || '';
    apiKeyInput.value = localStorage.getItem(`spp_apikey_${provider}`) || '';
});

// ─── Init Three.js ──────────────────────────────────────────

function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5fa);

    camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
    camera.position.set(12, 14, 18);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.shadowMap.enabled = true;

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.48;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(8, 15, 10);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xc4d4ff, 0.4);
    fillLight.position.set(-6, 8, -4);
    scene.add(fillLight);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xeeeef3, roughness: 0.9 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);

    // Raycaster for editing
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Render loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
}

// ─── Resize ─────────────────────────────────────────────────

function onResize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ─── Image Upload ───────────────────────────────────────────

function showImage(src) {
    imagePreview.src = src;
    imageWrapper.style.display = 'inline-block';
    document.getElementById('uploadPlaceholder').style.display = 'none';
    // Clear any old grid overlay
    gridOverlayCanvas.getContext('2d').clearRect(0, 0, gridOverlayCanvas.width, gridOverlayCanvas.height);
    analyzeBtn.disabled = false;
}

function showGridOnImage(gridX, gridZ, layout, crop) {
    // Wait for image to load, then size canvas and draw overlay
    const draw = () => {
        gridOverlayCanvas.width = imagePreview.naturalWidth || imagePreview.width;
        gridOverlayCanvas.height = imagePreview.naturalHeight || imagePreview.height;
        gridOverlayCanvas.style.width = imagePreview.clientWidth + 'px';
        gridOverlayCanvas.style.height = imagePreview.clientHeight + 'px';
        drawGridOverlay(gridOverlayCanvas, gridX, gridZ, layout, crop);
    };
    if (imagePreview.complete) draw();
    else imagePreview.onload = draw;
}

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => showImage(ev.target.result);
    reader.readAsDataURL(file);
});

// ─── Click to Upload ────────────────────────────────────────

document.getElementById('uploadArea').addEventListener('click', () => {
    fileInput.click();
});

// Drag & drop
const uploadArea = document.getElementById('uploadArea');
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});
uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        fileInput.files = e.dataTransfer.files;
        const reader = new FileReader();
        reader.onload = (ev) => showImage(ev.target.result);
        reader.readAsDataURL(file);
    }
});

// ─── API Key (per-provider) ─────────────────────────────────

function currentProvider() {
    return MODELS[modelSelect.value]?.provider || '';
}

// Load saved key for initial provider
apiKeyInput.value = localStorage.getItem(`spp_apikey_${currentProvider()}`) || '';
apiKeyInput.addEventListener('change', () => {
    localStorage.setItem(`spp_apikey_${currentProvider()}`, apiKeyInput.value.trim());
});

// ─── Analyze ────────────────────────────────────────────────

analyzeBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        setStatus('Please enter an API key.', 'error');
        return;
    }
    localStorage.setItem(`spp_apikey_${currentProvider()}`, apiKey);
    const modelKey = modelSelect.value;

    const file = fileInput.files[0];
    if (!file) {
        setStatus('Please upload a floor plan image.', 'error');
        return;
    }

    analyzeBtn.disabled = true;
    editInfo.style.display = 'none';

    try {
        // Convert image once, reuse for both steps
        setStatus('Converting image...', 'loading');
        const imageDataUrl = await fileToBase64(file);

        // ── Step 1: Grid sizing ──
        const step1Text = await analyzeGridSize(apiKey, imageDataUrl, modelKey,
            (msg) => setStatus(msg, 'loading'));

        let gridInfo;
        try {
            const cleaned = step1Text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            gridInfo = JSON.parse(cleaned);
        } catch (e) {
            throw new Error(`Step 1 failed to parse grid info: ${e.message}\nRaw: ${step1Text.slice(0, 200)}`);
        }

        if (!gridInfo.gridX || !gridInfo.gridZ || !gridInfo.layout) {
            throw new Error(`Step 1 returned invalid grid info: ${JSON.stringify(gridInfo).slice(0, 200)}`);
        }

        setStatus(`Step 1 done: ${gridInfo.gridX}×${gridInfo.gridZ} grid detected. Starting face classification...`, 'loading');
        descriptionText.textContent = `Grid: ${gridInfo.layout.map(r => r.join(' | ')).join(' // ')}`;

        // ── Step 2: Face classification ──
        const step2Text = await classifyFaces(apiKey, imageDataUrl, modelKey, gridInfo,
            (msg) => setStatus(msg, 'loading'));

        const result = parseAIResponse(step2Text);

        // Show parsed JSON
        jsonOutput.textContent = JSON.stringify(result, null, 2);
        descriptionText.textContent = result.description || '';

        // Render
        renderResult(result);
        setStatus(`✓ Reconstructed ${result.cells.length} cells (${result.gridX}×${result.gridZ} grid) in 2 steps`, 'success');
        editInfo.style.display = 'block';
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, 'error');
    } finally {
        analyzeBtn.disabled = false;
    }
});

// ─── Render Result ──────────────────────────────────────────

function renderResult(result) {
    // Remove old
    if (currentGroup) {
        scene.remove(currentGroup);
        currentGroup = null;
    }

    currentCells = result.cells;
    const { sceneGroup, cellMap, center } = renderCells(result.cells);
    currentGroup = sceneGroup;
    currentCellMap = cellMap;
    currentAllKeys = new Set(cellMap.keys());

    // Entrance animation
    sceneGroup.scale.set(0.001, 0.001, 0.001);
    scene.add(sceneGroup);

    const duration = 600;
    const start = performance.now();
    function animateIn(now) {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        sceneGroup.scale.setScalar(ease);
        if (t < 1) requestAnimationFrame(animateIn);
    }
    requestAnimationFrame(animateIn);

    // Center camera
    controls.target.set(center.x, 0, center.z);
    const maxDim = Math.max(result.gridX, result.gridZ) * CELL_SIZE;
    camera.position.set(center.x + maxDim, maxDim * 1.2, center.z + maxDim);
    controls.update();
}

// ─── Click to Edit ──────────────────────────────────────────

canvas.addEventListener('click', (e) => {
    if (!currentGroup || !currentCellMap) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(currentGroup.children, true);

    for (const hit of intersects) {
        let obj = hit.object;
        // Walk up to find face info
        while (obj && obj.userData.faceIndex === undefined) {
            obj = obj.parent;
        }
        if (!obj || obj.userData.faceIndex === undefined) continue;

        // Find cell key
        let cellKey = obj.userData.cellKey;
        if (!cellKey) {
            let p = obj.parent;
            while (p && !p.userData.cellKey) p = p.parent;
            if (p) cellKey = p.userData.cellKey;
        }
        if (!cellKey) continue;

        const cell = currentCellMap.get(cellKey);
        if (!cell) continue;

        const fi = obj.userData.faceIndex;

        // Cycle the option
        cycleOption(cell, fi);
        const newId = cell.faceOptions[fi][0];
        const optName = OPTION_REGISTRY[newId]?.name || `ID ${newId}`;

        // Rebuild this cell's visuals
        rebuildCellWalls(currentGroup, currentCellMap, currentAllKeys, cellKey);

        // Update JSON display
        jsonOutput.textContent = JSON.stringify({
            gridX: currentCells.length,
            gridZ: currentCells.length,
            cells: currentCells,
        }, null, 2);

        setStatus(`Edited ${FACE_NAMES[fi]} → ${optName}`, 'success');
        break;
    }
});

// ─── Status ─────────────────────────────────────────────────

function setStatus(message, type = 'info') {
    statusText.textContent = message;
    statusText.className = `status-${type}`;
}

// ─── Export JSON ────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', () => {
    if (!currentCells) return;
    const data = JSON.stringify({ cells: currentCells }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spp-reconstruction.json';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Exported SPP JSON', 'success');
});

// ─── Boot ───────────────────────────────────────────────────

initScene();

// ─── Grid Density Controls ──────────────────────────────────

const gridDensityBar = document.getElementById('gridDensityBar');
const gridXDisplay = document.getElementById('gridXDisplay');
const gridZDisplay = document.getElementById('gridZDisplay');

let currentGridX = 0, currentGridZ = 0;
let currentLayout = null;
let currentCrop = null;

function updateGridDisplay() {
    gridXDisplay.textContent = currentGridX;
    gridZDisplay.textContent = currentGridZ;
}

document.getElementById('gridXPlus').addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentGridX < 16) { currentGridX++; updateGridDisplay(); showGridOnImage(currentGridX, currentGridZ, currentLayout, currentCrop); }
});
document.getElementById('gridXMinus').addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentGridX > 2) { currentGridX--; updateGridDisplay(); showGridOnImage(currentGridX, currentGridZ, currentLayout, currentCrop); }
});
document.getElementById('gridZPlus').addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentGridZ < 16) { currentGridZ++; updateGridDisplay(); showGridOnImage(currentGridX, currentGridZ, currentLayout, currentCrop); }
});
document.getElementById('gridZMinus').addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentGridZ > 2) { currentGridZ--; updateGridDisplay(); showGridOnImage(currentGridX, currentGridZ, currentLayout, currentCrop); }
});

function showDensityBar(gridX, gridZ, layout, crop) {
    currentGridX = gridX;
    currentGridZ = gridZ;
    currentLayout = layout;
    currentCrop = crop || null;
    updateGridDisplay();
    gridDensityBar.classList.add('visible');
}

// ─── Mock Data ──────────────────────────────────────────────

if (new URLSearchParams(location.search).has('mock')) {

    const K = 'Kitchen', H = 'Hallway', B = 'Bathroom', BR = 'Bedroom', LR = 'Living Room';
    const mockCrop = { x: 0.075, y: 0.112, w: 0.85, h: 0.81 };

    // AI Step 1: Base low-res layout
    const baseLayout = [
        [K, K, K, K, H, H, B, B, B, B, B],
        [K, K, K, K, H, H, B, B, B, B, B],
        [K, K, K, K, H, H, B, B, B, B, B],
        [K, K, K, K, H, H, BR, BR, BR, BR, BR], // Bath/BR boundary
        [LR, LR, LR, LR, H, H, BR, BR, BR, BR, BR], // Kitchen/LR boundary (base row 3/4)
        [LR, LR, LR, LR, H, H, BR, BR, BR, BR, BR],
        [LR, LR, LR, LR, H, H, BR, BR, BR, BR, BR],
        [LR, LR, LR, LR, H, H, BR, BR, BR, BR, BR],
        [LR, LR, LR, LR, H, H, BR, BR, BR, BR, BR],
    ];

    const baseDoors = [
        { x1: 3, z1: 2, x2: 4, z2: 2 },  // Kitchen ↔ Hallway
        { x1: 5, z1: 2, x2: 6, z2: 2 },  // Bathroom ↔ Hallway
        { x1: 3, z1: 6, x2: 4, z2: 6 },  // Living Room ↔ Hallway
        { x1: 5, z1: 6, x2: 6, z2: 6 },  // Bedroom ↔ Hallway
    ];

    // AI Step 3 (Iterative Refinement): Localized high-res overrides
    const cellModifications = [];

    // Kitchen/LR boundary optimization
    // Base row 3 (cols 0-3) is Kitchen, but the wall should be exactly at the bottom half
    // of the sub-cells. i.e., in fine grid, the bottom sub-cells of row 3 should be LR.
    for (let bx = 0; bx <= 3; bx++) {
        cellModifications.push({ basePos: [bx, 3], subPos: [0, 1], room: LR }); // left side of cell
        cellModifications.push({ basePos: [bx, 3], subPos: [1, 1], room: LR }); // right side of cell
    }

    // Bath/BR boundary optimization
    // Base row 2 (cols 6-10) is Bathroom, but the top half of those sub-cells should stay Bathroom,
    // and the bottom half should be Bedroom. Wait, earlier mock said: base row 2 bottom -> BR
    for (let bx = 6; bx <= 10; bx++) {
        cellModifications.push({ basePos: [bx, 2], subPos: [0, 1], room: BR });
        cellModifications.push({ basePos: [bx, 2], subPos: [1, 1], room: BR });
    }

    // Process via the Data Restructuring Layer
    const SCALE = 2;
    const { fineLayout, cells: fineCells, gridX: fineX, gridZ: fineZ } = optimizeGrid(baseLayout, SCALE, cellModifications, baseDoors);

    // Entrance doors (Hardcoded for mock top-level)
    for (const cell of fineCells) {
        const [x, , z] = cell.position;
        if (x >= 8 && x <= 11 && z <= 1) cell.faceOptions[4] = [2];
    }

    const mockStep1 = { crop: mockCrop, gridX: 11, gridZ: 9, layout: baseLayout };

    const mockResult = {
        gridX: fineX, gridZ: fineZ,
        layout: fineLayout,
        description: 'Fine 22×18 grid generated via optimizeGrid (scale=2), applying local room boundary corrections.',
        cells: fineCells,
    };

    // ── Top-down camera toggle ──
    let isTopDown = false;
    let savedCamPos = null, savedCamTarget = null;

    const topDownBtn = document.getElementById('topDownBtn');
    if (topDownBtn) {
        // ... (Listener remains mostly unchanged)
        topDownBtn.addEventListener('click', () => {
            isTopDown = !isTopDown;
            if (isTopDown) {
                savedCamPos = camera.position.clone();
                savedCamTarget = controls.target.clone();
                const cx = controls.target.x, cz = controls.target.z;
                camera.position.set(cx, 40, cz + 0.01);
                controls.target.set(cx, 0, cz);
                controls.maxPolarAngle = 0.01;
                controls.update();
                topDownBtn.textContent = '🔄 Perspective';
            } else {
                camera.position.copy(savedCamPos);
                controls.target.copy(savedCamTarget);
                controls.maxPolarAngle = Math.PI * 0.48;
                controls.update();
                topDownBtn.textContent = '⬇ Top View';
            }
        });
    }

    setTimeout(() => {
        showImage('assets/mock-floorplan.png');
        imagePreview.onload = () => showGridOnImage(mockStep1.gridX, mockStep1.gridZ, mockStep1.layout, mockCrop);
        showDensityBar(mockStep1.gridX, mockStep1.gridZ, mockStep1.layout, mockCrop);
        renderResult(mockResult);
        const fullOutput = { step1_gridSizing: mockStep1, step2_faceClassification: mockResult };
        jsonOutput.textContent = JSON.stringify(fullOutput, null, 2);
        descriptionText.textContent = mockResult.description;
        setStatus(`Mock (optimizeGrid): ${fineCells.length} cells in ${fineX}×${fineZ}`, 'success');
        editInfo.style.display = 'block';
        document.getElementById('exportBtn').disabled = false;
    }, 300);
}

setStatus('Upload a floor plan image to begin.');


