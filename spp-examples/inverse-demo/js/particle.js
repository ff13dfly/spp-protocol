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

/**
 * Expand cells with scale > 1 into flat sub-cell array.
 * Non-scaled cells pass through unchanged.
 * Scaled cells produce n×n sub-cells with fractional positions.
 *
 * @param {Array} cells - array of cell objects (some may have .scale and .subCells)
 * @returns {Array} flat array of cells (all scale=1 effective)
 */
export function expandScaledCells(cells) {
    const result = [];

    for (const cell of cells) {
        const n = cell.scale || 1;
        if (n <= 1 || !cell.subCells) {
            // Normal cell — pass through
            result.push(cell);
            continue;
        }

        // Expand: parent at [px, 0, pz] with scale=n
        // Sub-cell [sx, sz] gets position [px + (sx - (n-1)/2) / n * ... ]
        // We use fractional positions: sub [sx,sz] → [px - 0.5 + (sx+0.5)/n, 0, pz - 0.5 + (sz+0.5)/n]
        // This places sub-cells within the parent's footprint
        const [px, py, pz] = cell.position;

        for (const sc of cell.subCells) {
            const [sx, sz] = sc.sub;
            const fracX = px - 0.5 + (sx + 0.5) / n;
            const fracZ = pz - 0.5 + (sz + 0.5) / n;

            result.push({
                position: [fracX, py, fracZ],
                room: sc.room,
                faceOptions: sc.faceOptions,
                _parentScale: n,        // renderer uses this for sizing
                _parentPos: [px, pz],   // for debugging
                _subPos: [sx, sz],
            });
        }
    }

    return result;
}

/**
 * Generate cells and face options from a 2D layout array and a list of doors.
 * @param {Array<Array<string|null>>} layout - 2D layout grid (z, x)
 * @param {number} gridX - Width of grid
 * @param {number} gridZ - Height of grid
 * @param {Array<Object>} doors - List of door objects {x1, z1, x2, z2}
 * @returns {Array<Object>} List of cell objects
 */
export function generateCellsFromLayout(layout, gridX, gridZ, doors) {
    const doorSet = new Set();
    for (const d of doors || []) {
        doorSet.add(`${d.x1},${d.z1}->${d.x2},${d.z2}`);
        doorSet.add(`${d.x2},${d.z2}->${d.x1},${d.z1}`);
    }
    function hasDoor(x1, z1, x2, z2) {
        return doorSet.has(`${x1},${z1}->${x2},${z2}`);
    }
    const windowRooms = new Set(['Kitchen', 'Living Room', 'Bedroom']);
    function faceValue(x, z, nx, nz) {
        const room = layout[z]?.[x];
        const neighbor = layout[nz]?.[nx];
        if (nx < 0 || nx >= gridX || nz < 0 || nz >= gridZ || !neighbor) {
            return windowRooms.has(room) ? [20] : [10];
        }
        if (room === neighbor) return [0];
        if (hasDoor(x, z, nx, nz)) return [2];
        return [10];
    }
    const cells = [];
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const room = layout[z]?.[x];
            if (!room) continue;
            cells.push({
                position: [x, 0, z],
                room,
                faceOptions: [
                    faceValue(x, z, x + 1, z),  // +X
                    faceValue(x, z, x - 1, z),  // -X
                    [],                           // +Y
                    [],                           // -Y
                    faceValue(x, z, x, z - 1),  // +Z (top of image)
                    faceValue(x, z, x, z + 1),  // -Z (bottom of image)
                ],
            });
        }
    }
    return cells;
}

/**
 * Data restructuring layer for multi-resolution grid optimization.
 * Expands a low-res base layout into a high-res fine layout, applies localized
 * fine-grained room overrides, scales doors, and recalculates all face options.
 * 
 * @param {Array<Array<string|null>>} baseLayout - The original low-res layout
 * @param {number} scale - Expansion factor (e.g., 2)
 * @param {Array<Object>} cellModifications - Fine-grained room overrides
 *        Format: [{ basePos: [bx, bz], subPos: [sx, sz], room: 'Room Name' }]
 * @param {Array<Object>} baseDoors - Door definitions at base scale
 * @returns {Object} { fineLayout, cells, gridX, gridZ }
 */
export function optimizeGrid(baseLayout, scale, cellModifications, baseDoors) {
    if (scale <= 1) {
        const gridX = baseLayout[0]?.length || 0;
        const gridZ = baseLayout.length;
        const cells = generateCellsFromLayout(baseLayout, gridX, gridZ, baseDoors);
        return { fineLayout: baseLayout, cells, gridX, gridZ };
    }

    const baseZ = baseLayout.length;
    const baseX = baseLayout[0]?.length || 0;
    const fineZ = baseZ * scale;
    const fineX = baseX * scale;

    // 1. Expand base layout into fine layout
    const fineLayout = [];
    for (let fz = 0; fz < fineZ; fz++) {
        const row = [];
        for (let fx = 0; fx < fineX; fx++) {
            const bx = Math.floor(fx / scale);
            const bz = Math.floor(fz / scale);
            row.push(baseLayout[bz]?.[bx] || null);
        }
        fineLayout.push(row);
    }

    // 2. Apply localized room modifications (sub-cell overrides)
    for (const mod of cellModifications || []) {
        const [bx, bz] = mod.basePos;
        const [sx, sz] = mod.subPos;
        const fx = bx * scale + sx;
        const fz = bz * scale + sz;
        if (fineLayout[fz] && fineLayout[fz][fx] !== undefined) {
            fineLayout[fz][fx] = mod.room;
        }
    }

    // 3. Scale up door coordinates
    // A base door spans 1 base cell edge. In fine grid, it spans `scale` fine cell edges.
    const fineDoors = [];
    for (const d of baseDoors || []) {
        // Find which axis the door aligns with
        if (d.x1 === d.x2) {
            // Door on X axis (Z changes)
            // e.g., (3,2) -> (4,2). The boundary is between X=3 and X=4.
            // In fine grid (scale=2), boundary is between X=6..7 and X=8..9.
            // Wait, looking at main.js mock: base (3,2)->(4,2) became (7,4)->(8,4) and (7,5)->(8,5)
            // Base boundary is at max(x1,x2). Here x1=3, x2=4.
            const minX = Math.min(d.x1, d.x2) * scale + (scale - 1); // e.g. 3*2+1 = 7
            const maxX = Math.max(d.x1, d.x2) * scale;             // e.g. 4*2 = 8
            const minZ = Math.min(d.z1, d.z2) * scale;
            for (let sz = 0; sz < scale; sz++) {
                fineDoors.push({ x1: minX, z1: minZ + sz, x2: maxX, z2: minZ + sz });
            }
        } else if (d.z1 === d.z2) {
            // Door on Z axis
            const minZ = Math.min(d.z1, d.z2) * scale + (scale - 1);
            const maxZ = Math.max(d.z1, d.z2) * scale;
            const minX = Math.min(d.x1, d.x2) * scale;
            for (let sx = 0; sx < scale; sx++) {
                fineDoors.push({ x1: minX + sx, z1: minZ, x2: minX + sx, z2: maxZ });
            }
        }
    }

    // 4. Generate cells using the uniform fine grid
    const cells = generateCellsFromLayout(fineLayout, fineX, fineZ, fineDoors);

    // 5. Mark cells so renderer sizes and spaces them correctly
    for (const cell of cells) {
        cell._parentScale = scale;
        cell._isFineGrid = true;
    }

    return { fineLayout, cells, gridX: fineX, gridZ: fineZ };
}

