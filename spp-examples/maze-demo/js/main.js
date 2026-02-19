/**
 * main.js — App entry point, scene setup, state machine
 *
 * States:
 *   SINGLE_PARTICLE → EXPANDING → MAZE → COLLAPSING → SINGLE_PARTICLE
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCell, ALL_IDS } from './particle.js';
import { generateMaze } from './maze-generator.js';
import {
    renderSuperpositionParticle,
    renderChunk,
    CELL_SIZE,
} from './renderer-3d.js';
import {
    updateFaceCycling,
    createExpandAnimation,
    createCollapseAnimation,
} from './animations.js';

// ─── State ──────────────────────────────────────────────────

const State = {
    SINGLE_PARTICLE: 'SINGLE_PARTICLE',
    EXPANDING: 'EXPANDING',
    MAZE: 'MAZE',
    COLLAPSING: 'COLLAPSING',
};

let currentState = State.SINGLE_PARTICLE;
let activeAnimation = null;

// ─── Scene Setup ────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog = new THREE.FogExp2(0x0a0a0f, 0.012);

const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    500
);
camera.position.set(6, 8, 6);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 3;
controls.maxDistance = 120;
controls.maxPolarAngle = Math.PI * 0.85;
controls.target.set(0, 1, 0);

// ─── Lighting ───────────────────────────────────────────────

const ambientLight = new THREE.AmbientLight(0x8899bb, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
dirLight.position.set(10, 15, 8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x6688cc, 0.4);
fillLight.position.set(-8, 5, -6);
scene.add(fillLight);

// Ground plane (subtle grid)
const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshStandardMaterial({
    color: 0x111118,
    roughness: 0.95,
    metalness: 0.0,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
scene.add(ground);

// ─── Particle / Maze Groups ────────────────────────────────

let particleGroup = null;
let particleFaceGroups = null;
let mazeGroup = null;

// Overlay text
const overlay = document.getElementById('overlay');

function setOverlay(text) {
    overlay.textContent = text;
}

// ─── Create Single Particle ────────────────────────────────

function showSingleParticle() {
    // Remove old
    if (particleGroup) { scene.remove(particleGroup); particleGroup = null; }
    if (mazeGroup) { scene.remove(mazeGroup); mazeGroup = null; }

    const cell = createCell(0, 0, 0);
    // All horizontal faces get all options for cycling display
    cell.faceOptions[0] = [...ALL_IDS];
    cell.faceOptions[1] = [...ALL_IDS];
    cell.faceOptions[4] = [...ALL_IDS];
    cell.faceOptions[5] = [...ALL_IDS];

    const result = renderSuperpositionParticle(cell);
    particleGroup = result.group;
    particleFaceGroups = result.faceGroups;
    scene.add(particleGroup);

    // Reset camera for single particle view
    smoothCameraTo(new THREE.Vector3(5, 5, 5), new THREE.Vector3(0, 1, 0));

    currentState = State.SINGLE_PARTICLE;
    setOverlay('Double-click to expand into maze');
}

// ─── Expand Into Maze ──────────────────────────────────────

function expandToMaze() {
    if (currentState !== State.SINGLE_PARTICLE) return;
    currentState = State.EXPANDING;
    setOverlay('Expanding...');

    // Remove single particle
    if (particleGroup) { scene.remove(particleGroup); particleGroup = null; }
    particleFaceGroups = null;

    // Generate maze
    const targetSize = 30 + Math.floor(Math.random() * 21); // 30-50
    const { collapsedChunk } = generateMaze(targetSize);

    // Render maze
    mazeGroup = renderChunk(collapsedChunk);
    scene.add(mazeGroup);

    // Calculate maze center for camera
    const center = getMazeCenter(collapsedChunk);

    // Start expand animation
    activeAnimation = createExpandAnimation(mazeGroup, 1.8);

    // Move camera to see the whole maze
    const dist = Math.max(targetSize * 0.6, 20);
    smoothCameraTo(
        new THREE.Vector3(center.x + dist * 0.7, dist * 0.5, center.z + dist * 0.7),
        center
    );
}

function getMazeCenter(chunk) {
    let cx = 0, cz = 0;
    for (const cell of chunk.cells) {
        cx += cell.position[0];
        cz += cell.position[2];
    }
    const n = chunk.cells.length;
    return new THREE.Vector3(
        (cx / n) * CELL_SIZE,
        1,
        (cz / n) * CELL_SIZE
    );
}

// ─── Collapse Back ─────────────────────────────────────────

function collapseBack() {
    if (currentState !== State.MAZE) return;
    currentState = State.COLLAPSING;
    setOverlay('Collapsing...');

    activeAnimation = createCollapseAnimation(mazeGroup, 1.2);
}

// ─── Camera Smooth Transition ──────────────────────────────

let cameraTarget = null;
let cameraLookTarget = null;

function smoothCameraTo(pos, lookAt) {
    cameraTarget = pos.clone();
    cameraLookTarget = lookAt.clone();
}

function updateCamera(dt) {
    if (cameraTarget) {
        camera.position.lerp(cameraTarget, 0.03);
        if (camera.position.distanceTo(cameraTarget) < 0.05) {
            camera.position.copy(cameraTarget);
            cameraTarget = null;
        }
    }
    if (cameraLookTarget) {
        controls.target.lerp(cameraLookTarget, 0.03);
        if (controls.target.distanceTo(cameraLookTarget) < 0.05) {
            controls.target.copy(cameraLookTarget);
            cameraLookTarget = null;
        }
    }
}

// ─── Double-Click Handler ──────────────────────────────────

let lastClick = 0;
function onDoubleClick(e) {
    e.preventDefault();
    const now = Date.now();
    if (now - lastClick < 350) {
        handleAction();
    }
    lastClick = now;
}

function handleAction() {
    switch (currentState) {
        case State.SINGLE_PARTICLE:
            expandToMaze();
            break;
        case State.MAZE:
            collapseBack();
            break;
    }
}

renderer.domElement.addEventListener('click', onDoubleClick);
renderer.domElement.addEventListener('touchend', (e) => {
    onDoubleClick(e);
});

// Prevent default double-tap zoom on mobile
renderer.domElement.addEventListener('dblclick', (e) => e.preventDefault());

// ─── Resize ────────────────────────────────────────────────

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

    // Update state-specific logic
    switch (currentState) {
        case State.SINGLE_PARTICLE:
            if (particleFaceGroups) {
                updateFaceCycling(particleFaceGroups, time);
            }
            break;

        case State.EXPANDING:
            if (activeAnimation) {
                const done = activeAnimation.update(dt);
                if (done) {
                    currentState = State.MAZE;
                    activeAnimation = null;
                    setOverlay('Double-click to collapse back');
                }
            }
            break;

        case State.COLLAPSING:
            if (activeAnimation) {
                const done = activeAnimation.update(dt);
                if (done) {
                    activeAnimation = null;
                    showSingleParticle();
                }
            }
            break;

        case State.MAZE:
            break;
    }

    updateCamera(dt);
    controls.update();
    renderer.render(scene, camera);
}

// ─── Init ──────────────────────────────────────────────────

showSingleParticle();
animate();
