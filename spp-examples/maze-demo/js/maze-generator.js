/**
 * maze-generator.js — Generates a ParticleChunk maze using randomized DFS
 *
 * Produces a flat (Y=0) maze of 30–50 cells.
 * All horizontal faces default to WALL. Passages are explicitly carved.
 */

import {
    FACE, OPPOSITE_FACE, FACE_DIRECTION,
    OPEN_IDS, WALL_IDS,
    createChunk, collapseCell,
} from './particle.js';

const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

function posKey(x, y, z) {
    return `${x},${y},${z}`;
}

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Create a cell with all horizontal faces defaulting to WALL options.
 * Y faces are empty (horizontal-only maze).
 */
function createMazeCell(x, y, z) {
    return {
        position: [x, y, z],
        size: [1, 1, 1],
        faceStates: 0b111111,
        faceOptions: [
            [...WALL_IDS],   // +X — wall by default
            [...WALL_IDS],   // -X — wall by default
            [],              // +Y — unused
            [],              // -Y — unused
            [...WALL_IDS],   // +Z — wall by default
            [...WALL_IDS],   // -Z — wall by default
        ],
    };
}

/**
 * Generate a maze chunk.
 * @param {number} targetSize — desired number of cells (30–50)
 * @returns {{ chunk, collapsedChunk }}
 */
export function generateMaze(targetSize = 40) {
    const cellMap = new Map(); // posKey → cell
    const visited = new Set();
    const stack = [];

    // --- Phase 1: Build connected maze via recursive backtracker ---

    const startCell = createMazeCell(0, 0, 0);
    cellMap.set(posKey(0, 0, 0), startCell);
    visited.add(posKey(0, 0, 0));
    stack.push(startCell);

    while (stack.length > 0 && cellMap.size < targetSize) {
        const current = stack[stack.length - 1];
        const [cx, cy, cz] = current.position;

        // Collect unvisited horizontal neighbors
        const unvisited = [];
        for (const face of shuffle(HORIZONTAL_FACES)) {
            const [dx, dy, dz] = FACE_DIRECTION[face];
            const nx = cx + dx;
            const ny = cy + dy;
            const nz = cz + dz;
            const key = posKey(nx, ny, nz);
            if (!visited.has(key)) {
                unvisited.push({ face, nx, ny, nz, key });
            }
        }

        if (unvisited.length === 0) {
            stack.pop();
            continue;
        }

        // Pick a random unvisited neighbor
        const chosen = unvisited[0]; // already shuffled
        const neighborCell = createMazeCell(chosen.nx, chosen.ny, chosen.nz);
        cellMap.set(chosen.key, neighborCell);
        visited.add(chosen.key);

        // Carve passage: BOTH sides of shared face get OPEN options
        const oppFace = OPPOSITE_FACE[chosen.face];
        current.faceOptions[chosen.face] = [...OPEN_IDS];
        neighborCell.faceOptions[oppFace] = [...OPEN_IDS];

        stack.push(neighborCell);
    }

    // --- Phase 2: Collapse ---
    // Pick one option per face. Connected faces MUST agree.

    const chunk = createChunk();
    chunk.cells = Array.from(cellMap.values());

    const collapsedChunk = createChunk();
    collapsedChunk.cells = chunk.cells.map(cell => collapseCell(cell));

    // Enforce shared-face agreement: for every connected pair,
    // the collapse result must be the same option on both sides.
    for (const cell of collapsedChunk.cells) {
        const [cx, cy, cz] = cell.position;
        for (const face of HORIZONTAL_FACES) {
            const [dx, dy, dz] = FACE_DIRECTION[face];
            const neighborKey = posKey(cx + dx, cy + dy, cz + dz);
            const neighbor = collapsedChunk.cells.find(
                c => posKey(...c.position) === neighborKey
            );
            if (neighbor) {
                const oppFace = OPPOSITE_FACE[face];
                const myOpt = cell.faceOptions[face];
                const theirOpt = neighbor.faceOptions[oppFace];

                // If one side is open, make the other side match
                if (myOpt.length === 1 && theirOpt.length === 1) {
                    const myId = myOpt[0];
                    const theirId = theirOpt[0];
                    // Open options (0,1,2) should agree
                    if (OPEN_IDS.includes(myId) || OPEN_IDS.includes(theirId)) {
                        // Use whichever is open, or pick the first cell's choice
                        neighbor.faceOptions[oppFace] = [...myOpt];
                    } else {
                        // Both are walls — that's fine, no passage
                    }
                }
            }
        }
    }

    return { chunk, collapsedChunk };
}
