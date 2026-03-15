/**
 * regression.js — Phase 5 top-view regression
 *
 * Responsibilities:
 *   1. compareWithSource()       — diff rendered top-view against source image, per-cell
 *   2. cropToCells()             — crop source image to the pixel region of a cell set
 *   3. extractConstraints()      — extract Open/Wall connectivity for the 4 boundary edges
 *   4. groupDivergentRegions()   — BFS-group adjacent divergent cells into regions
 */

import { RecursiveGridManager } from './shim.js';

const DIFF_THRESHOLD = 40;   // avg per-channel pixel diff threshold (0–255)
const CELL_PX = 32;          // pixels per cell when comparing

export class RegressionEngine {

    /**
     * Diff the rendered top-view against the (cropped) source image, per cell.
     *
     * @param {string} topViewDataUrl   - from renderer.renderTopView()
     * @param {string} sourceDataUrl    - original floor plan (full image)
     * @param {Object} cropInfo         - { x, y, w, h } from Phase 1
     * @param {Object} gridInfo         - { gridX, gridZ }
     * @returns {Promise<Array<{gx,gz}>>} divergent cell coordinates
     */
    async compareWithSource(topViewDataUrl, sourceDataUrl, cropInfo, gridInfo) {
        const { gridX, gridZ } = gridInfo;
        const W = gridX * CELL_PX;
        const H = gridZ * CELL_PX;

        // Load and resize both images to W×H
        const [topCanvas, srcCanvas] = await Promise.all([
            this._loadAndResize(topViewDataUrl, W, H),
            this._loadCropResize(sourceDataUrl, cropInfo, W, H),
        ]);

        const topCtx = topCanvas.getContext('2d');
        const srcCtx = srcCanvas.getContext('2d');

        const divergent = [];

        for (let gz = 0; gz < gridZ; gz++) {
            for (let gx = 0; gx < gridX; gx++) {
                const px = gx * CELL_PX;
                const py = gz * CELL_PX;

                const topData = topCtx.getImageData(px, py, CELL_PX, CELL_PX).data;
                const srcData = srcCtx.getImageData(px, py, CELL_PX, CELL_PX).data;

                if (this._avgColorDiff(topData, srcData) > DIFF_THRESHOLD) {
                    divergent.push({ gx, gz });
                }
            }
        }

        return divergent;
    }

    /**
     * Crop the source image to the pixel region covered by the given cells.
     * Used to supply a sub-image for local Phase 1-4 AI calls.
     *
     * @param {string} sourceDataUrl
     * @param {Object} cropInfo          - { x, y, w, h } normalized (from Phase 1)
     * @param {Object} gridInfo          - { gridX, gridZ }
     * @param {Array}  selectedCells     - ParticleCells with position field
     * @returns {Promise<string>}        - cropped data URL
     */
    async cropToCells(sourceDataUrl, cropInfo, gridInfo, selectedCells) {
        const { gridX, gridZ } = gridInfo;

        const xs = selectedCells.map(c => c.position[0]);
        const zs = selectedCells.map(c => c.position[2]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minZ = Math.min(...zs), maxZ = Math.max(...zs);

        // Region bounds as fraction of the grid
        const regionLeft   = minX       / gridX;
        const regionTop    = minZ       / gridZ;
        const regionRight  = (maxX + 1) / gridX;
        const regionBottom = (maxZ + 1) / gridZ;

        // Combined crop: cropInfo is the floor plan region within the source image;
        // regionLeft/Top/Right/Bottom is the cell region within that floor plan.
        const subCrop = {
            x: cropInfo.x + cropInfo.w * regionLeft,
            y: cropInfo.y + cropInfo.h * regionTop,
            w: cropInfo.w * (regionRight  - regionLeft),
            h: cropInfo.h * (regionBottom - regionTop),
        };

        return this._cropDataUrl(sourceDataUrl, subCrop);
    }

    /**
     * Extract Open/Wall connectivity for the 4 boundary edges of the selection.
     * Delegates to RecursiveGridManager.createBatchRefineContext.
     *
     * @param {Array} selectedCells
     * @returns {{ left, right, top, bottom: 'open'|'wall' }}
     */
    extractConstraints(selectedCells) {
        return RecursiveGridManager.createBatchRefineContext(selectedCells).constraints;
    }

    /**
     * BFS flood-fill adjacent divergent cells into contiguous regions.
     *
     * @param {Array<{gx,gz}>} divergentCoords
     * @param {Array}          rootCells
     * @param {Object}         gridInfo
     * @returns {Array<{ cells: ParticleCell[], parentLayout: string[][] }>}
     */
    groupDivergentRegions(divergentCoords, rootCells, gridInfo) {
        if (divergentCoords.length === 0) return [];

        const cellMap = new Map(rootCells.map(c => [`${c.position[0]},${c.position[2]}`, c]));

        const visited = new Set();
        const regions = [];

        for (const { gx, gz } of divergentCoords) {
            const key = `${gx},${gz}`;
            if (visited.has(key)) continue;

            const group = [];
            const queue = [{ gx, gz }];
            visited.add(key);

            while (queue.length > 0) {
                const { gx: cx, gz: cz } = queue.shift();
                const cell = cellMap.get(`${cx},${cz}`);
                if (cell) group.push(cell);

                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                    const nk = `${cx+dx},${cz+dz}`;
                    if (!visited.has(nk) && divergentCoords.some(d => d.gx === cx+dx && d.gz === cz+dz)) {
                        visited.add(nk);
                        queue.push({ gx: cx+dx, gz: cz+dz });
                    }
                }
            }

            if (group.length === 0) continue;

            // Build parentLayout from room names in the region
            const xs = group.map(c => c.position[0]);
            const zs = group.map(c => c.position[2]);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minZ = Math.min(...zs), maxZ = Math.max(...zs);
            const cols = maxX - minX + 1;
            const rows = maxZ - minZ + 1;
            const parentLayout = Array.from({ length: rows }, (_, rz) =>
                Array.from({ length: cols }, (_, rx) => {
                    const c = cellMap.get(`${minX + rx},${minZ + rz}`);
                    return c?.room || null;
                })
            );

            regions.push({ cells: group, parentLayout });
        }

        return regions;
    }

    // ─── Private helpers ──────────────────────────────────────

    _avgColorDiff(a, b) {
        let sum = 0;
        const n = Math.floor(a.length / 4);
        for (let i = 0; i < a.length; i += 4) {
            sum += Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);
        }
        return (sum / n) / 3;  // per-channel average
    }

    _loadAndResize(dataUrl, w, h) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(c);
            };
            img.src = dataUrl;
        });
    }

    _loadCropResize(dataUrl, cropInfo, w, h) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const sw = img.naturalWidth  * cropInfo.w;
                const sh = img.naturalHeight * cropInfo.h;
                const sx = img.naturalWidth  * cropInfo.x;
                const sy = img.naturalHeight * cropInfo.y;
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
                resolve(c);
            };
            img.src = dataUrl;
        });
    }

    _cropDataUrl(dataUrl, cropInfo) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const sw = img.naturalWidth  * cropInfo.w;
                const sh = img.naturalHeight * cropInfo.h;
                const c = document.createElement('canvas');
                c.width  = Math.max(1, Math.round(sw));
                c.height = Math.max(1, Math.round(sh));
                c.getContext('2d').drawImage(
                    img,
                    img.naturalWidth  * cropInfo.x,
                    img.naturalHeight * cropInfo.y,
                    sw, sh,
                    0, 0, c.width, c.height
                );
                resolve(c.toDataURL('image/png'));
            };
            img.src = dataUrl;
        });
    }
}
