/**
 * reconstruct-mock.mjs
 *
 * Reconstruct assets/mock-floorplan.png WITHOUT any external vision API.
 * The "perception" (room layout grid + doors + windows) was read directly off
 * the floor plan by a capable vision model (Claude) — this is the step the
 * Qwen-VL API kept failing at. The wall topology is then produced by the
 * GENUINE engine, generateCellsFromLayout() from spp-lib, identical to what the
 * demo runs. This is the data embedded in inverse-demo-v2/js/main.js buildMockData().
 *
 * Outputs (gitignored, see scripts/.gitignore):
 *   recon-out/mock-topdown.png  — top-down verification (compare to source)
 *   recon-out/mock-iso.png      — isometric 3D view
 *   recon-out/mock-cells.json   — SPP ParticleCell array
 *
 * Run:  node scripts/reconstruct-mock.mjs
 */
import { createCanvas } from 'canvas';
import { generateCellsFromLayout } from '../spp-lib/spp-inverse-engine.js';
import { OPTION_REGISTRY } from '../spp-lib/spp-core.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'recon-out');
fs.mkdirSync(OUT, { recursive: true });

const POS_X = 0, NEG_X = 1, POS_Z = 4, NEG_Z = 5;

// ── PERCEPTION (read off mock-floorplan.png by eye) — 7 cols × 6 rows ──────────
const K = 'Kitchen', B = 'Bathroom', H = 'Hallway', L = 'Living Room', D = 'Bedroom';
const layout = [
  [K, K, K, H, B, B, B],
  [K, K, K, H, B, B, B],
  [K, K, K, H, D, D, D],
  [L, L, L, H, D, D, D],
  [L, L, L, H, D, D, D],
  [L, L, L, L, D, D, D],
];
const gridZ = layout.length, gridX = layout[0].length;
const doors = [
  { x1: 2, z1: 2, x2: 3, z2: 2 },   // Kitchen ↔ Hallway
  { x1: 3, z1: 1, x2: 4, z2: 1 },   // Hallway ↔ Bathroom
  { x1: 3, z1: 3, x2: 4, z2: 3 },   // Hallway ↔ Bedroom
  { x1: 3, z1: 4, x2: 3, z2: 5 },   // Hallway ↔ Living Room
];
const windows = [
  [1, 0, NEG_Z], [5, 0, NEG_Z], [1, 5, POS_Z], [2, 5, POS_Z], [5, 5, POS_Z], [6, 3, POS_X],
];
const entrance = { x: 3, z: 0, face: NEG_Z };

// ── RECONSTRUCT (genuine engine) ───────────────────────────────────────────────
const cells = generateCellsFromLayout(layout, gridX, gridZ, doors);
const at = (x, z) => cells.find(c => c.position[0] === x && c.position[2] === z);
const isExt = (x, z, f) => {
  const n = { [POS_X]: [x + 1, z], [NEG_X]: [x - 1, z], [POS_Z]: [x, z + 1], [NEG_Z]: [x, z - 1] }[f];
  return n[0] < 0 || n[0] >= gridX || n[1] < 0 || n[1] >= gridZ || !layout[n[1]]?.[n[0]];
};
for (const c of cells) { const [x, , z] = c.position; for (const f of [POS_X, NEG_X, POS_Z, NEG_Z]) if (isExt(x, z, f) && c.faceOptions[f][0] === 20) c.faceOptions[f] = [10]; }
for (const [x, z, f] of windows) { const c = at(x, z); if (c) c.faceOptions[f] = [20]; }
{ const c = at(entrance.x, entrance.z); if (c) c.faceOptions[entrance.face] = [2]; }

fs.writeFileSync(path.join(OUT, 'mock-cells.json'), JSON.stringify({ gridX, gridZ, layout, doors, cells }, null, 2));

// ── RENDER ──────────────────────────────────────────────────────────────────────
const ROOM_COLOR = { Kitchen: '#fde9c8', Bathroom: '#cfe9f3', Hallway: '#eeeeee', 'Living Room': '#e6f3d8', Bedroom: '#f3dce6' };
const isWall = id => OPTION_REGISTRY[id]?.type === 'wall' && id !== 20;
const isWin = id => id === 20, isDoor = id => id === 1 || id === 2;

function renderTopDown() {
  const CELL = 84, PAD = 40, W = gridX * CELL + PAD * 2, Hh = gridZ * CELL + PAD * 2;
  const cv = createCanvas(W, Hh), ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, Hh);
  const px = x => PAD + x * CELL, py = z => PAD + z * CELL;
  for (const c of cells) { const [x, , z] = c.position; ctx.fillStyle = ROOM_COLOR[c.room] || '#f5f5f5'; ctx.fillRect(px(x), py(z), CELL, CELL); }
  const drawn = new Set();
  for (const c of cells) {
    if (drawn.has(c.room)) continue;
    const same = cells.filter(o => o.room === c.room);
    const cx = same.reduce((s, o) => s + o.position[0], 0) / same.length, cz = same.reduce((s, o) => s + o.position[2], 0) / same.length;
    ctx.fillStyle = '#333'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.room.toUpperCase(), px(cx) + CELL / 2, py(cz) + CELL / 2); drawn.add(c.room);
  }
  const edge = (x, z, f) => f === POS_X ? [px(x + 1), py(z), px(x + 1), py(z + 1)] : f === NEG_X ? [px(x), py(z), px(x), py(z + 1)] : f === POS_Z ? [px(x), py(z + 1), px(x + 1), py(z + 1)] : [px(x), py(z), px(x + 1), py(z)];
  for (const c of cells) {
    const [x, , z] = c.position;
    for (const f of [POS_X, NEG_X, POS_Z, NEG_Z]) {
      const id = c.faceOptions[f][0]; if (id === 0 || id === undefined) continue;
      const [x1, y1, x2, y2] = edge(x, z, f);
      if (isDoor(id)) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        ctx.strokeStyle = '#000'; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (mx - x1) * .45, y1 + (my - y1) * .45); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 + (mx - x2) * .45, y2 + (my - y2) * .45); ctx.stroke();
        ctx.strokeStyle = '#b5651d'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(x1 + (mx - x1) * .45, y1 + (my - y1) * .45); ctx.lineTo(x2 + (mx - x2) * .45, y2 + (my - y2) * .45); ctx.stroke();
      } else if (isWin(id)) { ctx.strokeStyle = '#2b8fd6'; ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      else if (isWall(id)) { ctx.strokeStyle = '#111'; ctx.lineWidth = 9; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    }
  }
  ctx.textAlign = 'left'; ctx.font = '13px sans-serif';
  [['#111', 'Wall'], ['#2b8fd6', 'Window'], ['#b5651d', 'Door']].forEach(([col, lab], i) => {
    ctx.fillStyle = col; ctx.fillRect(PAD + i * 110, Hh - PAD + 12, 22, 8);
    ctx.fillStyle = '#333'; ctx.fillText(lab, PAD + i * 110 + 28, Hh - PAD + 16);
  });
  fs.writeFileSync(path.join(OUT, 'mock-topdown.png'), cv.toBuffer('image/png'));
}

function renderIso() {
  const A = 46, Bb = 23, WALL = 70, WIN_TOP = 50, WIN_BASE = 22;
  const cv = createCanvas(1100, 820), ctx = cv.getContext('2d');
  ctx.fillStyle = '#f7f7fa'; ctx.fillRect(0, 0, cv.width, cv.height);
  const ox = 540, oy = 250, isoH = (x, y, z) => [ox + (x - z) * A, oy + (x + z) * Bb - y];
  const sorted = [...cells].sort((a, b) => (a.position[0] + a.position[2]) - (b.position[0] + b.position[2]));
  for (const c of sorted) {
    const [x, , z] = c.position; const p = [isoH(x, 0, z), isoH(x + 1, 0, z), isoH(x + 1, 0, z + 1), isoH(x, 0, z + 1)];
    ctx.beginPath(); ctx.moveTo(...p[0]); p.slice(1).forEach(q => ctx.lineTo(...q)); ctx.closePath();
    ctx.fillStyle = ROOM_COLOR[c.room] || '#eee'; ctx.fill(); ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = 1; ctx.stroke();
  }
  const corners = (x, z, f) => f === POS_X ? [[x + 1, z], [x + 1, z + 1]] : f === NEG_X ? [[x, z], [x, z + 1]] : f === POS_Z ? [[x, z + 1], [x + 1, z + 1]] : [[x, z], [x + 1, z]];
  const seen = new Set();
  for (const c of sorted) {
    const [x, , z] = c.position;
    for (const f of [NEG_Z, NEG_X, POS_X, POS_Z]) {
      const id = c.faceOptions[f][0]; if (id === 0 || id === undefined) continue;
      const ext = isExt(x, z, f);
      const [a, b] = corners(x, z, f); const key = [a, b].map(p => p.join(',')).sort().join('|');
      if (!ext && seen.has(key)) continue; seen.add(key);
      const top = isWin(id) ? WIN_TOP : WALL, base = isWin(id) ? WIN_BASE : 0;
      const colSide = id === 20 ? '#8fc3e6' : '#b8a079';
      if (isDoor(id)) { // header above opening
        const p1 = isoH(a[0], WALL * 0.78, a[1]), p2 = isoH(b[0], WALL * 0.78, b[1]), p3 = isoH(b[0], WALL, b[1]), p4 = isoH(a[0], WALL, a[1]);
        ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...p3); ctx.lineTo(...p4); ctx.closePath();
        ctx.fillStyle = colSide; ctx.fill(); ctx.strokeStyle = '#6b5a3a'; ctx.lineWidth = 1; ctx.stroke(); continue;
      }
      const p1 = isoH(a[0], base, a[1]), p2 = isoH(b[0], base, b[1]), p3 = isoH(b[0], top, b[1]), p4 = isoH(a[0], top, a[1]);
      ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...p3); ctx.lineTo(...p4); ctx.closePath();
      ctx.fillStyle = colSide; ctx.fill(); ctx.strokeStyle = '#6b5a3a'; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  fs.writeFileSync(path.join(OUT, 'mock-iso.png'), cv.toBuffer('image/png'));
}

renderTopDown(); renderIso();
console.log(`reconstructed ${cells.length} cells; wrote ${OUT}/{mock-topdown.png,mock-iso.png,mock-cells.json}`);
