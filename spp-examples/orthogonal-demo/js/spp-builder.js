/**
 * spp-builder.js — Recursive SPP tree builder
 *
 * Uses face-scanner to classify faces, then recursively adds refinements
 * for cells with ambiguous faces until convergence or max depth.
 */

import {
    loadImageData, findShapeBBox, isInsideShape,
    classifyFaces,
} from './face-scanner.js';

/**
 * Build a complete SPP ParticleChunk from an image of an orthogonal polygon.
 *
 * @param {string} imageSrc — URL of the shape image
 * @param {number} gridSize — initial grid dimension (short side gets this many cells)
 * @param {number} maxDepth — maximum recursion depth
 * @param {number} scale — subdivision factor per refinement level (2, 3, or 4)
 * @param {Function} onStatus — status callback
 * @returns {Promise<Object>} { chunk, stats }
 */
export async function buildSPPFromImage(imageSrc, gridSize = 4, maxDepth = 3, scale = 3, onStatus = () => {}) {
    onStatus('Loading image...');
    const { imageData, width, height } = await loadImageData(imageSrc);

    onStatus('Finding shape bounding box...');
    const bbox = findShapeBBox(imageData, width, height);

    // Determine grid dimensions preserving aspect ratio
    const aspect = bbox.w / bbox.h;
    let gridX, gridZ;
    if (aspect >= 1) {
        gridZ = gridSize;
        gridX = Math.max(gridSize, Math.round(gridSize * aspect));
    } else {
        gridX = gridSize;
        gridZ = Math.max(gridSize, Math.round(gridSize / aspect));
    }

    onStatus(`Building SPP tree: ${gridX}×${gridZ} grid, max depth ${maxDepth}...`);

    // Build the root-level chunk
    const rootCells = buildLevel(
        imageData, width,
        bbox, gridX, gridZ,
        0, maxDepth, scale,
        onStatus
    );

    const chunk = { gridX, gridZ, cells: rootCells };

    // Phase 2: Back-propagation — reconcile refined cells' faces with neighbors
    onStatus('Reconciling face consistency...');
    reconcile(chunk, imageData, width, bbox, maxDepth, scale, onStatus);

    // Compute stats
    const stats = computeStats(chunk);
    onStatus(`✓ Done: ${stats.leafCells} leaf cells, ${stats.refinedCells} refined, max depth ${stats.maxDepthUsed}`);

    return { chunk, bbox, stats };
}

/**
 * Build cells for one level of the SPP tree.
 *
 * @param {ImageData} imageData
 * @param {number} imgW — image width
 * @param {Object} pixelBounds — { x, y, w, h } in image pixel coords (this level covers this region)
 * @param {number} gridX — number of columns at this level
 * @param {number} gridZ — number of rows at this level
 * @param {number} depth — current recursion depth
 * @param {number} maxDepth
 * @param {number} scale — refinement subdivision factor
 * @param {Function} onStatus
 * @returns {Array} cells at this level
 */
function buildLevel(imageData, imgW, pixelBounds, gridX, gridZ, depth, maxDepth, scale, onStatus, parentFaceOptions) {
    const cellW = pixelBounds.w / gridX;
    const cellH = pixelBounds.h / gridZ;

    // Step 1: Determine which cells exist (multi-point area sampling)
    // Use a 3×3 grid of sample points within each cell to catch narrow shapes
    // where center-only sampling would miss (e.g., T-shape stems, Cross arms)
    const existingCells = new Map(); // "x,z" → { px, py, pw, ph }
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const px = pixelBounds.x + x * cellW;
            const py = pixelBounds.y + z * cellH;

            // Sample 16 points (4×4 grid) within the cell for higher precision
            let insideCount = 0;
            const samplePoints = 4;
            for (let sy = 0; sy < samplePoints; sy++) {
                for (let sx = 0; sx < samplePoints; sx++) {
                    const sampleX = px + (sx + 0.5) / samplePoints * cellW;
                    const sampleY = py + (sy + 0.5) / samplePoints * cellH;
                    if (isInsideShape(imageData, imgW, sampleX, sampleY)) {
                        insideCount++;
                    }
                }
            }

            // Existence threshold: if at least 1 point is inside → cell exists
            // We'd rather have extra cells (which will have Walls) than holes (which create internal walls)
            if (insideCount >= 1) {
                existingCells.set(`${x},${z}`, { px, py, pw: cellW, ph: cellH });
            }
        }
    }

    // Step 2: For each existing cell, classify its faces via line scanning
    const cells = [];
    for (const [key, bounds] of existingCells) {
        const [x, z] = key.split(',').map(Number);

        const { faceOptions, needsRefinement } = classifyFaces(
            imageData, imgW, bounds, existingCells, x, z, gridX, gridZ, parentFaceOptions
        );

        const cell = {
            position: [x, 0, z],
            size: [1, 1, 1],
            faceStates: 0b111111,
            room: 'Shape',
            faceOptions,
        };

        // Step 3: If faces are ambiguous and we haven't hit max depth, refine
        if (needsRefinement && depth < maxDepth) {
            const subCells = buildLevel(
                imageData, imgW,
                { x: bounds.px, y: bounds.py, w: bounds.pw, h: bounds.ph },
                scale, scale,
                depth + 1, maxDepth, scale,
                onStatus,
                faceOptions  // pass this cell's faceOptions so children can inherit
            );
            if (subCells.length > 0) {
                cell.refinement = {
                    gridX: scale,
                    gridZ: scale,
                    cells: subCells,
                };
            }
        }

        cells.push(cell);
    }

    return cells;
}

/**
 * Compute reconstruction statistics.
 */
function computeStats(chunk) {
    let leafCells = 0;
    let refinedCells = 0;
    let maxDepthUsed = 0;

    function walk(cells, depth) {
        for (const c of cells) {
            if (c.refinement && c.refinement.cells.length > 0) {
                refinedCells++;
                walk(c.refinement.cells, depth + 1);
            } else {
                leafCells++;
                if (depth > maxDepthUsed) maxDepthUsed = depth;
            }
        }
    }
    walk(chunk.cells, 0);

    return { leafCells, refinedCells, maxDepthUsed };
}

// ─── Opposite face mapping ─────────────────────────────────────
const OPPOSITE_FACE = { 0: 1, 1: 0, 4: 5, 5: 4 };

// ─── Face neighbor offset ──────────────────────────────────────
function faceNeighborOffset(fi) {
    if (fi === 0) return [1, 0];   // +X → neighbor at x+1
    if (fi === 1) return [-1, 0];  // -X → neighbor at x-1
    if (fi === 4) return [0, -1];  // +Z → neighbor at z-1
    if (fi === 5) return [0, 1];   // -Z → neighbor at z+1
    return [0, 0];
}

/**
 * Post-processing back-propagation.
 *
 * For each refined cell at the root level:
 *   1. Collect the face states of sub-cells along each edge
 *   2. Aggregate to determine the "true" parent face state
 *   3. Update the neighbor's corresponding face to match
 *   4. If neighbor becomes inconsistent, refine it too
 */
function reconcile(chunk, imageData, imgW, bbox, maxDepth, scale, onStatus) {
    reconcileChunk(chunk);

    function reconcileChunk(chunk) {
        const cells = chunk.cells;
        if (!cells || cells.length === 0) return;

        // Build lookup map: "x,z" → cell
        const cellMap = new Map();
        for (const cell of cells) {
            const key = `${cell.position[0]},${cell.position[2]}`;
            cellMap.set(key, cell);
        }

        // 1. Reconcile internal boundaries at THIS Level
        for (const cell of cells) {
            for (const fi of [0, 1, 4, 5]) {
                const [dx, dz] = faceNeighborOffset(fi);
                const nx = cell.position[0] + dx;
                const nz = cell.position[2] + dz;
                const neighbor = cellMap.get(`${nx},${nz}`);

                if (neighbor) {
                    // Force OPEN between neighbors at this Level
                    cell.faceOptions[fi] = [0];
                    const oppFi = OPPOSITE_FACE[fi];
                    neighbor.faceOptions[oppFi] = [0];

                    // Cross-reconcile sub-cells on the shared edge
                    const cellRefined = cell.refinement && cell.refinement.cells.length;
                    const neighborRefined = neighbor.refinement && neighbor.refinement.cells.length;

                    if (cellRefined || neighborRefined) {
                        syncSharedBoundary(cell, neighbor, fi);
                    }
                }
            }

            // 2. Recursively reconcile sub-cells WITHIN this cell
            if (cell.refinement && cell.refinement.cells.length > 0) {
                reconcileChunk(cell.refinement);
            }
        }
    }

    // Sync sub-cells across the shared boundary of two neighbors
    function syncSharedBoundary(c1, c2, f1) {
        const f2 = OPPOSITE_FACE[f1];
        const r1 = c1.refinement;
        const r2 = c2.refinement;

        if (r1 && r1.cells.length) {
            const m1 = new Map();
            for (const sc of r1.cells) m1.set(`${sc.position[0]},${sc.position[2]}`, sc);
            const edge1 = getEdgeSubCells(r1, m1, f1);
            for (const sc of edge1) {
                if (sc.faceOptions) sc.faceOptions[f1] = [0];
            }
        }

        if (r2 && r2.cells.length) {
            const m2 = new Map();
            for (const sc of r2.cells) m2.set(`${sc.position[0]},${sc.position[2]}`, sc);
            const edge2 = getEdgeSubCells(r2, m2, f2);
            for (const sc of edge2) {
                if (sc.faceOptions) sc.faceOptions[f2] = [0];
            }
        }

        // If BOTH are refined, we need to recursively sync their edge sub-cells
        if (r1 && r1.cells.length && r2 && r2.cells.length) {
            // This is complex for 3D but simple for 2D orthogonal:
            // sub-cells at the edge of R1 are neighbors of sub-cells at the edge of R2.
            const m1 = new Map();
            for (const sc of r1.cells) m1.set(`${sc.position[0]},${sc.position[2]}`, sc);
            const m2 = new Map();
            for (const sc of r2.cells) m2.set(`${sc.position[0]},${sc.position[2]}`, sc);

            const edge1 = getEdgeSubCells(r1, m1, f1);
            const edge2 = getEdgeSubCells(r2, m2, f2);

            // They are guaranteed to be the same length (scale) and align perfectly
            for (let i = 0; i < edge1.length; i++) {
                const sc1 = edge1[i];
                const sc2 = edge2[i];
                if (sc1 && sc2) {
                    sc1.faceOptions[f1] = [0];
                    sc2.faceOptions[f2] = [0];
                    syncSharedBoundary(sc1, sc2, f1); // Recursive sync for deeper levels
                }
            }
        }
    }
}

/**
 * Get sub-cells along a specific edge of a refinement grid.
 *
 * face 0 (+X): sub-cells at x = gridX-1, all z
 * face 1 (-X): sub-cells at x = 0, all z
 * face 4 (+Z): sub-cells at z = 0, all x
 * face 5 (-Z): sub-cells at z = gridZ-1, all x
 */
function getEdgeSubCells(sub, subMap, faceIndex) {
    const gx = sub.gridX;
    const gz = sub.gridZ;
    const result = [];

    const minX = 0;
    const maxX = gx - 1;
    const minZ = 0;
    const maxZ = gz - 1;

    if (faceIndex === 0) { // +X (Right)
        for (let z = minZ; z <= maxZ; z++) {
            result.push(subMap.get(`${maxX},${z}`) || null);
        }
    } else if (faceIndex === 1) { // -X (Left)
        for (let z = minZ; z <= maxZ; z++) {
            result.push(subMap.get(`${minX},${z}`) || null);
        }
    } else if (faceIndex === 4) { // +Z (Top)
        for (let x = minX; x <= maxX; x++) {
            result.push(subMap.get(`${x},${minZ}`) || null);
        }
    } else if (faceIndex === 5) { // -Z (Bottom)
        for (let x = minX; x <= maxX; x++) {
            result.push(subMap.get(`${x},${maxZ}`) || null);
        }
    }

    return result;
}
