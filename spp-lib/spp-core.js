/**
 * spp-core.js — SPP (String Particle Protocol) Core Data Model
 *
 * Shared definitions for all SPP applications.
 * Maps directly to SPP-Core v1.0 spec:
 *   ParticleCell { position, size, faceStates, faceOptions }
 *   ParticleChunk { cells[] }
 */

// ═════════════════════════════════════════════════════════════
// Face Constants (spec Section 3.2.3)
// ═════════════════════════════════════════════════════════════

// Face direction indices
export const FACE = {
    POS_X: 0,  // +X (right)
    NEG_X: 1,  // -X (left)
    POS_Y: 2,  // +Y (up)
    NEG_Y: 3,  // -Y (down)
    POS_Z: 4,  // +Z (front)
    NEG_Z: 5,  // -Z (back)
};

// Opposite face mapping
export const OPPOSITE_FACE = {
    [FACE.POS_X]: FACE.NEG_X,
    [FACE.NEG_X]: FACE.POS_X,
    [FACE.POS_Y]: FACE.NEG_Y,
    [FACE.NEG_Y]: FACE.POS_Y,
    [FACE.POS_Z]: FACE.NEG_Z,
    [FACE.NEG_Z]: FACE.POS_Z,
};

// Direction vectors for each face
export const FACE_DIRECTION = {
    [FACE.POS_X]: [1, 0, 0],
    [FACE.NEG_X]: [-1, 0, 0],
    [FACE.POS_Y]: [0, 1, 0],
    [FACE.NEG_Y]: [0, -1, 0],
    [FACE.POS_Z]: [0, 0, 1],
    [FACE.NEG_Z]: [0, 0, -1],
};

// Human-readable face names
export const FACE_NAMES = {
    [FACE.POS_X]: '+X (right)',
    [FACE.NEG_X]: '-X (left)',
    [FACE.POS_Y]: '+Y (up)',
    [FACE.NEG_Y]: '-Y (down)',
    [FACE.POS_Z]: '+Z (front)',
    [FACE.NEG_Z]: '-Z (back)',
};

// ═════════════════════════════════════════════════════════════
// Face Option Type & Registry
// ═════════════════════════════════════════════════════════════

export const OPTION_TYPE = {
    OPEN: 'open',
    WALL: 'wall',
};

// Face Option Registry — each id maps to { name, type, color, alpha }
// type: 'open' = passage, 'wall' = barrier
export const OPTION_REGISTRY = {
    // Open types (connections)
    0: { name: 'Empty', type: OPTION_TYPE.OPEN, color: 0x000000, alpha: 0.0 },
    1: { name: 'Arch Door', type: OPTION_TYPE.OPEN, color: 0x8b7355, alpha: 1.0 },
    2: { name: 'Rectangular Door', type: OPTION_TYPE.OPEN, color: 0x6b5b45, alpha: 1.0 },

    // Wall types (barriers)
    10: { name: 'Brick Wall', type: OPTION_TYPE.WALL, color: 0x8b4513, alpha: 1.0 },
    11: { name: 'Earth Wall', type: OPTION_TYPE.WALL, color: 0xa0855b, alpha: 1.0 },
    12: { name: 'Half-height Wall', type: OPTION_TYPE.WALL, color: 0x9e8e7e, alpha: 1.0, halfHeight: true },
    13: { name: 'Green Hedge', type: OPTION_TYPE.WALL, color: 0x2d5a27, alpha: 1.0 },
    20: { name: 'Window', type: OPTION_TYPE.WALL, color: 0x88bbdd, alpha: 0.6, halfHeight: true },
};

export const OPEN_IDS = [0, 1, 2];
export const WALL_IDS = [10, 11, 12, 13, 20];
export const ALL_IDS = [...OPEN_IDS, ...WALL_IDS];

// ═════════════════════════════════════════════════════════════
// Cell Operations
// ═════════════════════════════════════════════════════════════

/**
 * Get the resolved option id for a face (post-collapse).
 * Returns null if not collapsed or empty.
 */
export function getResolvedOption(cell, faceIndex) {
    const opts = cell.faceOptions[faceIndex];
    if (opts && opts.length === 1) return opts[0];
    return null;
}

/**
 * Cycle a face's option to the next registered option.
 */
export function cycleOption(cell, faceIndex) {
    const current = getResolvedOption(cell, faceIndex);
    if (current === null) return;
    const idx = ALL_IDS.indexOf(current);
    const next = ALL_IDS[(idx + 1) % ALL_IDS.length];
    cell.faceOptions[faceIndex] = [next];
}

// ═════════════════════════════════════════════════════════════
// Data Structures (Forward / Generative)
// ═════════════════════════════════════════════════════════════

/**
 * Create a new ParticleCell at the given position with all options available.
 */
export function createCell(x, y, z) {
    return {
        position: [x, y, z],
        size: [1, 1, 1],
        faceStates: 0b111111,  // all faces active by default
        faceOptions: [
            [...ALL_IDS],  // +X
            [...ALL_IDS],  // -X
            [],            // +Y (floor/ceiling — not used in 2D)
            [],            // -Y
            [...ALL_IDS],  // +Z
            [...ALL_IDS],  // -Z
        ],
    };
}

/**
 * Create an empty ParticleChunk.
 */
export function createChunk() {
    return { cells: [] };
}

/**
 * Collapse: resolve each face's options to a single random selection.
 * Returns a new cell with single-element faceOptions.
 */
export function collapseCell(cell) {
    const collapsed = {
        ...cell,
        faceOptions: cell.faceOptions.map(opts => {
            if (opts.length === 0) return [];
            return [opts[Math.floor(Math.random() * opts.length)]];
        }),
    };
    return collapsed;
}
