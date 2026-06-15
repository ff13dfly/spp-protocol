/**
 * perception.mjs — the floor-plan perception pipeline under test.
 *
 * room list (AI) -> grid size (deterministic) -> grid fill (AI) -> layout.
 * Mirrors the prompts/sizing in spp-lib/spp-inverse-engine.js (kept here so the
 * eval is self-contained; ideally these become a single shared source later).
 * This is the step the external vision API kept failing at — the eval measures
 * exactly this output against a hand-labeled ground truth.
 */

export const STEP1A_ROOMS_PROMPT = `You are analyzing a floor plan image.

List every clearly enclosed room or functional space that has its own surrounding walls.

Return ONLY a JSON array of room name strings. No extra text, no markdown.
Example: ["Kitchen", "Living Room", "Bedroom", "Bathroom", "Hallway"]

Rules:
- Only include spaces that are clearly enclosed by walls on the floor plan
- Do NOT list "Entrance", "Entry", "Foyer", or "Corridor" unless it is a large, clearly labeled dedicated room with its own four walls — small transitional areas near the front door are part of the hallway
- Use standard English names
- If there are multiple bedrooms, name them "Bedroom 1", "Bedroom 2", etc.
- Do NOT include null, exterior, or outside areas`;

export const STEP1C_GRID_PROMPT = `You are filling a floor plan grid.

The floor plan has been divided into a __GRID_X__ × __GRID_Z__ grid (__GRID_X__ columns, __GRID_Z__ rows).
Reference room names (use these for consistency, but prioritize what you visually see over this list): __ROOM_LIST__

## Coordinate system
- Row 0 = TOP of the floor plan image; last row = BOTTOM.
- Column 0 = LEFT side; last column = RIGHT.

## Rules
1. Output EXACTLY __GRID_Z__ rows, each with EXACTLY __GRID_X__ elements.
2. Each cell must be a room name string, OR null if outside the outer walls.
3. Each room should ideally form a contiguous rectangular block; follow the actual visual boundaries — corridors and irregular spaces may be L-shaped.
4. Larger rooms occupy more cells; smaller rooms occupy fewer.
5. CRITICAL: No row may be entirely null. No column may be entirely null. The grid must be flush with the floor plan boundary on all four sides.
6. Every distinct space visible in the floor plan must appear at least once.
7. Use standard English title case for room names.

## Output
Return ONLY a JSON 2D array. No explanations, no markdown fences.`;

export function computeGridDimensions(aspectRatio, roomCount) {
  const targetCells = Math.max(48, roomCount * 10);
  let gridZ = Math.round(Math.sqrt(targetCells / Math.max(0.5, aspectRatio)));
  let gridX = Math.round(gridZ * Math.max(0.5, aspectRatio));
  gridX = Math.max(5, Math.min(14, gridX));
  gridZ = Math.max(4, Math.min(12, gridZ));
  return { gridX, gridZ };
}

function stripFences(text) {
  return String(text).replace(/```json?\n?/gi, '').replace(/```/g, '').trim();
}

export function parseRoomList(text) {
  const cleaned = stripFences(text);
  const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('no room array in response');
  const arr = JSON.parse(cleaned.substring(s, e + 1));
  if (!Array.isArray(arr) || !arr.every(r => typeof r === 'string')) throw new Error('room list not a string array');
  return arr.map(r => r.trim()).filter(Boolean);
}

export function parseLayout(text) {
  const cleaned = stripFences(text);
  const s = cleaned.indexOf('['), e = cleaned.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('no layout array in response');
  let raw;
  try { raw = JSON.parse(cleaned.substring(s, e + 1)); }
  catch (ex) { throw new Error(`layout JSON parse failed: ${ex.message}`); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('layout is not a non-empty array');
  if (!raw.every(Array.isArray)) throw new Error('layout must be a 2D array (rows of cells), got a flat or wrapped value');
  const w = raw[0].length;
  if (!raw.every(r => r.length === w)) throw new Error('ragged layout: all rows must have equal length');
  return raw.map(row => row.map(cell =>
    (cell === null || cell === 'null' || cell === 'NULL' || cell === '') ? null : String(cell)
  ));
}

/**
 * Run the full perception pipeline with a given async callFn(systemPrompt, userText).
 * @returns {Promise<{rooms, gridX, gridZ, layout, raw}>}
 */
export async function runPerception(callFn, aspectRatio, log = () => {}) {
  log('Step 1A: room list…');
  const roomsRaw = await callFn(STEP1A_ROOMS_PROMPT, 'List all rooms visible in this floor plan. Return ONLY the JSON array.');
  const rooms = parseRoomList(roomsRaw);
  log(`  → ${rooms.length} rooms: ${rooms.join(', ')}`);

  const { gridX, gridZ } = computeGridDimensions(aspectRatio, rooms.length);
  log(`Step 1B: grid ${gridX}×${gridZ}`);

  const gridPrompt = STEP1C_GRID_PROMPT
    .replace(/__GRID_X__/g, String(gridX))
    .replace(/__GRID_Z__/g, String(gridZ))
    .replace('__ROOM_LIST__', rooms.map(r => `"${r}"`).join(', '));
  log('Step 1C: fill grid…');
  const layoutRaw = await callFn(gridPrompt, `Fill the ${gridX}×${gridZ} grid with room names. Return ONLY the JSON 2D array.`);
  const layout = parseLayout(layoutRaw);
  log(`  → layout ${layout.length} rows × ${layout[0]?.length ?? 0} cols`);

  return { rooms, gridX, gridZ, layout, raw: { roomsRaw, layoutRaw } };
}
