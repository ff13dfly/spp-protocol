/**
 * particle.js — SPP Data Model & Face Option Registry
 * Shared with maze-demo, adapted for inverse modeling.
 */

export const FACE = {
    POS_X: 0,  // +X (right)
    NEG_X: 1,  // -X (left)
    POS_Y: 2,  // +Y (up)
    NEG_Y: 3,  // -Y (down)
    POS_Z: 4,  // +Z (front)
    NEG_Z: 5,  // -Z (back)
};

export const OPPOSITE_FACE = {
    [FACE.POS_X]: FACE.NEG_X,
    [FACE.NEG_X]: FACE.POS_X,
    [FACE.POS_Y]: FACE.NEG_Y,
    [FACE.NEG_Y]: FACE.POS_Y,
    [FACE.POS_Z]: FACE.NEG_Z,
    [FACE.NEG_Z]: FACE.POS_Z,
};

export const FACE_DIRECTION = {
    [FACE.POS_X]: [1, 0, 0],
    [FACE.NEG_X]: [-1, 0, 0],
    [FACE.POS_Y]: [0, 1, 0],
    [FACE.NEG_Y]: [0, -1, 0],
    [FACE.POS_Z]: [0, 0, 1],
    [FACE.NEG_Z]: [0, 0, -1],
};

export const FACE_NAMES = {
    [FACE.POS_X]: '+X (right)',
    [FACE.NEG_X]: '-X (left)',
    [FACE.POS_Y]: '+Y (up)',
    [FACE.NEG_Y]: '-Y (down)',
    [FACE.POS_Z]: '+Z (front)',
    [FACE.NEG_Z]: '-Z (back)',
};

export const OPTION_TYPE = {
    OPEN: 'open',
    WALL: 'wall',
};

export const OPTION_REGISTRY = {
    0: { name: 'Empty', type: OPTION_TYPE.OPEN, color: 0x000000, alpha: 0.0 },
    1: { name: 'Arch Door', type: OPTION_TYPE.OPEN, color: 0x8b7355, alpha: 1.0 },
    2: { name: 'Rectangular Door', type: OPTION_TYPE.OPEN, color: 0x6b5b45, alpha: 1.0 },
    10: { name: 'Brick Wall', type: OPTION_TYPE.WALL, color: 0x8b4513, alpha: 1.0 },
    11: { name: 'Earth Wall', type: OPTION_TYPE.WALL, color: 0xa0855b, alpha: 1.0 },
    12: { name: 'Half-height Wall', type: OPTION_TYPE.WALL, color: 0x9e8e7e, alpha: 1.0, halfHeight: true },
    13: { name: 'Green Hedge', type: OPTION_TYPE.WALL, color: 0x2d5a27, alpha: 1.0 },
    20: { name: 'Window', type: OPTION_TYPE.WALL, color: 0x88bbdd, alpha: 0.6, halfHeight: true },
};

export const OPEN_IDS = [0, 1, 2];
export const WALL_IDS = [10, 11, 12, 13, 20];
export const ALL_IDS = [...OPEN_IDS, ...WALL_IDS];

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
