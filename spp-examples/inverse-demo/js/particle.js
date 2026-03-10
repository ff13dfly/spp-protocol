/**
 * particle.js — SPP Data Model & Face Option Registry
 * Shared with maze-demo, adapted for inverse modeling.
 *
 * Re-exports from the shared SPP library (spp-lib) to maintain
 * backward-compatible import paths for this demo's internal modules.
 */

// ─── Core SPP Data Model ────────────────────────────────────
export {
    FACE, OPPOSITE_FACE, FACE_DIRECTION, FACE_NAMES,
    OPTION_TYPE, OPTION_REGISTRY, OPEN_IDS, WALL_IDS, ALL_IDS,
    getResolvedOption, cycleOption,
    createCell, createChunk, collapseCell,
} from '../../../spp-lib/spp-core.js';

// ─── Inverse-Modeling Specific ──────────────────────────────
export {
    expandScaledCells,
    generateCellsFromLayout,
    optimizeGrid,
} from '../../../spp-lib/spp-inverse-engine.js';
