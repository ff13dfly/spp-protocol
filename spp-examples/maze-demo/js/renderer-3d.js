/**
 * renderer-3d.js — Converts resolved ParticleChunk into Three.js meshes
 *
 * Renders the maze as a unified structure:
 * - Floors are seamless tiles
 * - Shared faces between adjacent cells only render once
 * - Open faces (passages) render no geometry
 */

import * as THREE from 'three';
import { FACE, OPPOSITE_FACE, FACE_DIRECTION, OPTION_REGISTRY, OPTION_TYPE, getResolvedOption, ALL_IDS } from './particle.js';

const CELL_SIZE = 3;
const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.15;

// ─── Materials ──────────────────────────────────────────────

function createMaterials() {
    return {
        brick: new THREE.MeshStandardMaterial({
            color: 0x8b4513,
            roughness: 0.88,
            metalness: 0.02,
        }),
        earth: new THREE.MeshStandardMaterial({
            color: 0xa0855b,
            roughness: 0.92,
            metalness: 0.0,
        }),
        halfWall: new THREE.MeshStandardMaterial({
            color: 0x9e8e7e,
            roughness: 0.85,
            metalness: 0.05,
        }),
        hedge: new THREE.MeshStandardMaterial({
            color: 0x2d6a27,
            roughness: 0.95,
            metalness: 0.0,
        }),
        doorFrame: new THREE.MeshStandardMaterial({
            color: 0x6b5b45,
            roughness: 0.7,
            metalness: 0.1,
        }),
        archFrame: new THREE.MeshStandardMaterial({
            color: 0x8b7355,
            roughness: 0.7,
            metalness: 0.1,
        }),
        floor: new THREE.MeshStandardMaterial({
            color: 0x3a3a42,
            roughness: 0.85,
            metalness: 0.1,
        }),
    };
}

const mats = createMaterials();

const OPTION_MATERIALS = {
    10: mats.brick,
    11: mats.earth,
    12: mats.halfWall,
    13: mats.hedge,
    1: mats.archFrame,
    2: mats.doorFrame,
};

// ─── Geometry Builders ──────────────────────────────────────

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
    shape.lineTo(halfCell, 0);

    // Arch hole
    const archW = 0.75;
    const archH = 2.0;
    const hole = new THREE.Path();
    hole.moveTo(archW, 0);
    hole.lineTo(archW, archH * 0.6);
    hole.quadraticCurveTo(archW, archH, 0, archH);
    hole.quadraticCurveTo(-archW, archH, -archW, archH * 0.6);
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

    const doorW = 0.7;
    const doorH = 2.0;
    const hole = new THREE.Path();
    hole.moveTo(-doorW, 0);
    hole.lineTo(-doorW, doorH);
    hole.lineTo(doorW, doorH);
    hole.lineTo(doorW, 0);
    shape.holes.push(hole);

    return new THREE.ExtrudeGeometry(shape, { depth: WALL_THICKNESS, bevelEnabled: false });
}

/**
 * Create a wall mesh for a given option id.
 * Returns a mesh positioned at (0,0,0) facing +Z.
 * Returns null for option 0 (empty / open).
 */
function createWallMesh(optionId) {
    const opt = OPTION_REGISTRY[optionId];
    if (!opt || (opt.type === OPTION_TYPE.OPEN && optionId === 0)) return null;

    let geo;
    const mat = OPTION_MATERIALS[optionId] || mats.brick;

    if (opt.type === OPTION_TYPE.WALL) {
        const h = opt.halfHeight ? WALL_HEIGHT * 0.45 : WALL_HEIGHT;
        geo = buildSolidWall(h);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = h / 2;
        return mesh;
    } else if (optionId === 1) {
        geo = buildArchWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        return mesh;
    } else if (optionId === 2) {
        geo = buildRectDoorWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        return mesh;
    }
    return null;
}

/**
 * Position a wall mesh at the correct face of a cell.
 * @param {THREE.Object3D} mesh
 * @param {number} faceIndex
 * @param {number[]} worldPos  [x, y, z] in world units
 */
function positionWall(mesh, faceIndex, worldPos) {
    const half = CELL_SIZE / 2;
    const [cx, cy, cz] = worldPos;

    const wrapper = new THREE.Group();
    wrapper.add(mesh);

    switch (faceIndex) {
        case FACE.POS_X:
            wrapper.position.set(cx + half, cy, cz);
            wrapper.rotation.y = Math.PI / 2;
            break;
        case FACE.NEG_X:
            wrapper.position.set(cx - half, cy, cz);
            wrapper.rotation.y = -Math.PI / 2;
            break;
        case FACE.POS_Z:
            wrapper.position.set(cx, cy, cz + half);
            wrapper.rotation.y = 0;
            break;
        case FACE.NEG_Z:
            wrapper.position.set(cx, cy, cz - half);
            wrapper.rotation.y = Math.PI;
            break;
    }

    return wrapper;
}

// ─── Chunk Renderer ─────────────────────────────────────────

function posKey(x, y, z) { return `${x},${y},${z}`; }

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

/**
 * Render an entire collapsed chunk as a unified maze.
 * Eliminates double-rendering of shared walls.
 */
export function renderChunk(collapsedChunk) {
    const parent = new THREE.Group();

    // Build position lookup for neighbor detection
    const cellMap = new Map();
    for (const cell of collapsedChunk.cells) {
        cellMap.set(posKey(...cell.position), cell);
    }

    // Track which face-pairs have been rendered (to avoid doubles)
    const renderedFaces = new Set();

    for (const cell of collapsedChunk.cells) {
        const [px, py, pz] = cell.position;
        const wp = [px * CELL_SIZE, 0, pz * CELL_SIZE];

        // Floor tile
        const floorGeo = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
        const floor = new THREE.Mesh(floorGeo, mats.floor);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(wp[0], 0, wp[2]);
        floor.receiveShadow = true;
        parent.add(floor);

        // Walls (horizontal faces only)
        for (const fi of HORIZONTAL_FACES) {
            const optionId = getResolvedOption(cell, fi);
            if (optionId === null) continue;

            // Create a unique key for this face-pair to avoid rendering twice
            const [dx, , dz] = FACE_DIRECTION[fi];
            const neighborKey = posKey(px + dx, py, pz + dz);
            const faceKey = [posKey(px, py, pz), fi].join(':');
            const oppFaceKey = [neighborKey, OPPOSITE_FACE[fi]].join(':');

            if (renderedFaces.has(oppFaceKey)) continue; // already rendered by neighbor
            renderedFaces.add(faceKey);

            const mesh = createWallMesh(optionId);
            if (mesh) {
                const positioned = positionWall(mesh, fi, wp);
                positioned.userData.cellPosition = wp;
                positioned.userData.gridPosition = [px, py, pz];
                parent.add(positioned);
            }
        }
    }

    // Tag all direct children with position info for animation
    for (const child of parent.children) {
        if (!child.userData.cellPosition) {
            // Floor tiles etc — derive from position
            child.userData.cellPosition = [child.position.x, 0, child.position.z];
            child.userData.gridPosition = [
                Math.round(child.position.x / CELL_SIZE),
                0,
                Math.round(child.position.z / CELL_SIZE),
            ];
        }
    }

    return parent;
}

/**
 * Render a single superposition particle (face options cycling).
 */
export function renderSuperpositionParticle(cell) {
    const group = new THREE.Group();

    // Floor
    const floorGeo = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
    const floor = new THREE.Mesh(floorGeo, mats.floor);
    floor.rotation.x = -Math.PI / 2;
    group.add(floor);

    // Translucent bounding box
    const boxGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE);
    const boxMat = new THREE.MeshStandardMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.y = WALL_HEIGHT / 2;
    group.add(box);

    // Edge glow
    const edges = new THREE.EdgesGeometry(boxGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.3 });
    const lines = new THREE.LineSegments(edges, lineMat);
    lines.position.y = WALL_HEIGHT / 2;
    group.add(lines);

    // Face option meshes (toggle visibility for cycling)
    const faceGroups = {};
    const wp = [0, 0, 0];

    for (const fi of HORIZONTAL_FACES) {
        const opts = cell.faceOptions[fi];
        faceGroups[fi] = [];
        for (const optId of opts) {
            const wallMesh = createWallMesh(optId);
            if (wallMesh) {
                const positioned = positionWall(wallMesh, fi, wp);
                positioned.visible = false;
                group.add(positioned);
                faceGroups[fi].push({ optionId: optId, mesh: positioned });
            } else {
                faceGroups[fi].push({ optionId: optId, mesh: null });
            }
        }
    }

    return { group, faceGroups };
}

export { CELL_SIZE };
