/**
 * maze-generator.js — Cascade collapse from center (dynamic grid)
 *
 * Accepts gridX, gridZ (odd numbers) and target cell count.
 */

import {
    FACE, OPPOSITE_FACE, FACE_DIRECTION,
    OPEN_IDS, WALL_IDS,
    createChunk, collapseCell,
} from './particle.js';

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

function posKey(x, z) { return `${x},${z}`; }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function createGridCell(x, z) {
    return {
        position: [x, 0, z],
        size: [1, 1, 1],
        faceStates: 0b111111,
        faceOptions: [
            [...WALL_IDS],
            [...WALL_IDS],
            [],
            [],
            [...WALL_IDS],
            [...WALL_IDS],
        ],
    };
}

/**
 * @param {number} gridX — grid width (odd, e.g. 7)
 * @param {number} gridZ — grid depth (odd, e.g. 7)
 * @param {number} targetCells — desired number of collapsed cells
 */
export function generateCascade(gridX = 7, gridZ = 7, targetCells = 35) {
    const halfX = Math.floor(gridX / 2);
    const halfZ = Math.floor(gridZ / 2);
    const target = Math.min(targetCells, gridX * gridZ);

    function inBounds(x, z) {
        return x >= -halfX && x <= halfX && z >= -halfZ && z <= halfZ;
    }

    // Phase 1: Create grid
    const gridCells = new Map();
    for (let x = -halfX; x <= halfX; x++) {
        for (let z = -halfZ; z <= halfZ; z++) {
            gridCells.set(posKey(x, z), createGridCell(x, z));
        }
    }

    // Phase 2: Cascade from center
    const collapsed = new Set();
    const collapseOrder = [];
    const connections = new Map();

    const centerKey = posKey(0, 0);
    const centerCell = gridCells.get(centerKey);
    collapsed.add(centerKey);
    collapseOrder.push({ key: centerKey, cell: centerCell, fromFace: -1 });
    connections.set(centerKey, new Set());

    const queue = [];

    const centerFaces = shuffle(HORIZONTAL_FACES);
    for (const face of centerFaces) {
        const [dx, , dz] = FACE_DIRECTION[face];
        if (inBounds(dx, dz) && !collapsed.has(posKey(dx, dz))) {
            queue.push({ x: 0, z: 0, face, nx: dx, nz: dz });
        }
    }

    while (queue.length > 0 && collapsed.size < target) {
        const { x, z, face, nx, nz } = queue.shift();
        const nKey = posKey(nx, nz);
        const srcKey = posKey(x, z);
        if (collapsed.has(nKey)) continue;

        collapsed.add(nKey);
        const cell = gridCells.get(nKey);

        const oppFace = OPPOSITE_FACE[face];
        const srcCell = gridCells.get(srcKey);
        srcCell.faceOptions[face] = [...OPEN_IDS];
        cell.faceOptions[oppFace] = [...OPEN_IDS];

        if (!connections.has(srcKey)) connections.set(srcKey, new Set());
        if (!connections.has(nKey)) connections.set(nKey, new Set());
        connections.get(srcKey).add(nKey);
        connections.get(nKey).add(srcKey);

        collapseOrder.push({ key: nKey, cell, fromFace: oppFace });

        const remainingFaces = shuffle(HORIZONTAL_FACES.filter(f => f !== oppFace));
        const extraConnections = Math.floor(Math.random() * 3);

        for (let i = 0; i < Math.min(extraConnections, remainingFaces.length); i++) {
            const newFace = remainingFaces[i];
            const [dx2, , dz2] = FACE_DIRECTION[newFace];
            const nnx = nx + dx2;
            const nnz = nz + dz2;
            if (inBounds(nnx, nnz) && !collapsed.has(posKey(nnx, nnz))) {
                queue.push({ x: nx, z: nz, face: newFace, nx: nnx, nz: nnz });
            }
        }
    }

    // Phase 2b: Fill up if needed
    if (collapsed.size < target) {
        for (const [key, cell] of gridCells) {
            if (!collapsed.has(key)) continue;
            if (collapsed.size >= target) break;
            const [cx, , cz] = cell.position;
            for (const face of shuffle(HORIZONTAL_FACES)) {
                if (collapsed.size >= target) break;
                const [dx, , dz] = FACE_DIRECTION[face];
                const nx = cx + dx;
                const nz = cz + dz;
                const nKey = posKey(nx, nz);
                if (inBounds(nx, nz) && !collapsed.has(nKey)) {
                    cell.faceOptions[face] = [...OPEN_IDS];
                    const neighbor = gridCells.get(nKey);
                    const oppFace = OPPOSITE_FACE[face];
                    neighbor.faceOptions[oppFace] = [...OPEN_IDS];
                    collapsed.add(nKey);
                    collapseOrder.push({ key: nKey, cell: neighbor, fromFace: oppFace });
                    if (!connections.has(key)) connections.set(key, new Set());
                    if (!connections.has(nKey)) connections.set(nKey, new Set());
                    connections.get(key).add(nKey);
                    connections.get(nKey).add(key);
                }
            }
        }
    }

    // Phase 3: Collapse face options to single values
    const collapsedCells = new Map();
    for (const { key, cell } of collapseOrder) {
        collapsedCells.set(key, collapseCell(cell));
    }

    for (const [key, cell] of collapsedCells) {
        const [cx, , cz] = cell.position;
        for (const face of HORIZONTAL_FACES) {
            const [dx, , dz] = FACE_DIRECTION[face];
            const nKey = posKey(cx + dx, cz + dz);
            const neighbor = collapsedCells.get(nKey);
            if (neighbor) {
                const oppFace = OPPOSITE_FACE[face];
                const myOpt = cell.faceOptions[face];
                if (myOpt.length === 1 && OPEN_IDS.includes(myOpt[0])) {
                    neighbor.faceOptions[oppFace] = [...myOpt];
                }
            }
        }
    }

    return {
        gridCells,
        collapseOrder,
        collapsedCells,
        gridX,
        gridZ,
        halfX,
        halfZ,
    };
}

/**
 * BFS pathfinding between two points in collapsed space
 */
export function findPath(collapsedCells, startKey, endKey) {
    if (!collapsedCells.has(startKey) || !collapsedCells.has(endKey)) return null;
    if (startKey === endKey) return [startKey];

    const queue = [[startKey]];
    const visited = new Set([startKey]);

    while (queue.length > 0) {
        const path = queue.shift();
        const currKey = path[path.length - 1];
        const cell = collapsedCells.get(currKey);

        const [cx, , cz] = cell.position;
        for (const face of HORIZONTAL_FACES) {
            const myOpt = cell.faceOptions[face];
            // Only proceed if there is an open connection on this face
            if (myOpt.length === 1 && OPEN_IDS.includes(myOpt[0])) {
                const [dx, , dz] = FACE_DIRECTION[face];
                const nextKey = `${cx + dx},${cz + dz}`;

                if (nextKey === endKey) return [...path, nextKey];
                if (collapsedCells.has(nextKey) && !visited.has(nextKey)) {
                    visited.add(nextKey);
                    queue.push([...path, nextKey]);
                }
            }
        }
    }

    return null;
}
