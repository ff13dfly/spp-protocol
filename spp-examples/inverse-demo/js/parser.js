/**
 * parser.js — Validates and sanitizes AI-returned JSON
 */

import { OPTION_REGISTRY } from './particle.js';

const VALID_IDS = new Set(Object.keys(OPTION_REGISTRY).map(Number));

/**
 * Parse LLM output text into structured ParticleCell data.
 * Handles markdown fences, extra text, etc.
 */
export function parseAIResponse(text) {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?```\s*$/i, '');
    cleaned = cleaned.trim();

    // Try to find JSON object in the text
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error('No JSON object found in AI response');
    }
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`Invalid JSON: ${e.message}`);
    }

    return validateAndNormalize(parsed);
}

function validateAndNormalize(data) {
    if (!data.cells || !Array.isArray(data.cells)) {
        throw new Error('Missing or invalid "cells" array');
    }

    const gridX = data.gridX || 0;
    const gridZ = data.gridZ || 0;
    const description = data.description || '';

    const normalizedCells = [];

    for (const cell of data.cells) {
        if (!cell.position || !Array.isArray(cell.position) || cell.position.length < 3) {
            console.warn('Skipping cell with invalid position:', cell);
            continue;
        }

        if (!cell.faceOptions || !Array.isArray(cell.faceOptions) || cell.faceOptions.length !== 6) {
            console.warn('Skipping cell with invalid faceOptions:', cell);
            continue;
        }

        // Normalize faceOptions: ensure each element is an array with valid IDs
        const normalizedOptions = cell.faceOptions.map((opts, i) => {
            if (!Array.isArray(opts) || opts.length === 0) return [];
            const id = Number(opts[0]);
            if (!VALID_IDS.has(id)) {
                console.warn(`Invalid option ID ${id}, defaulting to 10 (brick wall)`);
                return [10];
            }
            return [id];
        });

        normalizedCells.push({
            position: [cell.position[0], 0, cell.position[2]],
            size: [1, 1, 1],
            faceStates: 0b111111,
            faceOptions: normalizedOptions,
        });
    }

    if (normalizedCells.length === 0) {
        throw new Error('No valid cells found in AI response');
    }

    return {
        gridX,
        gridZ,
        description,
        cells: normalizedCells,
    };
}
