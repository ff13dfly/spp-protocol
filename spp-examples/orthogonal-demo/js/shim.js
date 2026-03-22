/**
 * shim.js — spp-lib re-export for orthogonal-demo
 */
export {
    FACE, OPPOSITE_FACE, FACE_DIRECTION, FACE_NAMES,
    OPTION_TYPE, OPTION_REGISTRY, OPEN_IDS, WALL_IDS, ALL_IDS,
    getResolvedOption,
    createCell, createChunk,
} from '../../../spp-lib/spp-core.js';

export {
    RecursiveGridManager,
} from '../../../spp-lib/spp-inverse-engine.js';
