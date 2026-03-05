/**
 * renderer-3d.js — Renders ParticleCell data as 3D space
 * Supports multi-resolution cells (scale > 1 → sub-cells at S/n size)
 */

import * as THREE from 'three';
import { FACE, OPPOSITE_FACE, FACE_DIRECTION, OPTION_REGISTRY, OPTION_TYPE, getResolvedOption } from './particle.js';

const CELL_SIZE = 3;
const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.12;

// ─── Materials ──────────────────────────────────────────────

const edgeMat = new THREE.LineBasicMaterial({
    color: 0x444466,
    transparent: true,
    opacity: 0.35,
});

const floorMat = new THREE.MeshStandardMaterial({
    color: 0xe8e8ef,
    roughness: 0.85,
    metalness: 0.0,
});

const wallMat = new THREE.MeshStandardMaterial({
    color: 0xd4886b,
    roughness: 0.55,
    metalness: 0.05,
});

// Sub-cell floor uses a slightly different color for visual distinction
const subFloorMat = new THREE.MeshStandardMaterial({
    color: 0xdde0ef,
    roughness: 0.85,
    metalness: 0.0,
});

// ─── Wall Builder ───────────────────────────────────────────

function createWallMesh(optionId, size) {
    const opt = OPTION_REGISTRY[optionId];
    if (!opt || opt.type === OPTION_TYPE.OPEN) return null;
    const geo = new THREE.BoxGeometry(size, WALL_HEIGHT, WALL_THICKNESS);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.y = WALL_HEIGHT / 2;
    return mesh;
}

function positionWall(mesh, faceIndex, worldPos, half) {
    const [cx, cy, cz] = worldPos;
    const wrapper = new THREE.Group();
    wrapper.add(mesh);

    switch (faceIndex) {
        case FACE.POS_X: wrapper.position.set(cx + half, cy, cz); wrapper.rotation.y = Math.PI / 2; break;
        case FACE.NEG_X: wrapper.position.set(cx - half, cy, cz); wrapper.rotation.y = -Math.PI / 2; break;
        case FACE.POS_Z: wrapper.position.set(cx, cy, cz + half); wrapper.rotation.y = 0; break;
        case FACE.NEG_Z: wrapper.position.set(cx, cy, cz - half); wrapper.rotation.y = Math.PI; break;
    }

    wrapper.userData.faceIndex = faceIndex;
    wrapper.traverse(child => {
        if (child.isMesh) child.userData.faceIndex = faceIndex;
    });

    return wrapper;
}

// ─── Render Cell (single cell, given size) ──────────────────

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

function renderOneCell(cell, cellSize, allKeys, keyFn) {
    const pos = cell.position;
    const key = keyFn(pos);
    const half = cellSize / 2;

    const group = new THREE.Group();
    group.position.set(pos[0] * CELL_SIZE, 0, pos[2] * CELL_SIZE);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(cellSize * 0.96, cellSize * 0.96);
    const fMat = cell._parentScale ? subFloorMat : floorMat;
    const floor = new THREE.Mesh(floorGeo, fMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    group.add(floor);

    // Floor edges
    const floorEdgeGeo = new THREE.EdgesGeometry(floorGeo);
    const floorEdges = new THREE.LineSegments(floorEdgeGeo, edgeMat);
    floorEdges.rotation.x = -Math.PI / 2;
    floorEdges.position.y = 0.02;
    group.add(floorEdges);

    // Walls
    for (const fi of HORIZONTAL_FACES) {
        const optionId = getResolvedOption(cell, fi);
        if (optionId === null) continue;

        // Skip duplicate walls: only render for the "lower-index" side
        const [dx, , dz] = FACE_DIRECTION[fi];
        // For sub-cells, step is 1/n; for normal cells, step is 1
        const step = cell._parentScale ? (1 / cell._parentScale) : 1;
        const nx = pos[0] + dx * step;
        const nz = pos[2] + dz * step;
        const neighborKey = keyFn([nx, 0, nz]);
        if (allKeys.has(neighborKey) && fi > OPPOSITE_FACE[fi]) continue;

        const mesh = createWallMesh(optionId, cellSize);
        if (mesh) {
            const wall = positionWall(mesh, fi, [0, 0, 0], half);
            wall.userData.cellKey = key;
            wall.userData.faceIndex = fi;
            group.add(wall);
        }
    }

    group.userData.cellKey = key;
    return { group, key };
}

// ─── Render All Cells ───────────────────────────────────────

/**
 * Render a complete scene from ParticleCell array.
 * Supports mixed-size cells (normal + sub-cells from expandScaledCells).
 */
export function renderCells(cells) {
    const sceneGroup = new THREE.Group();
    const cellMap = new Map();
    const allKeys = new Set();

    // Key function using fractional positions (sub-cells have fractional x,z)
    const keyFn = (pos) => `${pos[0].toFixed(4)},${pos[2].toFixed(4)}`;

    // Register all cell positions
    for (const cell of cells) {
        allKeys.add(keyFn(cell.position));
    }

    // Calculate center
    let sumX = 0, sumZ = 0;
    for (const cell of cells) {
        sumX += cell.position[0];
        sumZ += cell.position[2];
    }
    const center = {
        x: (sumX / cells.length) * CELL_SIZE,
        z: (sumZ / cells.length) * CELL_SIZE,
    };

    // Render each cell at appropriate size
    for (const cell of cells) {
        const n = cell._parentScale || 1;
        const cellSize = CELL_SIZE / n;

        cellMap.set(keyFn(cell.position), cell);

        const { group, key } = renderOneCell(cell, cellSize, allKeys, keyFn);
        sceneGroup.add(group);
    }

    return { sceneGroup, cellMap, center };
}

/**
 * Rebuild a single cell's walls (after editing)
 */
export function rebuildCellWalls(sceneGroup, cellMap, allKeys, cellKey) {
    const cell = cellMap.get(cellKey);
    if (!cell) return;

    const keyFn = (pos) => `${pos[0].toFixed(4)},${pos[2].toFixed(4)}`;

    // Remove old group
    for (let i = sceneGroup.children.length - 1; i >= 0; i--) {
        const child = sceneGroup.children[i];
        if (child.userData.cellKey === cellKey) {
            sceneGroup.remove(child);
            break;
        }
    }

    const n = cell._parentScale || 1;
    const cellSize = CELL_SIZE / n;
    const { group } = renderOneCell(cell, cellSize, allKeys, keyFn);
    sceneGroup.add(group);
}

export { CELL_SIZE, WALL_HEIGHT };
