/**
 * face-scanner.js — SPP Face-level line scanning
 *
 * Core operation: scan pixels along each face boundary LINE to classify
 * each face as Open(0), Wall(10), or AMBIGUOUS (needs refinement).
 *
 * This is the SPP inverse modeling operation — face classification from observation.
 */

// ─── Pixel classification ────────────────────────────────────

/**
 * Classify a single pixel.
 * @returns {'shape'|'outline'|'background'}
 */
function classifyPixel(r, g, b) {
    // Black outline (part of the shape boundary)
    // Be more tolerant of anti-aliasing or slight variations
    if (r < 100 && g < 100 && b < 100) return 'outline';
    // White background
    if (r > 200 && g > 200 && b > 200) return 'background';
    // Light blue fill (shape interior)
    // Use a slightly more flexible check for blue-ish color
    if (b > 120 && (b > r - 15) && (b > g - 15)) return 'shape';
    // Fallback: if blue-ish, shape; otherwise background
    return (b > r + 10) ? 'shape' : 'background';
}

/**
 * Check if a single pixel coordinate is inside the shape.
 */
export function isInsideShape(imageData, imgW, x, y) {
    if (x < 0 || y < 0 || x >= imgW || y >= imageData.height) return false;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const i = (iy * imgW + ix) * 4;
    const cls = classifyPixel(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
    return cls === 'shape' || cls === 'outline';
}

// ─── Face line scanning ──────────────────────────────────────

/**
 * Scan pixels along a face boundary line and classify the face.
 *
 * The line is defined by two endpoints in pixel coordinates.
 * We sample K points along it and look at what's there.
 *
 * @param {ImageData} imageData
 * @param {number} imgW — image width
 * @param {number} x1,y1,x2,y2 — line endpoints (pixels)
 * @param {number} K — number of sample points
 * @returns {'open'|'wall'|'ambiguous'|'external'}
 */
export function scanFaceLine(imageData, imgW, x1, y1, x2, y2, K = 48) {
    const data = imageData.data;
    let outlineCount = 0;
    let shapeCount = 0;
    let bgCount = 0;

    for (let i = 0; i < K; i++) {
        const t = (i + 0.5) / K; // sample at center of each segment
        const px = Math.floor(x1 + (x2 - x1) * t);
        const py = Math.floor(y1 + (y2 - y1) * t);

        if (px < 0 || py < 0 || px >= imgW || py >= imageData.height) {
            bgCount++;
            continue;
        }

        const idx = (py * imgW + px) * 4;
        const cls = classifyPixel(data[idx], data[idx + 1], data[idx + 2]);

        if (cls === 'outline') outlineCount++;
        else if (cls === 'shape') shapeCount++;
        else bgCount++;
    }

    const total = K;
    const outlineRatio = outlineCount / total;
    const shapeRatio = shapeCount / total;
    const bgRatio = bgCount / total;

    // Case 1: Line lies entirely inside shape → Open
    // Stronger shape check
    if (shapeRatio > 0.80 && bgRatio < 0.05) return 'open';

    // Case 2: Line lies entirely outside shape → External
    if (bgRatio > 0.85 && shapeRatio < 0.05) return 'external';

    // Case 3: Line coincides with outline → Wall
    // Outline ratio threshold: 0.12 (even lower to catch thinner outlines)
    if (outlineRatio > 0.12) return 'wall';

    // Case 4: Ambiguous - mix of colors or faint outline
    if ((shapeRatio > 0.05 && bgRatio > 0.05) || (outlineRatio > 0.02)) {
        return 'ambiguous';
    }

    // Default fallbacks
    if (shapeRatio > bgRatio) return 'open';
    return 'external';
}

/**
 * Compute the 4 face line endpoints (in pixel coords) for a cell.
 *
 * @param {Object} cellPixelBounds — { px, py, pw, ph } in image pixels
 * @returns {Object} keyed by face index (0,1,4,5), values = {x1,y1,x2,y2}
 */
export function getFaceLines(cellPixelBounds) {
    const { px, py, pw, ph } = cellPixelBounds;
    return {
        0: { x1: px + pw, y1: py,      x2: px + pw, y2: py + ph }, // +X (right edge, vertical)
        1: { x1: px,      y1: py,      x2: px,      y2: py + ph }, // -X (left edge, vertical)
        4: { x1: px,      y1: py,      x2: px + pw, y2: py      }, // +Z (top edge, horizontal)
        5: { x1: px,      y1: py + ph, x2: px + pw, y2: py + ph }, // -Z (bottom edge, horizontal)
    };
}

/**
 * Classify all 4 horizontal faces of a cell by scanning face lines.
 *
 * @param {ImageData} imageData
 * @param {number} imgW
 * @param {Object} cellPixelBounds — { px, py, pw, ph }
 * @param {Map} neighborExists — Set of "x,z" keys for cells that exist at this level
 * @param {number} x — cell grid x
 * @param {number} z — cell grid z
 * @returns {Object} { faceOptions: [[id],...], needsRefinement: boolean }
 */
export function classifyFaces(imageData, imgW, cellPixelBounds, neighborExists, x, z, gridX, gridZ, parentFaceOptions) {
    const lines = getFaceLines(cellPixelBounds);
    const faceOptions = [null, null, [], [], null, null]; // +X, -X, +Y, -Y, +Z, -Z
    let needsRefinement = false;

    const faceIndices = [0, 1, 4, 5]; // only horizontal faces

    for (const fi of faceIndices) {
        const line = lines[fi];
        const result = scanFaceLine(imageData, imgW, line.x1, line.y1, line.x2, line.y2);

        // Determine neighbor position
        const dx = fi === 0 ? 1 : fi === 1 ? -1 : 0;
        const dz = fi === 4 ? -1 : fi === 5 ? 1 : 0;
        const neighborKey = `${x + dx},${z + dz}`;
        const hasNeighbor = neighborExists.has(neighborKey);

        // ── DUAL-SIDE CHECK ──
        // If both this cell and its neighbor exist (both centers are inside the shape),
        // then this face MUST be Open — the outline between two interior cells is just
        // the image's drawing artifact, not a real wall.
        if (hasNeighbor) {
            if (result === 'open') {
                faceOptions[fi] = [0];
            } else if (result === 'wall') {
                // Both sides are inside shape → outline on this line is a false positive
                faceOptions[fi] = [0]; // Force Open
            } else if (result === 'ambiguous') {
                // Both sides exist but face is ambiguous → likely an internal outline overlap
                faceOptions[fi] = [0];
                needsRefinement = true;
            } else {
                faceOptions[fi] = [0]; // Both sides exist → Open
            }
        } else {
            // No neighbor in this grid level
            // Check if this cell is on the edge of a refinement grid
            // and can inherit the parent cell's face state
            const isOnParentEdge = (
                (fi === 0 && x === gridX - 1) || // right edge → parent's +X face
                (fi === 1 && x === 0) ||          // left edge → parent's -X face
                (fi === 4 && z === 0) ||           // top edge → parent's +Z face
                (fi === 5 && z === gridZ - 1)      // bottom edge → parent's -Z face
            );

            if (isOnParentEdge && parentFaceOptions && parentFaceOptions[fi]) {
                // Inherit parent's face state for this edge
                faceOptions[fi] = [...parentFaceOptions[fi]];
            } else {
                // External boundary → Wall
                faceOptions[fi] = [10];
            }
        }
    }

    return { faceOptions, needsRefinement };
}

// ─── Image loading utility ───────────────────────────────────

/**
 * Load image → ImageData.
 */
export function loadImageData(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve({
                imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
                width: canvas.width,
                height: canvas.height,
                dataUrl: canvas.toDataURL('image/png'),
            });
        };
        img.onerror = () => reject(new Error(`Failed to load: ${src}`));
        img.src = src;
    });
}

/**
 * Find bounding box of non-white region in the image.
 */
export function findShapeBBox(imageData, w, h) {
    const data = imageData.data;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const cls = classifyPixel(data[i], data[i + 1], data[i + 2]);
            if (cls !== 'background') {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    const margin = Math.max(2, Math.floor(Math.min(w, h) * 0.01));
    return {
        x: Math.max(0, minX - margin),
        y: Math.max(0, minY - margin),
        w: Math.min(w, maxX - minX + 1 + margin * 2),
        h: Math.min(h, maxY - minY + 1 + margin * 2),
    };
}
