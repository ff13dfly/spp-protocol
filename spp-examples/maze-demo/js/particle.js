/**
 * particle.js — SPP Data Model & Face Option Registry
 *
 * Maps directly to SPP-Core v1.0 spec:
 *   ParticleCell { position, size, faceStates, faceOptions }
 *   ParticleChunk { cells[] }
 *
 * Re-exports from the shared SPP library (spp-lib) to maintain
 * backward-compatible import paths for this demo's internal modules.
 */

export {
  FACE, OPPOSITE_FACE, FACE_DIRECTION,
  OPTION_TYPE, OPTION_REGISTRY, OPEN_IDS, WALL_IDS, ALL_IDS,
  getResolvedOption,
  createCell, createChunk, collapseCell,
} from '../../../spp-lib/spp-core.js';
