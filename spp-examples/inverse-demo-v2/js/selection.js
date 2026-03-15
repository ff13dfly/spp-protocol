/**
 * selection.js — Manual multi-select
 *
 * - Left click: select / deselect cell
 * - Ctrl/Cmd + left click: additive multi-select
 * - Left drag: box-select
 * - OrbitControls uses right-drag to rotate / middle-drag to pan;
 *   left button is fully owned by this module.
 */

import * as THREE from 'three';

export class SelectionManager {
    constructor() {
        this.selectedCells = new Set();
        this._onChange     = null;
        this._canvas       = null;
        this._getCamera    = null;
        this._getFloorMeshes = null;
        this._selBoxEl     = null;
        this._raycaster    = new THREE.Raycaster();

        this._dragStart    = null;
        this._isDragging   = false;

        this._bound = {
            mousedown: this._onMouseDown.bind(this),
            mousemove: this._onMouseMove.bind(this),
            mouseup:   this._onMouseUp.bind(this),
        };
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Function} getCamera       - () => THREE.Camera
     * @param {Function} getFloorMeshes  - () => [{ mesh, cell }]
     * @param {Function} onChange        - (selectedCells: Set) => void
     * @param {HTMLElement} selBoxEl     - selection-box overlay div
     */
    init(canvas, getCamera, getFloorMeshes, onChange, selBoxEl) {
        this._canvas         = canvas;
        this._getCamera      = getCamera;
        this._getFloorMeshes = getFloorMeshes;
        this._onChange       = onChange;
        this._selBoxEl       = selBoxEl;

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

    // ─── Event handlers ──────────────────────────────────────

    _onMouseDown(e) {
        if (e.button !== 0) return;
        this._dragStart  = { x: e.clientX, y: e.clientY };
        this._isDragging = false;
    }

    _onMouseMove(e) {
        if (!this._dragStart) return;
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            this._isDragging = true;
            this._updateSelBox(this._dragStart, { x: e.clientX, y: e.clientY });
        }
    }

    _onMouseUp(e) {
        if (e.button !== 0 || !this._dragStart) return;
        const additive = e.ctrlKey || e.metaKey;

        if (this._isDragging) {
            this._doBoxSelect(this._dragStart, { x: e.clientX, y: e.clientY }, additive);
        } else {
            this._doClick(e.clientX, e.clientY, additive);
        }

        this._dragStart  = null;
        this._isDragging = false;
        this._hideSelBox();
    }

    // ─── Single-click raycast ─────────────────────────────────

    _doClick(clientX, clientY, additive) {
        const ndc = this._clientToNDC(clientX, clientY);
        const mouse = new THREE.Vector2(ndc.x, ndc.y);
        this._raycaster.setFromCamera(mouse, this._getCamera());

        const meshes = this._getFloorMeshes().map(fm => fm.mesh);
        const hits   = this._raycaster.intersectObjects(meshes);

        if (hits.length === 0) {
            if (!additive) this.selectedCells.clear();
            this._onChange(this.selectedCells);
            return;
        }

        const cell = hits[0].object.userData.cell;
        if (!cell) return;

        if (!additive) this.selectedCells.clear();

        if (this.selectedCells.has(cell)) {
            this.selectedCells.delete(cell);
        } else {
            this.selectedCells.add(cell);
        }

        this._onChange(this.selectedCells);
    }

    // ─── Box-select ───────────────────────────────────────────

    _doBoxSelect(start, end, additive) {
        const camera = this._getCamera();
        const rect   = this._canvas.getBoundingClientRect();

        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);

        if (!additive) this.selectedCells.clear();

        for (const { mesh, cell } of this._getFloorMeshes()) {
            // Project cell world position to screen space
            const worldPos = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
            const projected = worldPos.clone().project(camera);

            const screenX = (projected.x + 1) / 2 * rect.width  + rect.left;
            const screenY = (-projected.y + 1) / 2 * rect.height + rect.top;

            if (screenX >= minX && screenX <= maxX &&
                screenY >= minY && screenY <= maxY) {
                this.selectedCells.add(cell);
            }
        }

        this._onChange(this.selectedCells);
    }

    // ─── Visual selection box ─────────────────────────────────

    _updateSelBox(start, end) {
        if (!this._selBoxEl) return;
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        const el = this._selBoxEl;
        el.style.display = 'block';
        el.style.left    = minX + 'px';
        el.style.top     = minY + 'px';
        el.style.width   = (maxX - minX) + 'px';
        el.style.height  = (maxY - minY) + 'px';
    }

    _hideSelBox() {
        if (this._selBoxEl) this._selBoxEl.style.display = 'none';
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
