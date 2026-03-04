/**
 * main.js — Inverse Modeling Demo
 * Upload a floor plan → AI analyzes → 3D rendering
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeFloorPlan, MODELS, DEFAULT_MODEL } from './prompt.js';
import { parseAIResponse } from './parser.js';
import { renderCells, rebuildCellWalls, CELL_SIZE } from './renderer-3d.js';
import { FACE_NAMES, OPTION_REGISTRY, ALL_IDS, cycleOption, getResolvedOption } from './particle.js';

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

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        imagePreview.src = ev.target.result;
        imagePreview.style.display = 'block';
        document.getElementById('uploadPlaceholder').style.display = 'none';
        analyzeBtn.disabled = false;
    };
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
        reader.onload = (ev) => {
            imagePreview.src = ev.target.result;
            imagePreview.style.display = 'block';
            document.getElementById('uploadPlaceholder').style.display = 'none';
            analyzeBtn.disabled = false;
        };
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
        const rawText = await analyzeFloorPlan(apiKey, file, modelKey, (msg) => setStatus(msg, 'loading'));
        const result = parseAIResponse(rawText);

        // Show parsed JSON
        jsonOutput.textContent = JSON.stringify(result, null, 2);
        descriptionText.textContent = result.description || '';

        // Render
        renderResult(result);
        setStatus(`Reconstructed ${result.cells.length} cells (${result.gridX}×${result.gridZ} grid)`, 'success');
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

// Mock data for testing: ?mock=1 in URL
if (new URLSearchParams(location.search).has('mock')) {
    // Matches generated floor plan:
    //   Kitchen   | Hallway(entrance) | Bathroom
    //   Living Rm | Hallway           | Bedroom
    const mockResult = {
        gridX: 3,
        gridZ: 2,
        description: 'Apartment: Kitchen(top-left), Bathroom(top-right), Living Room(bottom-left), Bedroom(bottom-right), Central Hallway with Entrance',
        cells: [
            // Row z=0 (top): Kitchen, Hallway+Entrance, Bathroom
            { position: [0, 0, 0], faceOptions: [[2], [20], [], [], [20], [10]] },   // Kitchen: door→hall(+X), window(-X,+Z exterior)
            { position: [1, 0, 0], faceOptions: [[2], [2], [], [], [2], [0]] },    // Hallway top: doors to kitchen(-X), bathroom(+X), entrance(+Z), open→hall below(-Z)
            { position: [2, 0, 0], faceOptions: [[10], [2], [], [], [20], [10]] },   // Bathroom: wall(+X exterior), door→hall(-X), window(+Z), wall(-Z)

            // Row z=1 (bottom): Living Room, Hallway, Bedroom
            { position: [0, 0, 1], faceOptions: [[2], [20], [], [], [10], [20]] },   // Living Room: door→hall(+X), windows(-X,-Z exterior), wall(+Z)
            { position: [1, 0, 1], faceOptions: [[2], [2], [], [], [0], [10]] },   // Hallway bottom: doors to living(-X) & bedroom(+X), open→hall above(+Z), wall(-Z)
            { position: [2, 0, 1], faceOptions: [[20], [2], [], [], [10], [20]] },   // Bedroom: window(+X,-Z exterior), door→hall(-X), wall(+Z)
        ],
    };
    setTimeout(() => {
        // Show mock floor plan in preview
        imagePreview.src = 'assets/mock-floorplan.png';
        imagePreview.style.display = 'block';
        document.getElementById('uploadPlaceholder').style.display = 'none';

        renderResult(mockResult);
        jsonOutput.textContent = JSON.stringify(mockResult, null, 2);
        descriptionText.textContent = mockResult.description;
        setStatus(`Mock: ${mockResult.cells.length} cells (${mockResult.gridX}×${mockResult.gridZ})`, 'success');
        editInfo.style.display = 'block';
        document.getElementById('exportBtn').disabled = false;
    }, 300);
}

setStatus('Upload a floor plan image to begin.');
