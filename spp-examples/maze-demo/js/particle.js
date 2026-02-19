/**
 * particle.js — SPP Data Model & Face Option Registry
 *
 * Maps directly to SPP-Core v1.0 spec:
 *   ParticleCell { position, size, faceStates, faceOptions }
 *   ParticleChunk { cells[] }
 */

// Face direction indices (spec Section 3.2.3)
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

// ─── Face Option Types ──────────────────────────────────────

export const OPTION_TYPE = {
  OPEN: 'open',
  WALL: 'wall',
};

// ─── Face Option Registry ───────────────────────────────────
// Each id maps to { name, type, color, alpha }
// type: 'open' = passage, 'wall' = barrier

export const OPTION_REGISTRY = {
  // Open types (connections)
  0:  { name: 'Empty',               type: OPTION_TYPE.OPEN, color: 0x000000, alpha: 0.0 },
  1:  { name: 'Arch Door',           type: OPTION_TYPE.OPEN, color: 0x8b7355, alpha: 1.0 },
  2:  { name: 'Rectangular Door',    type: OPTION_TYPE.OPEN, color: 0x6b5b45, alpha: 1.0 },

  // Wall types (barriers)
  10: { name: 'Brick Wall',          type: OPTION_TYPE.WALL, color: 0x8b4513, alpha: 1.0 },
  11: { name: 'Earth Wall',          type: OPTION_TYPE.WALL, color: 0xa0855b, alpha: 1.0 },
  12: { name: 'Half-height Wall',    type: OPTION_TYPE.WALL, color: 0x9e8e7e, alpha: 1.0, halfHeight: true },
  13: { name: 'Green Hedge',         type: OPTION_TYPE.WALL, color: 0x2d5a27, alpha: 1.0 },
};

export const OPEN_IDS = [0, 1, 2];
export const WALL_IDS = [10, 11, 12, 13];
export const ALL_IDS  = [...OPEN_IDS, ...WALL_IDS];

// ─── Data Structures ────────────────────────────────────────

export function createCell(x, y, z) {
  return {
    position: [x, y, z],
    size: [1, 1, 1],
    faceStates: 0b111111,  // all faces active by default
    faceOptions: [
      [...ALL_IDS],  // +X
      [...ALL_IDS],  // -X
      [],            // +Y (floor/ceiling — not used in 2D maze)
      [],            // -Y
      [...ALL_IDS],  // +Z
      [...ALL_IDS],  // -Z
    ],
  };
}

export function createChunk() {
  return { cells: [] };
}

/**
 * Collapse: resolve each face's options to a single selection.
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

/**
 * Get the resolved option id for a face (post-collapse).
 * Returns null if not collapsed or empty.
 */
export function getResolvedOption(cell, faceIndex) {
  const opts = cell.faceOptions[faceIndex];
  if (opts && opts.length === 1) return opts[0];
  return null;
}
