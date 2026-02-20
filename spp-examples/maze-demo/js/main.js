/**
 * main.js — State machine with dynamic parameter controls
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createCell } from './particle.js';
import { generateCascade } from './maze-generator.js';
import {
    renderSuperpositionParticle,
    buildGhostGrid,
    buildResolvedCell,
    CELL_SIZE,
} from './renderer-3d.js';
import {
    updateFaceCycling,
    createGridAppearAnimation,
    createCascadeAnimation,
    createCollapseBackAnimation,
} from './animations.js';

import { findPath } from './maze-generator.js';
import { renderPath, clearPath } from './renderer-3d.js';

// ─── State ──────────────────────────────────────────────────

const State = {
    PARTICLE: 'PARTICLE',
    GRID_APPEAR: 'GRID_APPEAR',
    CASCADING: 'CASCADING',
    SPACE: 'SPACE',
    COLLAPSING: 'COLLAPSING',
};

let currentState = State.PARTICLE;
let activeAnimation = null;

// ─── Scene Objects ──────────────────────────────────────────

let particleGroup = null;
let particleFaceGroups = null;
let gridGroup = null;
let ghostMap = null;
let resolvedGroups = [];
let cascadeData = null;

// ─── Scene Setup ────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f5f7);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(10, 10, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 150;
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI * 0.48;

// ─── Lighting ───────────────────────────────────────────────

scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(20, 35, 20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 100;
dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

scene.add(new THREE.DirectionalLight(0xaabbdd, 0.4).translateX(-15).translateY(15).translateZ(-10));

const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xececf0, roughness: 0.95 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

const gridHelper = new THREE.GridHelper(60, 60, 0xd5d5dd, 0xe5e5eb);
gridHelper.position.y = 0.005;
scene.add(gridHelper);

// ─── UI Controls ────────────────────────────────────────────

const overlay = document.getElementById('overlay');
const cellCountEl = document.getElementById('cell-count');

const ctrlX = document.getElementById('ctrl-x');
const ctrlZ = document.getElementById('ctrl-z');
const ctrlCells = document.getElementById('ctrl-cells');
const valX = document.getElementById('val-x');
const valZ = document.getElementById('val-z');
const valCells = document.getElementById('val-cells');

function getParams() {
    return {
        gridX: parseInt(ctrlX.value),
        gridZ: parseInt(ctrlZ.value),
        targetCells: parseInt(ctrlCells.value),
    };
}

// Sync slider displays
ctrlX.addEventListener('input', () => { valX.textContent = ctrlX.value; });
ctrlZ.addEventListener('input', () => { valZ.textContent = ctrlZ.value; });
ctrlCells.addEventListener('input', () => { valCells.textContent = ctrlCells.value; });

// Clamp cells to grid capacity
function clampCells() {
    const maxCells = parseInt(ctrlX.value) * parseInt(ctrlZ.value);
    ctrlCells.max = maxCells;
    if (parseInt(ctrlCells.value) > maxCells) {
        ctrlCells.value = maxCells;
        valCells.textContent = maxCells;
    }
}
ctrlX.addEventListener('input', clampCells);
ctrlZ.addEventListener('input', clampCells);

// Particle selector
const particleOptions = document.querySelectorAll('.particle-option');
let selectedParticle = 'medieval';

particleOptions.forEach(opt => {
    opt.addEventListener('click', () => {
        particleOptions.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        selectedParticle = opt.dataset.particle;
    });
});

function setOverlay(text) { overlay.textContent = text; }
function setCellCount(n) { cellCountEl.textContent = n > 0 ? `${n} cells` : ''; }

// ─── State: PARTICLE ───────────────────────────────────────

function showParticle() {
    cleanup();
    const cell = createCell(0, 0, 0);
    const result = renderSuperpositionParticle(cell);
    particleGroup = result.group;
    particleFaceGroups = result.faceGroups;
    scene.add(particleGroup);

    smoothCameraTo(new THREE.Vector3(7, 7, 7), new THREE.Vector3(0, 1, 0));
    currentState = State.PARTICLE;
    setOverlay('Double-click to expand');
    setCellCount(0);
}

// ─── State: GRID_APPEAR → CASCADING ────────────────────────

function startExpansion() {
    if (currentState !== State.PARTICLE) return;
    currentState = State.GRID_APPEAR;
    setOverlay('');

    const { gridX, gridZ, targetCells } = getParams();
    cascadeData = generateCascade(gridX, gridZ, targetCells);
    const { gridCells, halfX, halfZ } = cascadeData;
    const centerKey = '0,0';

    const result = buildGhostGrid(gridCells, centerKey);
    gridGroup = result.gridGroup;
    ghostMap = result.ghostMap;
    scene.add(gridGroup);

    activeAnimation = createGridAppearAnimation(ghostMap, 0.5);

    const extentX = halfX * CELL_SIZE;
    const extentZ = halfZ * CELL_SIZE;
    const extent = Math.max(extentX, extentZ);

    // Zoom out more for narrow mobile screens
    const isMobile = window.innerWidth < 600;
    const zoomFactor = isMobile ? 2.5 : 1.4;
    const yFactor = isMobile ? 3.0 : 1.6;

    smoothCameraTo(
        new THREE.Vector3(extent * zoomFactor, extent * yFactor, extent * zoomFactor),
        new THREE.Vector3(0, 0, 0)
    );
    clearPath(scene);
}

function startCascade() {
    currentState = State.CASCADING;
    setOverlay('');

    const { collapseOrder, collapsedCells } = cascadeData;
    const allCollapsedKeys = new Set(collapsedCells.keys());

    const animOrder = [];
    resolvedGroups = [];

    for (const { key } of collapseOrder) {
        const cell = collapsedCells.get(key);
        if (!cell) continue;
        const resolvedGroup = buildResolvedCell(cell, allCollapsedKeys);
        scene.add(resolvedGroup);
        resolvedGroups.push(resolvedGroup);
        animOrder.push({
            key,
            resolvedGroup,
            ghostGroup: ghostMap ? ghostMap.get(key) : null,
        });
    }

    if (particleGroup) {
        scene.remove(particleGroup);
        particleGroup = null;
        particleFaceGroups = null;
    }

    setCellCount(collapseOrder.length);
    activeAnimation = createCascadeAnimation(animOrder, 0.3, 0.08);
}

// ─── State: COLLAPSING ─────────────────────────────────────

function startCollapse() {
    if (currentState !== State.SPACE) return;
    currentState = State.COLLAPSING;
    setOverlay('');
    clearPath(scene);
    activeAnimation = createCollapseBackAnimation(resolvedGroups, ghostMap, 1.5);
}

// ─── Cleanup ────────────────────────────────────────────────

function cleanup() {
    if (particleGroup) { scene.remove(particleGroup); particleGroup = null; }
    if (gridGroup) { scene.remove(gridGroup); gridGroup = null; }
    for (const rg of resolvedGroups) scene.remove(rg);
    resolvedGroups = [];
    ghostMap = null;
    cascadeData = null;
    particleFaceGroups = null;
    activeAnimation = null;
}

// ─── Camera ────────────────────────────────────────────────

let cameraTarget = null;
let cameraLookTarget = null;

function smoothCameraTo(pos, lookAt) {
    cameraTarget = pos.clone();
    cameraLookTarget = lookAt.clone();
}

function updateCamera() {
    if (cameraTarget) {
        camera.position.lerp(cameraTarget, 0.04);
        if (camera.position.distanceTo(cameraTarget) < 0.05) cameraTarget = null;
    }
    if (cameraLookTarget) {
        controls.target.lerp(cameraLookTarget, 0.04);
        if (controls.target.distanceTo(cameraLookTarget) < 0.05) cameraLookTarget = null;
    }
}

// ─── Input ──────────────────────────────────────────────────

let lastClickTime = 0;
let clickTimer = null;

function onAction(e) {
    // Don't trigger on control panel interactions
    if (e.target.closest('#controls')) return;

    // Prevent "ghost clicks" on mobile: if this is a touch event, stop default behavior
    if (e.type === 'touchend') {
        e.preventDefault();
    }

    const now = Date.now();
    const delta = now - lastClickTime;
    lastClickTime = now;

    if (delta < 300) {
        // Double Tap / Double Click Detected
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
        }

        if (currentState === State.PARTICLE) startExpansion();
        else if (currentState === State.SPACE) startCollapse();

    } else {
        // Potential Single Tap / Single Click
        // Wait a bit to see if it becomes a double tap
        if (clickTimer) clearTimeout(clickTimer);

        clickTimer = setTimeout(() => {
            if (currentState === State.SPACE) {
                handleNavigation(e);
            }
            clickTimer = null;
        }, 250); // 250ms threshold to distinguish single/double tap
    }
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function handleNavigation(e) {
    let clientX, clientY;

    // Support for both mouse and touch coordinates
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(resolvedGroups, true);

    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj && !obj.userData.gridPos) {
            obj = obj.parent;
        }

        if (obj && obj.userData.gridPos) {
            const [tx, tz] = obj.userData.gridPos;
            const targetKey = `${tx},${tz}`;
            const path = findPath(cascadeData.collapsedCells, '0,0', targetKey);
            if (path) {
                renderPath(scene, path, cascadeData.collapsedCells);
                setOverlay(`Path to [${tx}, ${tz}]: ${path.length - 1} steps`);
            }
        }
    }
}

// Consolidate listeners: touchstart/touchend can conflict with click. 
// Using touchend + preventDefault is safest for mobile.
renderer.domElement.addEventListener('click', onAction);
renderer.domElement.addEventListener('touchend', onAction, { passive: false });

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation Loop ────────────────────────────────────────

const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const time = clock.getElapsedTime();

    switch (currentState) {
        case State.PARTICLE:
            if (particleFaceGroups) updateFaceCycling(particleFaceGroups, time);
            break;
        case State.GRID_APPEAR:
            if (activeAnimation && activeAnimation.update(dt)) startCascade();
            break;
        case State.CASCADING:
            if (activeAnimation && activeAnimation.update(dt)) {
                currentState = State.SPACE;
                activeAnimation = null;
                setOverlay('Double-click to collapse back');
            }
            break;
        case State.COLLAPSING:
            if (activeAnimation && activeAnimation.update(dt)) showParticle();
            break;
    }

    updateCamera();
    controls.update();
    renderer.render(scene, camera);
}

showParticle();
animate();
