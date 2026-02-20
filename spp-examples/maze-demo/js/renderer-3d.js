/**
 * renderer-3d.js — Clean white-background renderer
 */

import * as THREE from 'three';
import { FACE, OPPOSITE_FACE, FACE_DIRECTION, OPTION_REGISTRY, OPTION_TYPE, getResolvedOption } from './particle.js';

const CELL_SIZE = 3;
const WALL_HEIGHT = 2.8;
const WALL_THICKNESS = 0.12;

// ─── Materials (light theme) ────────────────────────────────

const ghostMat = new THREE.MeshStandardMaterial({
    color: 0x9999bb,
    transparent: true,
    opacity: 0.08,
    roughness: 0.6,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
});

const ghostEdgeMat = new THREE.LineBasicMaterial({
    color: 0x9999cc,
    transparent: true,
    opacity: 0.2,
});

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

const centerFloorMat = new THREE.MeshStandardMaterial({
    color: 0x8ab4f8,
    roughness: 0.5,
    metalness: 0.05,
});

const wallMaterials = {
    10: new THREE.MeshStandardMaterial({ color: 0xd4886b, roughness: 0.55, metalness: 0.05 }),  // brick
    11: new THREE.MeshStandardMaterial({ color: 0xc8b48a, roughness: 0.65, metalness: 0.0 }),   // earth
    12: new THREE.MeshStandardMaterial({ color: 0xccccd5, roughness: 0.4, metalness: 0.1, transparent: true, opacity: 0.7 }),  // half wall - glass
    13: new THREE.MeshStandardMaterial({ color: 0x6aad5e, roughness: 0.7, metalness: 0.0 }),    // hedge
    1: new THREE.MeshStandardMaterial({ color: 0x9988bb, roughness: 0.4, metalness: 0.1 }),    // arch
    2: new THREE.MeshStandardMaterial({ color: 0x7799bb, roughness: 0.4, metalness: 0.1 }),    // door
};

// ─── Ghost Block ────────────────────────────────────────────

function createGhostBlock(x, z) {
    const group = new THREE.Group();
    group.position.set(x * CELL_SIZE, 0, z * CELL_SIZE);

    const boxGeo = new THREE.BoxGeometry(CELL_SIZE * 0.92, WALL_HEIGHT * 0.25, CELL_SIZE * 0.92);
    const box = new THREE.Mesh(boxGeo, ghostMat);
    box.position.y = WALL_HEIGHT * 0.125;
    group.add(box);

    const edges = new THREE.EdgesGeometry(boxGeo);
    const lines = new THREE.LineSegments(edges, ghostEdgeMat);
    lines.position.y = WALL_HEIGHT * 0.125;
    group.add(lines);

    group.userData.gridPos = [x, z];
    group.userData.isGhost = true;

    return group;
}

// ─── Wall Geometry Builders ─────────────────────────────────

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

function createWallMesh(optionId) {
    const opt = OPTION_REGISTRY[optionId];
    if (!opt || (opt.type === OPTION_TYPE.OPEN && optionId === 0)) return null;

    const mat = wallMaterials[optionId] || wallMaterials[10];
    let geo;

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
        mesh.position.y = 0.04; // clear the floor to prevent z-fighting
        return mesh;
    } else if (optionId === 2) {
        geo = buildRectDoorWall();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -WALL_THICKNESS / 2;
        mesh.position.y = 0.04; // clear the floor to prevent z-fighting
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
    return wrapper;
}

// ─── Resolved Cell ──────────────────────────────────────────

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

function renderResolvedCell(cell, allCollapsed) {
    const group = new THREE.Group();
    const [px, , pz] = cell.position;
    const isCenter = (px === 0 && pz === 0);
    group.position.set(px * CELL_SIZE, 0, pz * CELL_SIZE);

    // Floor — center gets a distinct color
    const floorGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.98, CELL_SIZE * 0.98);
    const floor = new THREE.Mesh(floorGeo, isCenter ? centerFloorMat : floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    group.add(floor);

    // Center marker dot
    if (isCenter) {
        const dotGeo = new THREE.CircleGeometry(0.3, 24);
        const dotMat = new THREE.MeshStandardMaterial({ color: 0x4285f4, roughness: 0.3 });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.rotation.x = -Math.PI / 2;
        dot.position.y = 0.03;
        group.add(dot);
    }

    // Floor edge outline
    const floorEdgeGeo = new THREE.EdgesGeometry(floorGeo);
    const floorEdges = new THREE.LineSegments(floorEdgeGeo, edgeMat);
    floorEdges.rotation.x = -Math.PI / 2;
    floorEdges.position.y = 0.02;
    group.add(floorEdges);

    // Walls
    for (const fi of HORIZONTAL_FACES) {
        const optionId = getResolvedOption(cell, fi);
        if (optionId === null) continue;

        const [dx, , dz] = FACE_DIRECTION[fi];
        const neighborKey = `${px + dx},${pz + dz}`;
        if (allCollapsed.has(neighborKey) && fi > OPPOSITE_FACE[fi]) continue;

        const mesh = createWallMesh(optionId);
        if (mesh) {
            group.add(positionWall(mesh, fi, [0, 0, 0]));
        }
    }

    group.scale.set(0.001, 0.001, 0.001);
    group.visible = false;
    group.userData.gridPos = [px, pz];
    group.userData.isResolved = true;

    return group;
}

// ─── Public API ─────────────────────────────────────────────

export function buildGhostGrid(gridCells, centerKey) {
    const gridGroup = new THREE.Group();
    const ghostMap = new Map();

    for (const [key, cell] of gridCells) {
        if (key === centerKey) continue;
        const [x, , z] = cell.position;
        const ghost = createGhostBlock(x, z);
        gridGroup.add(ghost);
        ghostMap.set(key, ghost);
    }

    return { gridGroup, ghostMap };
}

export function buildResolvedCell(cell, allCollapsedKeys) {
    return renderResolvedCell(cell, allCollapsedKeys);
}

export function renderSuperpositionParticle(cell) {
    const group = new THREE.Group();
    group.position.y = 0.15; // raise above ground to prevent z-fighting

    // Floor
    const floorGeo = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    group.add(floor);

    // Wireframe bounding box — raised slightly so bottom edge clears the floor
    const boxGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const eMat = new THREE.LineBasicMaterial({ color: 0x8899bb, transparent: true, opacity: 0.35 });
    const lines = new THREE.LineSegments(edges, eMat);
    lines.position.y = WALL_HEIGHT / 2 + 0.05;
    group.add(lines);

    // Face option cycling
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

// ─── Path Visualization ─────────────────────────────────────

let pathGroup = null;

export function clearPath(scene) {
    if (pathGroup) {
        scene.remove(pathGroup);
        pathGroup = null;
    }
}

export function renderPath(scene, path, collapsedCells) {
    clearPath(scene);
    if (!path || path.length < 2) return;

    pathGroup = new THREE.Group();
    scene.add(pathGroup);

    const points = [];
    const pathMat = new THREE.MeshStandardMaterial({
        color: 0x4285f4,
        transparent: true,
        opacity: 0.4,
        emissive: 0x4285f4,
        emissiveIntensity: 0.5,
    });

    for (let i = 0; i < path.length; i++) {
        const key = path[i];
        const cell = collapsedCells.get(key);
        if (!cell) continue;

        const [px, , pz] = cell.position;
        const wx = px * CELL_SIZE;
        const wz = pz * CELL_SIZE;
        points.push(new THREE.Vector3(wx, 0.05, wz));

        // Highlight floor of path cells
        const highlightGeo = new THREE.PlaneGeometry(CELL_SIZE * 0.8, CELL_SIZE * 0.8);
        const highlight = new THREE.Mesh(highlightGeo, pathMat);
        highlight.rotation.x = -Math.PI / 2;
        highlight.position.set(wx, 0.04, wz);
        pathGroup.add(highlight);
    }

    // Draw a continuous line above the floor
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(curve, path.length * 4, 0.08, 8, false);
    const tubeMat = new THREE.MeshStandardMaterial({
        color: 0x4285f4,
        emissive: 0x4285f4,
        emissiveIntensity: 1.0,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    pathGroup.add(tube);
}

export { CELL_SIZE, WALL_HEIGHT };
