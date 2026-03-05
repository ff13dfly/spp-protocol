/**
 * prompt.js — Two-step AI analysis for SPP inverse modeling
 * Step 1: Detect floor plan bounds + fine-grained grid + room mapping
 * Step 2: Classify each cell's faces
 * Supports: Qwen (通义千问), Gemini
 */

// ─── Step 1 Prompt: Crop + Fine-Grained Grid Sizing ─────────

const STEP1_PROMPT = `You are a spatial layout analyzer. Given a floor plan image, first locate the floor plan boundary, then overlay a fine-grained grid that preserves room proportions.

## Task

### Phase A: Detect floor plan bounds
Find the bounding box of the actual floor plan (the outer walls), EXCLUDING any labels, titles, dimensions, margins, or whitespace around it.
Express the bounds as normalized coordinates (0.0 to 1.0) relative to the full image:
- cropX: left edge of the outer wall
- cropY: top edge of the outer wall
- cropW: width of the floor plan area
- cropH: height of the floor plan area

### Phase B: Overlay grid WITHIN the bounds
Create a grid that covers ONLY the floor plan area (not the margins):
- Large rooms span MULTIPLE cells (e.g., a living room might be 2×2 cells)
- Small rooms span fewer cells (e.g., a bathroom might be 1×1)
- Narrow spaces like hallways span 1 cell wide but may be multiple cells long
- The grid must preserve approximate room SIZE RATIOS

## Rules
1. Study the image and estimate each room's relative width and height
2. Choose a common unit size such that rooms fit as integer multiples
3. Assign each cell a room name — cells belonging to the same room share the same name
4. Use null for cells that are exterior (outside the building)
5. The grid should be between 4×4 and 12×12 for typical apartments
6. CRITICAL: the grid must preserve proportions — a room twice as wide should span twice as many columns
7. **Wall snapping**: When a physical wall does not perfectly align with a cell boundary, assign the cell to whichever room occupies MORE of that cell's area. Walls must always land on cell boundaries.
8. **Rectangular rooms**: Each room should form a contiguous rectangular block. Avoid L-shaped or jagged room assignments.
9. **Minimum room size**: Every room must have at least 1 cell. Do not let small rooms (e.g., bathroom) disappear due to snapping.

## Output
Return ONLY a JSON object (no markdown, no explanation):
{
  "crop": { "x": <float 0-1>, "y": <float 0-1>, "w": <float 0-1>, "h": <float 0-1> },
  "gridX": <columns>,
  "gridZ": <rows>,
  "layout": [
    ["Room A", "Room A", "Room B", ...],
    ["Room A", "Room A", "Room B", ...],
    ...
  ]
}

Where layout[row][col] is the room name for that cell, or null for exterior cells.
Example:
{
  "crop": { "x": 0.08, "y": 0.10, "w": 0.84, "h": 0.82 },
  "gridX": 5,
  "gridZ": 4,
  "layout": [
    ["Kitchen", "Kitchen", "Hallway", "Bathroom", "Bathroom"],
    ["Kitchen", "Kitchen", "Hallway", "Bathroom", "Bathroom"],
    ["Living Room", "Living Room", "Hallway", "Bedroom", "Bedroom"],
    ["Living Room", "Living Room", "Hallway", "Bedroom", "Bedroom"]
  ]
}`;

// ─── Step 2 Prompt: Face Classification ─────────────────────

const STEP2_PROMPT = `You are an SPP (String Particle Protocol) spatial analyzer. Given a floor plan image and a fine-grained grid layout, classify each cell's face connections.

## Grid Layout (from Step 1)
GRID_X: __GRID_X__
GRID_Z: __GRID_Z__
Layout:
__LAYOUT__

## SPP Face Options

Each cell has 6 faces. Classify the 4 horizontal faces:
Face order: [+X (right), -X (left), +Y (up), -Y (down), +Z (front/up-in-image), -Z (back/down-in-image)]
+Y and -Y are always [] (unused for single-floor plans).

### Option IDs

- 0: **Open** — no wall, passage continues (SAME room cells adjacent to each other)
- 2: **Door** — doorway between DIFFERENT rooms
- 10: **Wall** — solid wall (interior wall between rooms, or exterior wall)
- 20: **Window** — exterior wall with window

## Rules

1. **Same-room adjacency**: If two adjacent cells belong to the SAME room → use 0 (open) between them. This is critical for rooms spanning multiple cells.
2. **Different-room adjacency with door**: If adjacent cells are DIFFERENT rooms connected by a doorway → use 2 (door).
3. **Different-room adjacency with wall**: If adjacent cells are DIFFERENT rooms separated by a wall → use 10 (wall).
4. **Exterior face**: face at the edge of the building:
   - Use 20 (window) for living rooms, bedrooms, and kitchens (they typically have windows)
   - Use 10 (wall) for bathrooms and hallways
5. **Symmetry**: Adjacent faces MUST match — if cell A's +X is door, the neighbor's -X must also be door.
6. **Door placement**: Doors between rooms should appear on only ONE cell-pair boundary, not across the entire room border.

## Output

Return ONLY a JSON object (no markdown, no explanation):
{
  "gridX": __GRID_X__,
  "gridZ": __GRID_Z__,
  "description": "<brief description>",
  "cells": [
    {
      "position": [x, 0, z],
      "room": "<room name>",
      "faceOptions": [[id], [id], [], [], [id], [id]]
    }
  ]
}

Only include cells where layout is NOT null.`;

// ─── Model Definitions ─────────────────────────────────────

export const MODELS = {
    'qwen-vl-max': {
        name: 'Qwen VL Max (千问)',
        provider: 'qwen',
        model: 'qwen-vl-max',
    },
    'qwen-vl-plus': {
        name: 'Qwen VL Plus (千问)',
        provider: 'qwen',
        model: 'qwen-vl-plus',
    },
    'gemini-2.0-flash': {
        name: 'Gemini 2.0 Flash',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
    },
    'gemini-2.0-pro': {
        name: 'Gemini 2.0 Pro',
        provider: 'gemini',
        model: 'gemini-2.0-pro',
    },
};

export const DEFAULT_MODEL = 'qwen-vl-max';

// ─── File to Base64 ─────────────────────────────────────────

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ─── Generic API Callers ────────────────────────────────────

async function callQwen(apiKey, imageDataUrl, systemPrompt, userText, modelId) {
    const body = {
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: imageDataUrl } },
                    { type: 'text', text: userText },
                ],
            },
        ],
        temperature: 0.1,
        max_tokens: 8192,
    };

    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Qwen API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

async function callGemini(apiKey, imageDataUrl, systemPrompt, userText, modelId) {
    const base64Data = imageDataUrl.split(',')[1];
    const mimeMatch = imageDataUrl.match(/data:([^;]+);/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

    const body = {
        contents: [{
            parts: [
                { text: systemPrompt },
                { inline_data: { mime_type: mimeType, data: base64Data } },
                { text: userText },
            ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef) {
    if (modelDef.provider === 'qwen') {
        return callQwen(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    } else if (modelDef.provider === 'gemini') {
        return callGemini(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    }
    throw new Error(`Unknown provider: ${modelDef.provider}`);
}

// ─── Public API: Two-Step Analysis ──────────────────────────

/**
 * Step 1: Detect crop bounds + fine-grained grid + room layout
 */
export async function analyzeGridSize(apiKey, imageDataUrl, modelKey, onStatus) {
    const modelDef = MODELS[modelKey];
    if (!modelDef) throw new Error(`Unknown model: ${modelKey}`);

    onStatus('Step 1/2: Detecting floor plan bounds & analyzing grid layout...');
    const text = await callModel(apiKey, imageDataUrl, STEP1_PROMPT,
        'Analyze this floor plan. First detect the floor plan bounds (crop), then output a fine-grained grid within those bounds. Return ONLY the JSON.', modelDef);
    return text;
}

/**
 * Step 2: Classify each cell's faces
 */
export async function classifyFaces(apiKey, imageDataUrl, modelKey, gridInfo, onStatus) {
    const modelDef = MODELS[modelKey];
    if (!modelDef) throw new Error(`Unknown model: ${modelKey}`);

    const layoutStr = gridInfo.layout
        .map((row, z) => `  Row ${z}: ${row.map(c => c || '(exterior)').join(' | ')}`)
        .join('\n');

    const prompt = STEP2_PROMPT
        .replace(/__GRID_X__/g, String(gridInfo.gridX))
        .replace(/__GRID_Z__/g, String(gridInfo.gridZ))
        .replace('__LAYOUT__', layoutStr);

    onStatus(`Step 2/2: Classifying ${gridInfo.gridX}×${gridInfo.gridZ} grid faces...`);
    const text = await callModel(apiKey, imageDataUrl, prompt,
        `Classify each cell's face connections. Same-room cells must use open(0) between them. Return ONLY the JSON.`, modelDef);
    return text;
}

// ─── Convenience: Full two-step analysis ────────────────────

export async function analyzeFloorPlan(apiKey, imageFile, modelKey, onStatus = () => { }) {
    const imageDataUrl = await fileToBase64(imageFile);

    const step1Text = await analyzeGridSize(apiKey, imageDataUrl, modelKey, onStatus);
    const gridInfo = JSON.parse(step1Text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

    onStatus(`Grid: ${gridInfo.gridX}×${gridInfo.gridZ} — starting face classification...`);

    const step2Text = await classifyFaces(apiKey, imageDataUrl, modelKey, gridInfo, onStatus);

    onStatus('Parsing response...');
    return { step1: gridInfo, step2Text };
}
