/**
 * prompt.js — AI provider integration for SPP inverse modeling demo
 *
 * Prompt templates and parsing logic have been moved to the shared
 * spp-lib/spp-inverse-engine.js module. This file retains:
 *   - Model definitions (Qwen, Gemini)
 *   - API caller implementations
 *   - Two-step analysis wrappers that use the shared engine prompts
 *
 * Supports: Qwen (通义千问), Gemini
 */

import { SPPInverseEngine } from '../../../spp-lib/spp-inverse-engine.js';

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

export async function callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef) {
    if (modelDef.provider === 'qwen') {
        return callQwen(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    } else if (modelDef.provider === 'gemini') {
        return callGemini(apiKey, imageDataUrl, systemPrompt, userText, modelDef.model);
    }
    throw new Error(`Unknown provider: ${modelDef.provider}`);
}

// ─── Factory: Create an SPPInverseEngine with a specific model ──

/**
 * Create an SPPInverseEngine instance bound to a specific API key and model.
 * This bridges the demo's model/key selection UI with the engine's provider interface.
 *
 * @param {string} apiKey - The API key for the selected provider
 * @param {string} modelKey - Key into the MODELS registry
 * @param {Function} [onStatus] - Status callback
 * @returns {SPPInverseEngine}
 */
export function createEngine(apiKey, modelKey, onStatus) {
    const modelDef = MODELS[modelKey];
    if (!modelDef) throw new Error(`Unknown model: ${modelKey}`);

    return new SPPInverseEngine({
        llmProvider: (imageDataUrl, systemPrompt, userText) =>
            callModel(apiKey, imageDataUrl, systemPrompt, userText, modelDef),
        onStatus,
    });
}

// ─── Legacy API (backward-compatible wrappers) ──────────────

/**
 * Step 1: Detect crop bounds + fine-grained grid + room layout
 */
export async function analyzeGridSize(apiKey, imageDataUrl, modelKey, onStatus) {
    const engine = createEngine(apiKey, modelKey, onStatus);
    const gridInfo = await engine.analyzeGridSize(imageDataUrl);
    // Return raw text-like format for backward compat with main.js parsing
    return JSON.stringify(gridInfo);
}

/**
 * Step 2: Classify each cell's faces
 */
export async function classifyFaces(apiKey, imageDataUrl, modelKey, gridInfo, onStatus) {
    const modelDef = MODELS[modelKey];
    if (!modelDef) throw new Error(`Unknown model: ${modelKey}`);

    // Build the engine but only use it for the LLM call — Step 2 needs
    // the gridInfo injected into the prompt, which the engine handles internally.
    const engine = createEngine(apiKey, modelKey, onStatus);
    const result = await engine.classifyFaces(imageDataUrl, gridInfo);
    // Return raw text-like format for backward compat with main.js parsing
    return JSON.stringify(result);
}

/**
 * Convenience: Full two-step analysis
 */
export async function analyzeFloorPlan(apiKey, imageFile, modelKey, onStatus = () => { }) {
    const imageDataUrl = await fileToBase64(imageFile);
    const engine = createEngine(apiKey, modelKey, onStatus);
    return engine.reconstruct(imageDataUrl);
}
