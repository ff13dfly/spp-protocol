/**
 * selection.js — 3D cell selection
 *
 * Interactions:
 *   Left click (no drag)     — toggle single cell (select / deselect)
 *   Left drag                — paint-select: raycast on every mousemove,
 *                              add any cell under the cursor to the selection
 *   Ctrl / Cmd  (either)     — additive mode: keep existing selection
 *   Right drag               — orbit  (OrbitControls)
 *   Middle drag              — pan    (OrbitControls)
 *
 * Paint-select works correctly from any camera angle because it uses
 * raycasting rather than a flat screen-space rectangle.
 */

import * as THREE from 'three';

const DRAG_THRESHOLD = 4;   // px — movement below this is treated as a click

export class SelectionManager {
    constructor() {
        this.selectedCells   = new Set();
        this.selectMode      = false;  // false = navigate, true = select

        this._onChange       = null;
        this._canvas         = null;
        this._getCamera      = null;
        this._getFloorMeshes = null;
        this._raycaster      = new THREE.Raycaster();

        this._dragStart      = null;
        this._isPainting     = false;
        this._paintAdditive  = false;

        this._bound = {
            mousedown: this._onMouseDown.bind(this),
            mousemove: this._onMouseMove.bind(this),
            mouseup:   this._onMouseUp.bind(this),
        };
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Function} getCamera       — () => THREE.Camera
     * @param {Function} getFloorMeshes  — () => [{ mesh, cell }]
     * @param {Function} onChange        — (selectedCells: Set) => void
     */
    init(canvas, getCamera, getFloorMeshes, onChange) {
        this._canvas         = canvas;
        this._getCamera      = getCamera;
        this._getFloorMeshes = getFloorMeshes;
        this._onChange       = onChange;

        canvas.addEventListener('mousedown', this._bound.mousedown);
        canvas.addEventListener('mousemove', this._bound.mousemove);
        window.addEventListener('mouseup',   this._bound.mouseup);
    }

    clear() {
        this.selectedCells.clear();
        this._onChange(this.selectedCells);
    }

    destroy() {
        this._canvas?.removeEventListener('mousedown', this._bound.mousedown);
        this._canvas?.removeEventListener('mousemove', this._bound.mousemove);
        window.removeEventListener('mouseup', this._bound.mouseup);
    }

    // ─── Event handlers ───────────────────────────────────────

    _onMouseDown(e) {
        if (e.button !== 0 || !this.selectMode) return;
        this._dragStart     = { x: e.clientX, y: e.clientY };
        this._isPainting    = false;
        this._paintAdditive = e.ctrlKey || e.metaKey;
    }

    _onMouseMove(e) {
        if (!this._dragStart || !this.selectMode) return;

        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;

        if (!this._isPainting && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            this._isPainting = true;
            if (!this._paintAdditive) this.selectedCells.clear();
        }

        if (this._isPainting) {
            this._paintAt(e.clientX, e.clientY);
        }
    }

    _onMouseUp(e) {
        if (e.button !== 0 || !this._dragStart) return;

        if (this.selectMode && !this._isPainting) {
            // Short click in select mode — toggle single cell
            this._doClick(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
        }

        this._dragStart  = null;
        this._isPainting = false;
    }

    // ─── Paint one frame ──────────────────────────────────────

    _paintAt(clientX, clientY) {
        const cell = this._raycastCell(clientX, clientY);
        if (!cell) return;
        if (!this.selectedCells.has(cell)) {
            this.selectedCells.add(cell);
            this._onChange(this.selectedCells);
        }
    }

    // ─── Single click — toggle ────────────────────────────────

    _doClick(clientX, clientY, additive) {
        const cell = this._raycastCell(clientX, clientY);

        if (!additive) this.selectedCells.clear();

        if (cell) {
            if (this.selectedCells.has(cell)) {
                this.selectedCells.delete(cell);
            } else {
                this.selectedCells.add(cell);
            }
        }

        this._onChange(this.selectedCells);
    }

    // ─── Raycast helper ───────────────────────────────────────

    _raycastCell(clientX, clientY) {
        const ndc = this._clientToNDC(clientX, clientY);
        this._raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this._getCamera());

        const meshes = this._getFloorMeshes().map(fm => fm.mesh);
        const hits   = this._raycaster.intersectObjects(meshes);

        return hits.length > 0 ? hits[0].object.userData.cell : null;
    }

    // ─── Util ─────────────────────────────────────────────────

    _clientToNDC(x, y) {
        const rect = this._canvas.getBoundingClientRect();
        return {
            x:  (x - rect.left) / rect.width  * 2 - 1,
            y: -(y - rect.top)  / rect.height * 2 + 1,
        };
    }
}
