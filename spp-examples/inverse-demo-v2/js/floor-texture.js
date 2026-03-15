/**
 * floor-texture.js — Floor plan projected as a ground texture
 *
 * Crops the source floor plan image to the cropInfo region and projects it
 * as a semi-transparent overlay covering the full grid in world space.
 */

import * as THREE from 'three';

export class FloorTexture {
    constructor() {
        this._mesh = null;
        this._material = null;
        this._scene = null;
    }

    /**
     * @param {THREE.Scene} scene
     * @param {string} imageDataUrl  - source floor plan data URL
     * @param {Object} cropInfo      - { x, y, w, h } normalized crop (from Phase 1)
     * @param {number} gridX
     * @param {number} gridZ
     * @param {number} cellSize      - world-unit size of one root grid cell
     */
    async init(scene, imageDataUrl, cropInfo, gridX, gridZ, cellSize) {
        this._scene = scene;
        this.dispose();

        // Crop to the floor plan region
        const croppedUrl = await this._cropImage(imageDataUrl, cropInfo);

        const width  = gridX * cellSize;
        const depth  = gridZ * cellSize;
        // Grid center: cells span [0, gridX-1] * cellSize → center = (gridX-1)*cellSize/2
        const cx = (gridX - 1) * cellSize / 2;
        const cz = (gridZ - 1) * cellSize / 2;

        const geo = new THREE.PlaneGeometry(width, depth);
        this._material = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0.6,
            depthTest: false,   // always draw on top of whatever is below
            depthWrite: false,
        });

        const loader = new THREE.TextureLoader();
        loader.load(croppedUrl, (texture) => {
            // flipY=true (default) keeps the image right-side-up on a -PI/2 rotated plane
            this._material.map = texture;
            this._material.needsUpdate = true;
        });

        this._mesh = new THREE.Mesh(geo, this._material);
        this._mesh.rotation.x = -Math.PI / 2;
        this._mesh.position.set(cx, 0, cz);
        this._mesh.renderOrder = 2;   // render after opaque cell floors (order 0)
        scene.add(this._mesh);
    }

    /** opacity: 0–100 */
    setOpacity(value) {
        if (this._material) {
            this._material.opacity = value / 100;
            this._material.transparent = value < 100;
            this._material.needsUpdate = true;
        }
    }

    dispose() {
        if (this._mesh && this._scene) {
            this._scene.remove(this._mesh);
        }
        if (this._material) {
            this._material.map?.dispose();
            this._material.dispose();
        }
        this._mesh = null;
        this._material = null;
    }

    // ─── Private ──────────────────────────────────────────────

    _cropImage(dataUrl, cropInfo) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const sw = img.naturalWidth  * cropInfo.w;
                const sh = img.naturalHeight * cropInfo.h;
                const canvas = document.createElement('canvas');
                canvas.width  = Math.round(sw);
                canvas.height = Math.round(sh);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(
                    img,
                    img.naturalWidth  * cropInfo.x,
                    img.naturalHeight * cropInfo.y,
                    sw, sh,
                    0, 0, canvas.width, canvas.height
                );
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = dataUrl;
        });
    }
}
