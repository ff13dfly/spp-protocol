/**
 * prompt.js — Builds the prompt and calls multimodal AI APIs
 * Supports: Qwen (通义千问), Gemini
 */

const SYSTEM_PROMPT = `You are an SPP (String Particle Protocol) spatial analyzer. Your task is to analyze a floor plan image and output a grid of ParticleCells in JSON format.

## SPP Data Model

Each ParticleCell has:
- position: [x, 0, z] — grid coordinates (y is always 0 for a single floor)
- faceOptions: array of 6 elements, one per face direction:
  [+X (right), -X (left), +Y (up), -Y (down), +Z (front), -Z (back)]
  Each element is an array containing exactly ONE option ID.
  +Y and -Y should always be [] (not used for floor plans).

## Option Registry

Open types (connections/passages):
- 0: Empty (open passage, no wall)
- 1: Arch Door (arched doorway)
- 2: Rectangular Door (standard door frame)

Wall types (barriers):
- 10: Brick Wall (solid wall)
- 11: Earth Wall (solid wall, different style)
- 12: Half-height Wall (half-height barrier)
- 13: Green Hedge (plant wall)
- 20: Window (wall with window)

## Rules

1. Overlay a grid on the floor plan. Each cell represents one room-sized unit.
2. Only create cells where there is INTERIOR space (rooms, corridors). Do NOT create cells for exterior/outside areas.
3. For each cell, determine what is on each of its 4 horizontal faces (+X, -X, +Z, -Z):
   - If that face borders another interior cell with a doorway: use 2 (rectangular door)
   - If that face borders another interior cell with an open passage (no wall between rooms): use 0 (empty/open)
   - If that face borders another interior cell with a wall between them: use 10 (brick wall)
   - If that face is an exterior wall: use 10 (brick wall)
   - If that face has a window on an exterior wall: use 20 (window)
4. Make sure adjacent cells have MATCHING face options (if cell A's +X is "door", then the cell to its right's -X must also be "door").
5. Use the SMALLEST grid that covers the floor plan. Typical floor plans need 3×3 to 7×7 cells.

## Output Format

Return ONLY a valid JSON object (no markdown fences, no explanation, no comments):

{
  "gridX": <number of columns>,
  "gridZ": <number of rows>,
  "description": "<brief description of the floor plan>",
  "cells": [
    {
      "position": [x, 0, z],
      "faceOptions": [[id], [id], [], [], [id], [id]]
    }
  ]
}

Where x ranges from 0 to gridX-1 and z ranges from 0 to gridZ-1.
The cells array should only contain cells where there is interior space.`;

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

// ─── Qwen API (OpenAI-compatible) ───────────────────────────

async function callQwen(apiKey, imageFile, modelId, onStatus) {
    onStatus('Converting image...');
    const dataUrl = await fileToBase64(imageFile);

    onStatus(`Sending to ${modelId}...`);

    const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

    const body = {
        model: modelId,
        messages: [
            {
                role: 'system',
                content: SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: dataUrl },
                    },
                    {
                        type: 'text',
                        text: 'Analyze this floor plan and output SPP ParticleCell JSON. Return ONLY the JSON object, no other text.',
                    },
                ],
            },
        ],
        temperature: 0.2,
        max_tokens: 4096,
    };

    const response = await fetch(url, {
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
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('No text response from Qwen API');
    }

    return text;
}

// ─── Gemini API ─────────────────────────────────────────────

async function callGemini(apiKey, imageFile, modelId, onStatus) {
    onStatus('Converting image...');
    const dataUrl = await fileToBase64(imageFile);
    const base64Data = dataUrl.split(',')[1];
    const mimeType = imageFile.type || 'image/png';

    onStatus(`Sending to ${modelId}...`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const body = {
        contents: [
            {
                parts: [
                    { text: SYSTEM_PROMPT },
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Data,
                        },
                    },
                    { text: 'Analyze this floor plan and output SPP ParticleCell JSON. Return ONLY the JSON object, no other text.' },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
        },
    };

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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('No text response from Gemini API');
    }

    return text;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * @param {string} apiKey
 * @param {File} imageFile
 * @param {string} modelKey - key from MODELS
 * @param {function} onStatus
 * @returns {string} Raw text response
 */
export async function analyzeFloorPlan(apiKey, imageFile, modelKey, onStatus = () => { }) {
    const modelDef = MODELS[modelKey];
    if (!modelDef) throw new Error(`Unknown model: ${modelKey}`);

    let text;
    if (modelDef.provider === 'qwen') {
        text = await callQwen(apiKey, imageFile, modelDef.model, onStatus);
    } else if (modelDef.provider === 'gemini') {
        text = await callGemini(apiKey, imageFile, modelDef.model, onStatus);
    } else {
        throw new Error(`Unknown provider: ${modelDef.provider}`);
    }

    onStatus('Parsing response...');
    return text;
}
