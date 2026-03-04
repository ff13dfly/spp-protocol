/**
 * renderer-3d.js — Renders ParticleCell data as 3D space
 * Adapted from maze-demo, generalized for arbitrary cell layouts.
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

const wallMaterials = {
    10: new THREE.MeshStandardMaterial({ color: 0xd4886b, roughness: 0.55, metalness: 0.05 }),
    11: new THREE.MeshStandardMaterial({ color: 0xc8b48a, roughness: 0.65, metalness: 0.0 }),
    12: new THREE.MeshStandardMaterial({ color: 0xccccd5, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.7 }),
    13: new THREE.MeshStandardMaterial({ color: 0x6aad5e, roughness: 0.7, metalness: 0.0 }),
    1: new THREE.MeshStandardMaterial({ color: 0x9988bb, roughness: 0.4, metalness: 0.1 }),
    2: new THREE.MeshStandardMaterial({ color: 0x7799bb, roughness: 0.4, metalness: 0.1 }),
    20: new THREE.MeshStandardMaterial({ color: 0x88bbdd, roughness: 0.3, metalness: 0.15, transparent: true, opacity: 0.55 }),
};

// ─── Wall Builders ──────────────────────────────────────────

function buildSolidWall(height) {
    return new THREE.BoxGeometry(CELL_SIZE, height, WALL_THICKNESS);
}

function buildArchWall() {
    const halfCell = CELL_SIZE / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-halfCell, 0);
    shape.lineTo(-halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, 0);

    const archW = 0.8, archH = 2.1;
    const hole = new THREE.Path();
    hole.moveTo(archW, 0);
    hole.lineTo(archW, archH * 0.7);
    hole.quadraticCurveTo(archW, archH, 0, archH);
    hole.quadraticCurveTo(-archW, archH, -archW, archH * 0.7);
    hole.lineTo(-archW, 0);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry(shape, { depth: WALL_THICKNESS, bevelEnabled: false });
}

function buildRectDoorWall() {
    const halfCell = CELL_SIZE / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-halfCell, 0);
    shape.lineTo(-halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, 0);

    const doorW = 0.75, doorH = 2.05;
    const hole = new THREE.Path();
    hole.moveTo(-doorW, 0);
    hole.lineTo(-doorW, doorH);
    hole.lineTo(doorW, doorH);
    hole.lineTo(doorW, 0);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry(shape, { depth: WALL_THICKNESS, bevelEnabled: false });
}

function buildWindowWall() {
    const halfCell = CELL_SIZE / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-halfCell, 0);
    shape.lineTo(-halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, WALL_HEIGHT);
    shape.lineTo(halfCell, 0);

    const winW = 0.7, winBottom = 0.9, winTop = 2.1;
    const hole = new THREE.Path();
    hole.moveTo(-winW, winBottom);
    hole.lineTo(-winW, winTop);
    hole.lineTo(winW, winTop);
    hole.lineTo(winW, winBottom);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry(shape, { depth: WALL_THICKNESS, bevelEnabled: false });
}

function createWallMesh(optionId) {
    const opt = OPTION_REGISTRY[optionId];
    if (!opt || (opt.type === OPTION_TYPE.OPEN && optionId === 0)) return null;

    const mat = wallMaterials[optionId] || wallMaterials[10];
    let geo;

    if (optionId === 20) {
        geo = buildWindowWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        mesh.position.y = 0.04;
        return mesh;
    } else if (opt.type === OPTION_TYPE.WALL) {
        const h = opt.halfHeight ? WALL_HEIGHT * 0.45 : WALL_HEIGHT;
        geo = buildSolidWall(h);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = h / 2;
        return mesh;
    } else if (optionId === 1) {
        geo = buildArchWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        mesh.position.y = 0.04;
        return mesh;
    } else if (optionId === 2) {
        geo = buildRectDoorWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        mesh.position.y = 0.04;
        return mesh;
    }
    return null;
}

function positionWall(mesh, faceIndex, worldPos) {
    const half = CELL_SIZE / 2;
    const [cx, cy, cz] = worldPos;
    const wrapper = new THREE.Group();
    wrapper.add(mesh);

    switch (faceIndex) {
        case FACE.POS_X: wrapper.position.set(cx + half, cy, cz); wrapper.rotation.y = Math.PI / 2; break;
        case FACE.NEG_X: wrapper.position.set(cx - half, cy, cz); wrapper.rotation.y = -Math.PI / 2; break;
        case FACE.POS_Z: wrapper.position.set(cx, cy, cz + half); wrapper.rotation.y = 0; break;
        case FACE.NEG_Z: wrapper.position.set(cx, cy, cz - half); wrapper.rotation.y = Math.PI; break;
    }

    // Store face info for raycasting
    wrapper.userData.faceIndex = faceIndex;
    wrapper.traverse(child => {
        if (child.isMesh) child.userData.faceIndex = faceIndex;
    });

    return wrapper;
}

// ─── Rendered Cell Group ────────────────────────────────────

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

/**
 * Render a complete scene from ParticleCell array
 * @param {Array} cells - array of ParticleCell objects
 * @returns {{ sceneGroup: THREE.Group, cellMap: Map, center: {x, z} }}
 */
export function renderCells(cells) {
    const sceneGroup = new THREE.Group();
    const cellMap = new Map(); // key → cell reference
    const allKeys = new Set();

    // Register all cell positions
    for (const cell of cells) {
        const [px, , pz] = cell.position;
        allKeys.add(`${px},${pz}`);
    }

    // Calculate center for camera
    let sumX = 0, sumZ = 0;
    for (const cell of cells) {
        sumX += cell.position[0];
        sumZ += cell.position[2];
    }
    const center = {
        x: (sumX / cells.length) * CELL_SIZE,
        z: (sumZ / cells.length) * CELL_SIZE,
    };

    for (const cell of cells) {
        const [px, , pz] = cell.position;
        const key = `${px},${pz}`;
        cellMap.set(key, cell);

        const group = new THREE.Group();
        group.position.set(px * CELL_SIZE, 0, pz * CELL_SIZE);

        // Floor
        const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);
        const floor = new THREE.Mesh(floorGeo, floorMat);
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

            // Skip duplicate walls between adjacent cells
            const [dx, , dz] = FACE_DIRECTION[fi];
            const neighborKey = `${px + dx},${pz + dz}`;
            if (allKeys.has(neighborKey) && fi > OPPOSITE_FACE[fi]) continue;

            const mesh = createWallMesh(optionId);
            if (mesh) {
                const wall = positionWall(mesh, fi, [0, 0, 0]);
                wall.userData.cellKey = key;
                wall.userData.faceIndex = fi;
                group.add(wall);
            }
        }

        group.userData.cellKey = key;
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

    const [px, , pz] = cell.position;

    // Find and remove old group
    for (let i = sceneGroup.children.length - 1; i >= 0; i--) {
        const child = sceneGroup.children[i];
        if (child.userData.cellKey === cellKey) {
            sceneGroup.remove(child);
            break;
        }
    }

    // Rebuild
    const group = new THREE.Group();
    group.position.set(px * CELL_SIZE, 0, pz * CELL_SIZE);

    const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    group.add(floor);

    const floorEdgeGeo = new THREE.EdgesGeometry(floorGeo);
    const floorEdges = new THREE.LineSegments(floorEdgeGeo, edgeMat);
    floorEdges.rotation.x = -Math.PI / 2;
    floorEdges.position.y = 0.02;
    group.add(floorEdges);

    for (const fi of HORIZONTAL_FACES) {
        const optionId = getResolvedOption(cell, fi);
        if (optionId === null) continue;

        const [dx, , dz] = FACE_DIRECTION[fi];
        const neighborKey = `${px + dx},${pz + dz}`;
        if (allKeys.has(neighborKey) && fi > OPPOSITE_FACE[fi]) continue;

        const mesh = createWallMesh(optionId);
        if (mesh) {
            const wall = positionWall(mesh, fi, [0, 0, 0]);
            wall.userData.cellKey = cellKey;
            wall.userData.faceIndex = fi;
            group.add(wall);
        }
    }

    group.userData.cellKey = cellKey;
    sceneGroup.add(group);
}

export { CELL_SIZE, WALL_HEIGHT };
