/**
 * reconstruct-real.mjs
 *
 * Best-effort reconstruction of the REAL colored render assets/floorplan.png
 * (1390×1010) — the furnished marketing image the Qwen-VL pipeline targets and
 * fails on. Perception (rooms, walls, doors, windows) was read by hand through
 * the furniture by a vision model; wall topology produced by the genuine
 * generateCellsFromLayout() engine. APPROXIMATE — unlike the clean mock, a
 * furnished render has occluded walls and open-plan ambiguity.
 *
 * Output (gitignored): recon-out/real-topdown.png, recon-out/real-cells.json
 * Run:  node scripts/reconstruct-real.mjs
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

const MB = 'Master Bedroom', B2 = 'Bedroom 2', BA = 'Bathroom', LV = 'Living Room',
      DN = 'Dining', KT = 'Kitchen', BC = 'Balcony', HW = 'Hallway';
// 10 cols × 7 rows — central hallway (col 4)
const layout = [
  [MB, MB, MB, MB, HW, B2, B2, B2, B2, B2],
  [MB, MB, MB, MB, HW, B2, B2, B2, B2, B2],
  [MB, MB, MB, MB, HW, BA, BA, BA, B2, B2],
  [BC, LV, LV, LV, HW, BA, BA, BA, BA, BA],
  [BC, LV, LV, LV, HW, DN, DN, KT, KT, KT],
  [BC, LV, LV, LV, HW, DN, DN, KT, KT, KT],
  [LV, LV, LV, LV, HW, DN, DN, KT, KT, KT],
];
const gridZ = layout.length, gridX = layout[0].length;
const doors = [
  { x1: 3, z1: 1, x2: 4, z2: 1 },   // Master Bedroom ↔ Hallway
  { x1: 4, z1: 1, x2: 5, z2: 1 },   // Hallway ↔ Bedroom 2
  { x1: 4, z1: 2, x2: 5, z2: 2 },   // Hallway ↔ Bathroom
  { x1: 0, z1: 4, x2: 1, z2: 4 },   // Balcony ↔ Living Room
  { x1: 3, z1: 4, x2: 4, z2: 4 },   // Living Room ↔ Hallway
  { x1: 6, z1: 4, x2: 7, z2: 4 },   // Dining ↔ Kitchen
];
const windows = [[1, 0, NEG_Z], [7, 0, NEG_Z], [1, 6, POS_Z], [6, 6, POS_Z], [9, 5, POS_X], [0, 4, NEG_X]];
const entrance = { x: 4, z: 6, face: POS_Z };

const cells = generateCellsFromLayout(layout, gridX, gridZ, doors);
const at = (x, z) => cells.find(c => c.position[0] === x && c.position[2] === z);
const isExt = (x, z, f) => { const n = { [POS_X]: [x + 1, z], [NEG_X]: [x - 1, z], [POS_Z]: [x, z + 1], [NEG_Z]: [x, z - 1] }[f]; return n[0] < 0 || n[0] >= gridX || n[1] < 0 || n[1] >= gridZ || !layout[n[1]]?.[n[0]]; };
for (const c of cells) { const [x, , z] = c.position; for (const f of [POS_X, NEG_X, POS_Z, NEG_Z]) if (isExt(x, z, f) && c.faceOptions[f][0] === 20) c.faceOptions[f] = [10]; }
for (const [x, z, f] of windows) { const c = at(x, z); if (c) c.faceOptions[f] = [20]; }
{ const c = at(entrance.x, entrance.z); if (c) c.faceOptions[entrance.face] = [2]; }
fs.writeFileSync(path.join(OUT, 'real-cells.json'), JSON.stringify({ gridX, gridZ, layout, doors, cells }, null, 2));

const COL = { 'Master Bedroom': '#f3dce6', 'Bedroom 2': '#f7d9d0', Bathroom: '#cfe9f3', 'Living Room': '#e6f3d8', Dining: '#fdeecb', Kitchen: '#fde9c8', Balcony: '#d8efd0', Hallway: '#eeeeee' };
const isWall = id => OPTION_REGISTRY[id]?.type === 'wall' && id !== 20, isWin = id => id === 20, isDoor = id => id === 1 || id === 2;
const CELL = 72, PAD = 44, W = gridX * CELL + PAD * 2, Hh = gridZ * CELL + PAD * 2;
const cv = createCanvas(W, Hh), ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, Hh);
const px = x => PAD + x * CELL, py = z => PAD + z * CELL;
for (const c of cells) { const [x, , z] = c.position; ctx.fillStyle = COL[c.room] || '#f3f3f3'; ctx.fillRect(px(x), py(z), CELL, CELL); }
const done = new Set();
for (const c of cells) {
  if (done.has(c.room)) continue; const s = cells.filter(o => o.room === c.room);
  const cx = s.reduce((a, o) => a + o.position[0], 0) / s.length, cz = s.reduce((a, o) => a + o.position[2], 0) / s.length;
  ctx.fillStyle = '#333'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.room.toUpperCase(), px(cx) + CELL / 2, py(cz) + CELL / 2); done.add(c.room);
}
const edge = (x, z, f) => f === POS_X ? [px(x + 1), py(z), px(x + 1), py(z + 1)] : f === NEG_X ? [px(x), py(z), px(x), py(z + 1)] : f === POS_Z ? [px(x), py(z + 1), px(x + 1), py(z + 1)] : [px(x), py(z), px(x + 1), py(z)];
for (const c of cells) {
  const [x, , z] = c.position;
  for (const f of [POS_X, NEG_X, POS_Z, NEG_Z]) {
    const id = c.faceOptions[f][0]; if (id === 0 || id === undefined) continue; const [x1, y1, x2, y2] = edge(x, z, f);
    if (isDoor(id)) { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2; ctx.strokeStyle = '#111'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (mx - x1) * .45, y1 + (my - y1) * .45); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 + (mx - x2) * .45, y2 + (my - y2) * .45); ctx.stroke(); ctx.strokeStyle = '#b5651d'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x1 + (mx - x1) * .45, y1 + (my - y1) * .45); ctx.lineTo(x2 + (mx - x2) * .45, y2 + (my - y2) * .45); ctx.stroke(); }
    else if (isWin(id)) { ctx.strokeStyle = '#2b8fd6'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    else if (isWall(id)) { ctx.strokeStyle = '#111'; ctx.lineWidth = 7; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  }
}
fs.writeFileSync(path.join(OUT, 'real-topdown.png'), cv.toBuffer('image/png'));
console.log(`reconstructed ${cells.length} cells (approximate); wrote ${OUT}/{real-topdown.png,real-cells.json}`);
