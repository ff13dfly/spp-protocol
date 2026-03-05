/**
 * grid-overlay.js — Draw grid lines + room labels over floor plan image
 * Supports optional crop region (grid only covers the floor plan area)
 */

// Room-name → color mapping (consistent hues)
const ROOM_COLORS = {};
const PALETTE = [
    'hsla(210, 70%, 55%, 0.25)',  // blue
    'hsla(140, 60%, 45%, 0.25)',  // green
    'hsla(30,  80%, 55%, 0.25)',  // orange
    'hsla(270, 60%, 55%, 0.25)',  // purple
    'hsla(350, 70%, 55%, 0.25)',  // red
    'hsla(180, 60%, 45%, 0.25)',  // teal
    'hsla(50,  80%, 50%, 0.25)',  // yellow
    'hsla(310, 60%, 50%, 0.25)',  // pink
];
let colorIdx = 0;

function roomColor(name) {
    if (!name) return 'hsla(0,0%,50%,0.1)';
    if (!ROOM_COLORS[name]) {
        ROOM_COLORS[name] = PALETTE[colorIdx % PALETTE.length];
        colorIdx++;
    }
    return ROOM_COLORS[name];
}

/**
 * Draw a grid overlay on a canvas positioned over the floor plan image.
 *
 * @param {HTMLCanvasElement} canvas — overlay canvas (same size as image)
 * @param {number} gridX — number of columns
 * @param {number} gridZ — number of rows
 * @param {string[][]} layout — 2D array [row][col] of room names (null = exterior)
 * @param {{ x: number, y: number, w: number, h: number }} [crop] — normalized crop region (0-1)
 */
export function drawGridOverlay(canvas, gridX, gridZ, layout, crop) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    // Compute pixel region for the grid
    const ox = crop ? crop.x * W : 0;       // origin X
    const oy = crop ? crop.y * H : 0;       // origin Y
    const rw = crop ? crop.w * W : W;       // region width
    const rh = crop ? crop.h * H : H;       // region height
    const cellW = rw / gridX;
    const cellH = rh / gridZ;

    ctx.clearRect(0, 0, W, H);

    // Reset color assignments for consistency
    colorIdx = 0;
    for (const k in ROOM_COLORS) delete ROOM_COLORS[k];

    // Dim area outside crop with a subtle overlay
    if (crop) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
        // Top strip
        ctx.fillRect(0, 0, W, oy);
        // Bottom strip
        ctx.fillRect(0, oy + rh, W, H - oy - rh);
        // Left strip
        ctx.fillRect(0, oy, ox, rh);
        // Right strip
        ctx.fillRect(ox + rw, oy, W - ox - rw, rh);

        // Draw crop bounding box
        ctx.strokeStyle = 'rgba(50, 120, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(ox, oy, rw, rh);
        ctx.setLineDash([]);
    }

    // Fill cells with room colors
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const room = layout[z]?.[x];
            if (room) {
                ctx.fillStyle = roomColor(room);
                ctx.fillRect(ox + x * cellW, oy + z * cellH, cellW, cellH);
            }
        }
    }

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
    ctx.lineWidth = 1.5;

    for (let x = 0; x <= gridX; x++) {
        ctx.beginPath();
        ctx.moveTo(ox + x * cellW, oy);
        ctx.lineTo(ox + x * cellW, oy + rh);
        ctx.stroke();
    }
    for (let z = 0; z <= gridZ; z++) {
        ctx.beginPath();
        ctx.moveTo(ox, oy + z * cellH);
        ctx.lineTo(ox + rw, oy + z * cellH);
        ctx.stroke();
    }

    // Draw room labels (small, centered in each cell)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.max(8, Math.min(14, cellW / 5));
    ctx.font = `bold ${fontSize}px sans-serif`;

    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            const room = layout[z]?.[x];
            if (room) {
                const cx = ox + x * cellW + cellW / 2;
                const cy = oy + z * cellH + cellH / 2;

                // Background for readability
                const tm = ctx.measureText(room);
                ctx.fillStyle = 'rgba(255,255,255,0.75)';
                ctx.fillRect(cx - tm.width / 2 - 2, cy - fontSize / 2 - 1, tm.width + 4, fontSize + 2);

                ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
                ctx.fillText(room, cx, cy);
            }
        }
    }

    // Draw coordinates (tiny, top-left of cell)
    ctx.fillStyle = 'rgba(255, 60, 60, 0.6)';
    ctx.font = `${Math.max(7, fontSize - 3)}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            ctx.fillText(`${x},${z}`, ox + x * cellW + 2, oy + z * cellH + 2);
        }
    }
}
