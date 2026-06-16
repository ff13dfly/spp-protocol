/**
 * surface-fit-demo.mjs — minimal verification of the "connectivity as surface" idea.
 *
 * Question: can an SPP-style cell grid fit a smooth/organic surface by choosing
 * cell states, and how much does the per-cell FACE VOCABULARY matter?
 *
 * Same cell grid (the SPP container) is extracted two ways:
 *   BLOCKY  — emit the axis-aligned face between inside/outside cells.
 *             This is exactly today's open/wall flat-face vocabulary → staircase.
 *   NETS    — one geometric patch per boundary cell, vertex placed at the SDF
 *             zero-crossing (Surface Nets / dual-contouring lite). This is what an
 *             EXTENDED geometric face vocabulary would buy you on the same grid.
 *
 * Targets: a sphere (pure solid blob — connectivity degenerates to inside/outside)
 * and a torus (has a hole — real topology). We report RMS distance of the emitted
 * surface to the true surface (in cell-widths) and render both.
 *
 * Output (gitignored): scripts/surface-out/{sphere,torus}.png
 * Run:  node scripts/surface-fit-demo.mjs [NC]      (NC = corner samples/axis, default 40)
 */
import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'surface-out');
fs.mkdirSync(OUT, { recursive: true });

const NC = Math.max(12, parseInt(process.argv[2] || '40', 10)); // corners per axis
const L = 1.15;                                                  // domain [-L, L]^3
const coord = i => -L + (2 * L) * i / (NC - 1);
const cell = (2 * L) / (NC - 1);

const SHAPES = {
  sphere: (x, y, z) => Math.hypot(x, y, z) - 0.82,
  torus:  (x, y, z) => { const q = Math.hypot(x, z) - 0.58; return Math.hypot(q, y) - 0.24; },
};
function grad(f, x, y, z, h = 1e-3) {
  return norm([
    f(x + h, y, z) - f(x - h, y, z),
    f(x, y + h, z) - f(x, y - h, z),
    f(x, y, z + h) - f(x, y, z - h),
  ]);
}
function norm(v) { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// ── BLOCKY: occupancy-boundary faces (axis-aligned quads) ──────────────────────
function blocky(f) {
  const inside = (ci, cj, ck) => f(coord(ci) + cell / 2, coord(cj) + cell / 2, coord(ck) + cell / 2) < 0;
  const quads = [];
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  let sdfSum = 0, n = 0;
  for (let ci = 0; ci < NC - 1; ci++) for (let cj = 0; cj < NC - 1; cj++) for (let ck = 0; ck < NC - 1; ck++) {
    if (!inside(ci, cj, ck)) continue;
    for (const [dx, dy, dz] of dirs) {
      const ni = ci + dx, nj = cj + dy, nk = ck + dz;
      const oob = ni < 0 || nj < 0 || nk < 0 || ni >= NC - 1 || nj >= NC - 1 || nk >= NC - 1;
      if (oob || !inside(ni, nj, nk)) {
        // face between cell (ci,cj,ck) and neighbor, at the shared boundary plane
        const x0 = coord(ci), y0 = coord(cj), z0 = coord(ck);
        const fc = [x0 + cell / 2 + dx * cell / 2, y0 + cell / 2 + dy * cell / 2, z0 + cell / 2 + dz * cell / 2];
        const v = faceQuad(x0, y0, z0, dx, dy, dz);
        quads.push({ v, n: [dx, dy, dz] });
        sdfSum += (f(...fc)) ** 2; n++;
      }
    }
  }
  return { quads, rms: Math.sqrt(sdfSum / Math.max(1, n)) / cell, count: quads.length };
}
function faceQuad(x0, y0, z0, dx, dy, dz) {
  const x1 = x0 + cell, y1 = y0 + cell, z1 = z0 + cell;
  if (dx) { const x = dx > 0 ? x1 : x0; return [[x,y0,z0],[x,y1,z0],[x,y1,z1],[x,y0,z1]]; }
  if (dy) { const y = dy > 0 ? y1 : y0; return [[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]]; }
  const z = dz > 0 ? z1 : z0; return [[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]];
}

// ── NETS: one zero-crossing vertex per boundary cell, quads across sign-change edges
function nets(f) {
  // corner SDF cache
  const S = new Float64Array(NC * NC * NC);
  const ci3 = (i, j, k) => (i * NC + j) * NC + k;
  for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) for (let k = 0; k < NC; k++)
    S[ci3(i, j, k)] = f(coord(i), coord(j), coord(k));

  const EDGES = [ // 12 cube edges as [cornerA, cornerB] in {0,1}^3
    [[0,0,0],[1,0,0]],[[0,1,0],[1,1,0]],[[0,0,1],[1,0,1]],[[0,1,1],[1,1,1]],
    [[0,0,0],[0,1,0]],[[1,0,0],[1,1,0]],[[0,0,1],[0,1,1]],[[1,0,1],[1,1,1]],
    [[0,0,0],[0,0,1]],[[1,0,0],[1,0,1]],[[0,1,0],[0,1,1]],[[1,1,0],[1,1,1]],
  ];
  const vert = new Map(); // "ci,cj,ck" -> {p, n}
  const key = (a, b, c) => `${a},${b},${c}`;
  for (let ci = 0; ci < NC - 1; ci++) for (let cj = 0; cj < NC - 1; cj++) for (let ck = 0; ck < NC - 1; ck++) {
    let neg = 0, pos = 0;
    for (let c = 0; c < 8; c++) { const v = S[ci3(ci + (c&1), cj + ((c>>1)&1), ck + ((c>>2)&1))]; v < 0 ? neg++ : pos++; }
    if (!neg || !pos) continue; // not a boundary cell
    let sx = 0, sy = 0, sz = 0, m = 0;
    for (const [A, B] of EDGES) {
      const a = ci3(ci + A[0], cj + A[1], ck + A[2]), b = ci3(ci + B[0], cj + B[1], ck + B[2]);
      const sa = S[a], sb = S[b];
      if ((sa < 0) === (sb < 0)) continue;
      const t = sa / (sa - sb);
      const pa = [coord(ci + A[0]), coord(cj + A[1]), coord(ck + A[2])];
      const pb = [coord(ci + B[0]), coord(cj + B[1]), coord(ck + B[2])];
      sx += pa[0] + (pb[0] - pa[0]) * t; sy += pa[1] + (pb[1] - pa[1]) * t; sz += pa[2] + (pb[2] - pa[2]) * t; m++;
    }
    const p = [sx / m, sy / m, sz / m];
    vert.set(key(ci, cj, ck), { p, n: grad(f, ...p) });
  }

  // quads: for each interior corner-edge with a sign change, connect the 4 cells sharing it
  const quads = [];
  const sgn = (i, j, k) => S[ci3(i, j, k)] < 0;
  const cellsForX = (i, j, k) => [[i,j-1,k-1],[i,j,k-1],[i,j,k],[i,j-1,k]];
  const cellsForY = (i, j, k) => [[i-1,j,k-1],[i,j,k-1],[i,j,k],[i-1,j,k]];
  const cellsForZ = (i, j, k) => [[i-1,j-1,k],[i,j-1,k],[i,j,k],[i-1,j,k]];
  const emit = cells => {
    const vs = cells.map(([a,b,c]) => vert.get(key(a,b,c)));
    if (vs.some(v => !v)) return;
    quads.push({ v: vs.map(v => v.p), n: norm(vs.reduce((s, v) => [s[0]+v.n[0], s[1]+v.n[1], s[2]+v.n[2]], [0,0,0])) });
  };
  for (let i = 0; i < NC - 1; i++) for (let j = 1; j < NC - 1; j++) for (let k = 1; k < NC - 1; k++)
    if (sgn(i, j, k) !== sgn(i + 1, j, k)) emit(cellsForX(i, j, k));
  for (let i = 1; i < NC - 1; i++) for (let j = 0; j < NC - 1; j++) for (let k = 1; k < NC - 1; k++)
    if (sgn(i, j, k) !== sgn(i, j + 1, k)) emit(cellsForY(i, j, k));
  for (let i = 1; i < NC - 1; i++) for (let j = 1; j < NC - 1; j++) for (let k = 0; k < NC - 1; k++)
    if (sgn(i, j, k) !== sgn(i, j, k + 1)) emit(cellsForZ(i, j, k));

  // RMS: distance of each vertex to true surface (|SDF|), in cell-widths
  let sdfSum = 0;
  for (const { p } of vert.values()) sdfSum += f(...p) ** 2;
  return { quads, rms: Math.sqrt(sdfSum / Math.max(1, vert.size)) / cell, count: quads.length, verts: vert.size };
}

// ── render: orthographic 3/4 view, painter's algorithm, two-sided Lambert ──────
function project(p, a = 0.7, b = 0.5) {
  const x1 = p[0] * Math.cos(a) + p[2] * Math.sin(a), z1 = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  const y2 = p[1] * Math.cos(b) - z1 * Math.sin(b), z2 = p[1] * Math.sin(b) + z1 * Math.cos(b);
  return [x1, y2, z2];
}
const LIGHT = norm([0.5, 0.85, 0.55]);
function drawSurface(ctx, cx, cy, scale, model, base) {
  const tris = [];
  for (const q of model.quads) {
    const P = q.v.map(p => project(p));
    const shade = 0.25 + 0.75 * Math.abs(q.n[0]*LIGHT[0] + q.n[1]*LIGHT[1] + q.n[2]*LIGHT[2]);
    for (const [a, b, c] of [[0,1,2],[0,2,3]]) {
      tris.push({ pts: [P[a], P[b], P[c]], z: (P[a][2]+P[b][2]+P[c][2])/3, shade });
    }
  }
  tris.sort((u, v) => u.z - v.z);
  for (const t of tris) {
    ctx.beginPath();
    t.pts.forEach((p, i) => { const sx = cx + p[0]*scale, sy = cy - p[1]*scale; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    const c = base.map(ch => Math.round(ch * t.shade));
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.strokeStyle = `rgba(0,0,0,0.08)`; ctx.lineWidth = 0.5;
    ctx.fill(); ctx.stroke();
  }
}

function renderShape(name, f, base) {
  const blk = blocky(f), nts = nets(f);
  const W = 920, H = 520, P = 460, scale = 175;
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  ctx.fillStyle = '#f7f7fa'; ctx.fillRect(0, 0, W, H);
  drawSurface(ctx, P / 2, H / 2 + 10, scale, blk, base);
  drawSurface(ctx, P + P / 2, H / 2 + 10, scale, nts, base);
  ctx.fillStyle = '#222'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`BLOCKY (open/wall flat faces)`, P / 2, 30);
  ctx.fillText(`SURFACE-NETS (geometric patch vocab)`, P + P / 2, 30);
  ctx.font = '13px sans-serif';
  ctx.fillText(`${blk.count} faces · RMS ${blk.rms.toFixed(2)} cell-widths to true surface`, P / 2, H - 14);
  ctx.fillText(`${nts.count} quads · RMS ${nts.rms.toFixed(2)} cell-widths to true surface`, P + P / 2, H - 14);
  fs.writeFileSync(path.join(OUT, `${name}.png`), cv.toBuffer('image/png'));
  return { name, blky: blk.rms, nets: nts.rms, blkFaces: blk.count, netQuads: nts.count };
}

console.log(`grid ${NC - 1}³ cells (cell width = ${cell.toFixed(4)}), same container both ways:\n`);
for (const [name, f, base] of [['sphere', SHAPES.sphere, [232, 180, 200]], ['torus', SHAPES.torus, [180, 210, 160]]]) {
  const r = renderShape(name, f, base);
  console.log(`  ${name.padEnd(7)} blocky RMS ${r.blky.toFixed(3)} cell-widths (${r.blkFaces} faces)  |  nets RMS ${r.nets.toFixed(3)} (${r.netQuads} quads)`);
}
console.log(`\n→ ${path.relative(process.cwd(), OUT)}/{sphere,torus}.png`);
