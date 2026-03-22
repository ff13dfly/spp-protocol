/**
 * main.js — Orthogonal Demo entry point
 */

import { OrthoRenderer }    from './renderer.js';
import { buildSPPFromImage } from './spp-builder.js';

// ─── Shape catalog ───────────────────────────────────────────

const SHAPES = [
    { id: 'rectangle', name: '矩形 Rectangle', file: 'shapes/01-rectangle.png' },
    { id: 'l-shape',   name: 'L 形',           file: 'shapes/02-l-shape.png' },
    { id: 't-shape',   name: 'T 形',           file: 'shapes/03-t-shape.png' },
    { id: 'u-shape',   name: 'U 形',           file: 'shapes/04-u-shape.png' },
    { id: 'z-shape',   name: 'Z 形',           file: 'shapes/05-z-shape.png' },
    { id: 'cross',     name: '十字 Cross',     file: 'shapes/06-cross-shape.png' },
    { id: 'h-shape',   name: 'H 形',           file: 'shapes/07-h-shape.png' },
];

// ─── State ───────────────────────────────────────────────────

let currentShape = SHAPES[0];
let gridSize = 4;
let maxDepth = 3;
let scale = 3;
let renderer;

// ─── DOM ─────────────────────────────────────────────────────

const canvas       = document.getElementById('viewport');
const shapeSelect  = document.getElementById('shapeSelect');
const gridDisplay  = document.getElementById('gridDisplay');
const gridMinus    = document.getElementById('gridMinus');
const gridPlus     = document.getElementById('gridPlus');
const depthDisplay = document.getElementById('depthDisplay');
const depthMinus   = document.getElementById('depthMinus');
const depthPlus    = document.getElementById('depthPlus');
const scaleDisplay = document.getElementById('scaleDisplay');
const scaleMinus   = document.getElementById('scaleMinus');
const scalePlus    = document.getElementById('scalePlus');
const rebuildBtn   = document.getElementById('rebuildBtn');
const topViewBtn   = document.getElementById('topViewBtn');
const previewImg   = document.getElementById('previewImg');
const statCells    = document.getElementById('statCells');
const statRefined  = document.getElementById('statRefined');
const statDepth    = document.getElementById('statDepth');
const toastEl      = document.getElementById('toast');

// ─── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    renderer = new OrthoRenderer();
    renderer.init(canvas);

    for (const s of SHAPES) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        shapeSelect.appendChild(opt);
    }

    shapeSelect.addEventListener('change', () => {
        currentShape = SHAPES.find(s => s.id === shapeSelect.value) || SHAPES[0];
        previewImg.src = currentShape.file;
        rebuild();
    });

    gridMinus.addEventListener('click',  () => { if (gridSize > 2) { gridSize--; gridDisplay.textContent = gridSize; rebuild(); } });
    gridPlus.addEventListener('click',   () => { if (gridSize < 10) { gridSize++; gridDisplay.textContent = gridSize; rebuild(); } });
    depthMinus.addEventListener('click', () => { if (maxDepth > 0) { maxDepth--; depthDisplay.textContent = maxDepth; rebuild(); } });
    depthPlus.addEventListener('click',  () => { if (maxDepth < 6) { maxDepth++; depthDisplay.textContent = maxDepth; rebuild(); } });
    scaleMinus.addEventListener('click', () => { if (scale > 2) { scale--; scaleDisplay.textContent = scale; rebuild(); } });
    scalePlus.addEventListener('click',  () => { if (scale < 5) { scale++; scaleDisplay.textContent = scale; rebuild(); } });

    rebuildBtn.addEventListener('click', rebuild);
    topViewBtn.addEventListener('click', () => renderer.toggleTopView());

    gridDisplay.textContent = gridSize;
    depthDisplay.textContent = maxDepth;
    scaleDisplay.textContent = scale;

    previewImg.src = currentShape.file;
    setTimeout(rebuild, 300);
});

// ─── Rebuild ─────────────────────────────────────────────────

let _building = false;

async function rebuild() {
    if (_building) return;
    _building = true;
    rebuildBtn.disabled = true;
    rebuildBtn.textContent = '⏳ ...';
    toast('Scanning face lines...');

    try {
        const { chunk, stats } = await buildSPPFromImage(
            currentShape.file, gridSize, maxDepth, scale,
            (msg) => toast(msg)
        );

        renderer.render(chunk);
        renderer.focusScene();

        statCells.textContent = stats.leafCells;
        statRefined.textContent = stats.refinedCells;
        statDepth.textContent = stats.maxDepthUsed;

        toast(`✓ ${stats.leafCells} leaves, ${stats.refinedCells} refined`, 'success');
    } catch (err) {
        console.error(err);
        toast(`Error: ${err.message}`, 'error');
    } finally {
        _building = false;
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = '▶ Rebuild';
    }
}

// ─── Toast ───────────────────────────────────────────────────

let _t;
function toast(msg, type = 'info') {
    toastEl.textContent = msg;
    toastEl.className = 'toast visible' + (type !== 'info' ? ` toast-${type}` : '');
    clearTimeout(_t);
    _t = setTimeout(() => toastEl.classList.remove('visible'), 3500);
}
