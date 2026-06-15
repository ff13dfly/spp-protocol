/**
 * score.mjs — score a predicted layout against ground truth.
 *
 * The model picks its own grid resolution, so we can't compare cell-to-cell.
 * Instead we resample both layouts onto a common fine grid (default 48×48) by
 * fractional position and compute resolution-independent metrics:
 *   - roomF1     : did it identify the right SET of rooms (precision/recall/F1)
 *   - layoutAcc  : fraction of fine cells whose room label matches (null included)
 *   - meanIoU    : mean per-room IoU over rooms that truly exist (spatial placement)
 *   - footprintIoU: IoU of the built area (non-null mask) — did it get the outline
 */

const RES = 48;

// Conservative synonyms only (true equivalents). Extend per your label vocabulary.
// Intentionally does NOT merge "master bedroom" -> "bedroom" (different rooms).
const ROOM_ALIASES = {
  'wc': 'bathroom', 'toilet': 'bathroom', 'restroom': 'bathroom', 'washroom': 'bathroom',
  'lounge': 'living room', 'sitting room': 'living room',
  'bed room': 'bedroom',
};

export function normRoom(name, lenient = false) {
  if (name == null || name === '') return '∅';
  let s = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  if (lenient) s = s.replace(/\s*\d+$/, ''); // "bedroom 2" -> "bedroom"
  return ROOM_ALIASES[s] || s;
}

function dims(layout) {
  const rows = layout.length;
  const cols = layout.reduce((m, r) => Math.max(m, r.length), 0);
  return { rows, cols };
}

function sampleByFraction(layout, fx, fz) {
  const { rows, cols } = dims(layout);
  if (rows === 0 || cols === 0) return null;
  const z = Math.min(rows - 1, Math.max(0, Math.floor(fz * rows)));
  const x = Math.min(cols - 1, Math.max(0, Math.floor(fx * cols)));
  const v = layout[z]?.[x];
  return v == null ? null : v;
}

function rasterize(layout, lenient) {
  const grid = [];
  for (let j = 0; j < RES; j++) {
    const fz = (j + 0.5) / RES;
    const row = [];
    for (let i = 0; i < RES; i++) {
      const fx = (i + 0.5) / RES;
      row.push(normRoom(sampleByFraction(layout, fx, fz), lenient));
    }
    grid.push(row);
  }
  return grid;
}

function roomSet(layout, lenient) {
  const s = new Set();
  for (const row of layout) for (const c of row) { const n = normRoom(c, lenient); if (n !== '∅') s.add(n); }
  return s;
}

export function scorePrediction(predLayout, truthLayout, { lenient = false } = {}) {
  if (!Array.isArray(predLayout) || predLayout.length === 0 || !Array.isArray(predLayout[0])) {
    return { valid: false, reason: 'prediction layout empty/invalid' };
  }
  const predRooms = roomSet(predLayout, lenient);
  const truthRooms = roomSet(truthLayout, lenient);

  // room-set precision / recall / F1
  let tp = 0;
  for (const r of predRooms) if (truthRooms.has(r)) tp++;
  const precision = predRooms.size ? tp / predRooms.size : 0;
  const recall = truthRooms.size ? tp / truthRooms.size : 0;
  const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;

  // resample both to a common grid
  const P = rasterize(predLayout, lenient);
  const T = rasterize(truthLayout, lenient);

  let match = 0, total = RES * RES;
  const inter = {}, union = {};
  let fpInter = 0, fpUnion = 0; // footprint = non-empty mask
  let builtMatch = 0;           // correct cells inside the footprint (excludes ∅==∅)
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const p = P[j][i], t = T[j][i];
    if (p === t) match++;
    for (const r of new Set([p, t])) {
      if (r === '∅') continue;
      union[r] = (union[r] || 0) + 1;
    }
    if (p !== '∅' && t !== '∅' && p === t) { inter[p] = (inter[p] || 0) + 1; builtMatch++; }
    const pBuilt = p !== '∅', tBuilt = t !== '∅';
    if (pBuilt || tBuilt) fpUnion++;
    if (pBuilt && tBuilt) fpInter++;
  }
  const layoutAcc = match / total;
  const builtAreaAcc = fpUnion ? builtMatch / fpUnion : 0;
  const truthRoomList = [...truthRooms];
  const perRoomIoU = {};
  for (const r of truthRoomList) perRoomIoU[r] = union[r] ? (inter[r] || 0) / union[r] : 0;
  const meanIoU = truthRoomList.length
    ? truthRoomList.reduce((s, r) => s + perRoomIoU[r], 0) / truthRoomList.length : 0;
  const footprintIoU = fpUnion ? fpInter / fpUnion : 0;

  return {
    valid: true,
    rooms: { precision, recall, f1, predicted: [...predRooms], truth: truthRoomList },
    layoutAcc, builtAreaAcc, meanIoU, footprintIoU, perRoomIoU,
    resolution: RES,
  };
}
