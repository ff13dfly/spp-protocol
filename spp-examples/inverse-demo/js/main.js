/**
 * main.js — Inverse Modeling Demo
 * Upload a floor plan → AI analyzes → 3D rendering
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeGridSize, classifyFaces, MODELS, DEFAULT_MODEL, callModel } from './prompt.js';
import { parseAIResponse } from './parser.js';
import { renderCells, rebuildCellWalls, CELL_SIZE } from './renderer-3d.js';
import { FACE_NAMES, OPTION_REGISTRY, ALL_IDS, cycleOption, getResolvedOption, expandScaledCells, optimizeGrid, generateCellsFromLayout } from './particle.js';
import { drawGridOverlay } from './grid-overlay.js';
import { RecursiveGridManager } from './recursive-core.js';

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
let selectedCellKey = null;
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
const refineBtn = document.getElementById('refineBtn');

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
        setStatus(`✓ Reconstructed ${result.cells.length} cells (${result.gridX}×${result.gridZ} grid) - 5-Phase architecture aligned`, 'success');
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
    
    // Flatten recursive structure for rendering
    const leafCells = RecursiveGridManager.flattenRecursiveCells(currentCells);
    const { sceneGroup, cellMap, center } = renderCells(leafCells);
    
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

        selectedCellKey = cellKey;
        refineBtn.style.display = 'inline-block';

        const fi = obj.userData.faceIndex;

        // Cycle the option
        cycleOption(cell, fi);
        const newId = cell.faceOptions[fi][0];
        const optName = OPTION_REGISTRY[newId]?.name || `ID ${newId}`;

        // Rebuild this cell's visuals
        rebuildCellWalls(currentGroup, currentCellMap, currentAllKeys, cellKey);

        // Update JSON display
        jsonOutput.textContent = JSON.stringify({
            gridX: currentGridX || currentCells.length,
            gridZ: currentGridZ || currentCells.length,
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

// ─── Refine Selected Cell ───────────────────────────────────

refineBtn.addEventListener('click', async () => {
    if (!selectedCellKey || !apiKeyInput.value) return;
    const cell = currentCellMap.get(selectedCellKey);
    if (!cell) return;

    refineBtn.disabled = true;
    refineBtn.textContent = '⌛ Refining...';

    try {
        const apiKey = apiKeyInput.value.trim();
        const modelKey = modelSelect.value;
        const imageDataUrl = await fileToBase64(fileInput.files[0]);

        // Get context for AI
        const context = RecursiveGridManager.createSubGridPromptContext(cell, 4);
        setStatus(`Refining ${context.roomType} into 4x4 sub-grid...`, 'loading');

        // Call AI for sub-grid classification
        const modelDef = MODELS[modelKey];
        const subGridPrompt = `You are a spatial detail analyzer. Refine this local region: ${context.roomType}.
Resolution: ${context.resolution}
Boundary Constraints: ${JSON.stringify(context.boundaryConstraints)}
Rules:
1. Divide the space into ${context.resolution} grid.
2. Maintain the internal topology.
3. Use 0 for open and 10 for wall.
Return ONLY JSON:
{ "gridX": 4, "gridZ": 4, "cells": [...] }`;

        const responseText = await callModel(apiKey, imageDataUrl, subGridPrompt, "Generate the sub-grid JSON.", modelDef);
        const subGridData = parseAIResponse(responseText);

        // Integrate back into recursive structure
        RecursiveGridManager.integrateSubGrid(cell, subGridData);

        // Re-render
        renderResult({
            cells: currentCells,
            gridX: currentGridX,
            gridZ: currentGridZ,
            description: `Refined ${context.roomType} sub-grid.`
        });

        setStatus(`✓ ${context.roomType} refined!`, 'success');
    } catch (err) {
        console.error(err);
        setStatus(`Refinement failed: ${err.message}`, 'error');
    } finally {
        refineBtn.disabled = false;
        refineBtn.textContent = '🔍 Refine Selected Cell';
    }
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
// Simulates the full Phase 1–4 reconstruction pipeline output
// for a standard 两室一厅 (2BR + living) apartment floor plan.
//
// Layout (6×5):
//   z=0: Kitchen  Kitchen  Hallway   Hallway   Bedroom   Bedroom
//   z=1: Kitchen  Kitchen  Hallway   Hallway   Bedroom   Bedroom
//   z=2: LivRoom  LivRoom  LivRoom   Hallway   Bathroom  Bathroom
//   z=3: LivRoom  LivRoom  LivRoom   Hallway   MasterBed MasterBed
//   z=4: LivRoom  LivRoom  LivRoom   Hallway   MasterBed MasterBed

if (new URLSearchParams(location.search).has('mock')) {

    // ── Phase 1 output ──────────────────────────────────────
    const K = 'Kitchen', H = 'Hallway', BD = 'Bedroom';
    const LR = 'Living Room', BA = 'Bathroom', MB = 'Master Bedroom';

    const mockLayout = [
        [K,  K,  H,  H,  BD, BD],
        [K,  K,  H,  H,  BD, BD],
        [LR, LR, LR, H,  BA, BA],
        [LR, LR, LR, H,  MB, MB],
        [LR, LR, LR, H,  MB, MB],
    ];
    const mockCrop = { x: 0.06, y: 0.08, w: 0.88, h: 0.88 };
    const GRID_X = 6, GRID_Z = 5;

    // ── Phase 2: binary topology helper ─────────────────────
    // faceOptions indices: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z
    function roomAt(x, z) {
        return mockLayout[z]?.[x] ?? null;
    }
    function binaryFace(x, z, nx, nz) {
        const r = roomAt(x, z), n = roomAt(nx, nz);
        if (n === null) return [10];   // exterior wall
        if (r === n)   return [0];    // same room → open
        return [10];                   // different room → wall
    }

    // ── Phase 3 door/window annotations ─────────────────────
    // Doors: each entry annotates both sides of the passage
    // Windows: exterior faces of rooms that typically have glazing
    const annotations = [
        // Kitchen ↔ Hallway door (z=1 row boundary)
        { x: 1, z: 1, face: 0, optionId: 2 }, { x: 2, z: 1, face: 1, optionId: 2 },
        // Bedroom ↔ Hallway door
        { x: 3, z: 1, face: 0, optionId: 2 }, { x: 4, z: 1, face: 1, optionId: 2 },
        // Bathroom ↔ Hallway door
        { x: 3, z: 2, face: 0, optionId: 2 }, { x: 4, z: 2, face: 1, optionId: 2 },
        // Living Room ↔ Hallway door
        { x: 2, z: 3, face: 0, optionId: 2 }, { x: 3, z: 3, face: 1, optionId: 2 },
        // Master Bedroom ↔ Hallway door
        { x: 3, z: 3, face: 0, optionId: 2 }, { x: 4, z: 3, face: 1, optionId: 2 },
        // Windows — Kitchen left exterior
        { x: 0, z: 0, face: 1, optionId: 20 },
        // Windows — Bedroom top exterior
        { x: 4, z: 0, face: 5, optionId: 20 }, { x: 5, z: 0, face: 5, optionId: 20 },
        // Windows — Living Room left exterior
        { x: 0, z: 2, face: 1, optionId: 20 }, { x: 0, z: 3, face: 1, optionId: 20 },
        // Windows — Living Room bottom exterior
        { x: 1, z: 4, face: 4, optionId: 20 }, { x: 2, z: 4, face: 4, optionId: 20 },
        // Windows — Master Bedroom right exterior
        { x: 5, z: 3, face: 0, optionId: 20 },
        // Windows — Master Bedroom bottom-right corner
        { x: 4, z: 4, face: 4, optionId: 20 }, { x: 5, z: 4, face: 0, optionId: 20 }, { x: 5, z: 4, face: 4, optionId: 20 },
    ];

    // ── Build cells (Phase 2 topology + Phase 4 piercing) ───
    const annMap = new Map();
    for (const a of annotations) annMap.set(`${a.x},${a.z},${a.face}`, a.optionId);

    function faceOption(x, z, face) {
        const key = `${x},${z},${face}`;
        if (annMap.has(key)) return [annMap.get(key)];
        const [dx, dz] = [[1,0],[-1,0],[0,0],[0,0],[0,1],[0,-1]][face];
        return binaryFace(x, z, x + dx, z + dz);
    }

    const mockCells = [];
    for (let z = 0; z < GRID_Z; z++) {
        for (let x = 0; x < GRID_X; x++) {
            const room = roomAt(x, z);
            if (!room) continue;
            mockCells.push({
                position:    [x, 0, z],
                size:        [1, 1, 1],
                faceStates:  0b111111,
                room,
                faceOptions: [
                    faceOption(x, z, 0),  // +X
                    faceOption(x, z, 1),  // -X
                    [],                    // +Y
                    [],                    // -Y
                    faceOption(x, z, 4),  // +Z
                    faceOption(x, z, 5),  // -Z
                ],
            });
        }
    }

    const mockResult = {
        gridX: GRID_X,
        gridZ: GRID_Z,
        description: '两室一厅 — Phase 1–4 mock reconstruction: 6×5 grid, binary topology, doors & windows pierced.',
        cells: mockCells,
    };

    // ── Top-down camera toggle ───────────────────────────────
    let isTopDown = false;
    let savedCamPos = null, savedCamTarget = null;
    const topDownBtn = document.getElementById('topDownBtn');
    if (topDownBtn) {
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

    // ── Boot mock ────────────────────────────────────────────
    setTimeout(() => {
        showImage('assets/mock-floorplan.png');
        imagePreview.onload = () => showGridOnImage(GRID_X, GRID_Z, mockLayout, mockCrop);
        showDensityBar(GRID_X, GRID_Z, mockLayout, mockCrop);
        renderResult(mockResult);
        jsonOutput.textContent = JSON.stringify({
            phase1: { crop: mockCrop, gridX: GRID_X, gridZ: GRID_Z, layout: mockLayout },
            phase4_cells: mockResult,
        }, null, 2);
        descriptionText.textContent = mockResult.description;
        setStatus(`Mock: ${mockCells.length} cells (${GRID_X}×${GRID_Z}) — Phase 1–4 pipeline`, 'success');
        editInfo.style.display = 'block';
        document.getElementById('exportBtn').disabled = false;
    }, 300);
}

setStatus('Upload a floor plan image to begin.');


