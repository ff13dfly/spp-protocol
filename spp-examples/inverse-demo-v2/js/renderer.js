/**
 * renderer.js — Multi-depth Three.js renderer (LayerRenderer)
 *
 * Uses flattenRecursiveCells (leaf nodes) + collectInteriorNodes (interior nodes)
 * for layered rendering: depth-colored leaves + semi-transparent interior nodes.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RecursiveGridManager, FACE, OPTION_REGISTRY, OPTION_TYPE, getResolvedOption } from './shim.js';

// ─── Constants ───────────────────────────────────────────────

export const CELL_SIZE = 3;          // world-unit size of each root grid cell
const WALL_THICKNESS = 0.15;         // fixed wall thickness (does not scale with depth)
const HORIZONTAL_FACES = [FACE.POS_X, FACE.NEG_X, FACE.POS_Z, FACE.NEG_Z];

export const DEPTH_CONFIG = [
    { wallColor: 0xd4886b, floorColor: 0xe8e8ef, wallHeight: 2.8, yOffset: 0.0   },
    { wallColor: 0x6b8fd4, floorColor: 0xe0e8f0, wallHeight: 2.6, yOffset: 0.08  },
    { wallColor: 0x6bd49b, floorColor: 0xe0f0e8, wallHeight: 2.4, yOffset: 0.16  },
    { wallColor: 0x8bd4c4, floorColor: 0xe0f8f4, wallHeight: 2.2, yOffset: 0.24  },
];

// ─── LayerRenderer ───────────────────────────────────────────

export class LayerRenderer {
    constructor() {
        this.scene      = null;
        this.camera     = null;
        this.renderer   = null;
        this.controls   = null;
        this._sceneGroup = null;
        this._floorMeshes = [];   // [{ mesh, cell }] for raycasting
        this._animId    = null;
        this._isTopView = false;
        this._gridX     = 0;
        this._gridZ     = 0;
    }

    // ─── Init ──────────────────────────────────────────────

    init(canvas) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(w, h, false);
        this.renderer.setClearColor(0x1a1a2e);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(10, 20, 10);
        this.scene.add(dir);

        // Perspective camera
        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
        this.camera.position.set(8, 14, 18);
        this.camera.lookAt(0, 0, 0);

        // Prevent right-click context menu so OrbitControls can use right-drag to rotate
        canvas.addEventListener('contextmenu', e => e.preventDefault());

        // OrbitControls — left button owned by selection.js
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.mouseButtons = {
            LEFT:   null,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT:  THREE.MOUSE.ROTATE,
        };
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        // Scene group (rebuilt on each render call)
        this._sceneGroup = new THREE.Group();
        this.scene.add(this._sceneGroup);

        // Resize handler
        window.addEventListener('resize', () => this._onResize(canvas));

        // Animation loop
        const loop = () => {
            this._animId = requestAnimationFrame(loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    // ─── Render cells ──────────────────────────────────────

    /**
     * @param {Array} rootCells - root-level ParticleCells (may have .refinement)
     * @param {number} gridX
     * @param {number} gridZ
     */
    render(rootCells, gridX, gridZ) {
        this._gridX = gridX;
        this._gridZ = gridZ;
        this._clearSceneGroup();
        this._floorMeshes = [];

        const renderedWallsInterior = new Set();
        const renderedWallsLeaf = new Set();

        // Interior nodes (cells with refinement) — semi-transparent walls, no floor
        const interior = RecursiveGridManager.collectInteriorNodes(
            rootCells, [0, 0, 0], CELL_SIZE
        );
        for (const node of interior) {
            this._buildCell(node, true, renderedWallsInterior);
        }

        // Leaf nodes — full opacity, depth-colored
        const leaves = RecursiveGridManager.flattenRecursiveCells(
            rootCells, [0, 0, 0], CELL_SIZE
        );
        for (const leaf of leaves) {
            const result = this._buildCell(leaf, false, renderedWallsLeaf);
            if (result.floorMesh) {
                this._floorMeshes.push({ mesh: result.floorMesh, cell: leaf });
            }
        }
    }

    // ─── Top-view screenshot ───────────────────────────────

    /**
     * Render one frame with an orthographic top-down camera and return a data URL.
     * Must be called after render() (scene must have content).
     */
    renderTopView() {
        const gx = this._gridX || 1;
        const gz = this._gridZ || 1;

        const extentX = gx * CELL_SIZE;
        const extentZ = gz * CELL_SIZE;
        const cx = (gx - 1) * CELL_SIZE / 2;
        const cz = (gz - 1) * CELL_SIZE / 2;

        const { width, height } = this.renderer.getSize(new THREE.Vector2());
        const aspect = width / height;
        const half = Math.max(extentX, extentZ) / 2 * 1.05;

        const ortho = new THREE.OrthographicCamera(
            -half * aspect, half * aspect,
            half, -half,
            -100, 300
        );
        ortho.position.set(cx, 100, cz);
        ortho.up.set(0, 0, -1);
        ortho.lookAt(cx, 0, cz);

        this.renderer.render(this.scene, ortho);
        const dataUrl = this.renderer.domElement.toDataURL('image/png');

        // Restore perspective
        this.renderer.render(this.scene, this.camera);
        return dataUrl;
    }

    /** T key — toggle top-down / perspective */
    toggleTopView() {
        this._isTopView = !this._isTopView;
        if (this._isTopView) {
            const gx = this._gridX || 4;
            const gz = this._gridZ || 4;
            const cx = (gx - 1) * CELL_SIZE / 2;
            const cz = (gz - 1) * CELL_SIZE / 2;
            this.camera.position.set(cx, 40, cz);
            this.camera.up.set(0, 0, -1);
            this.camera.lookAt(cx, 0, cz);
        } else {
            const cx = (this._gridX - 1) * CELL_SIZE / 2;
            const cz = (this._gridZ - 1) * CELL_SIZE / 2;
            this.camera.position.set(cx + 8, 14, cz + 18);
            this.camera.up.set(0, 1, 0);
            this.camera.lookAt(cx, 0, cz);
        }
        this.controls.target.set(
            (this._gridX - 1) * CELL_SIZE / 2, 0,
            (this._gridZ - 1) * CELL_SIZE / 2
        );
        this.controls.update();
    }

    /** Center camera on the scene */
    focusScene() {
        const cx = (this._gridX - 1) * CELL_SIZE / 2;
        const cz = (this._gridZ - 1) * CELL_SIZE / 2;
        this.camera.position.set(cx + 10, 16, cz + 20);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(cx, 0, cz);
        this.controls.target.set(cx, 0, cz);
        this.controls.update();
    }

    getCamera()      { return this.camera; }
    getFloorMeshes() { return this._floorMeshes; }

    // ─── Highlight selected cells ──────────────────────────

    highlightSelection(selectedCells) {
        for (const { mesh, cell } of this._floorMeshes) {
            const depth = cell._depth || 0;
            const cfg = DEPTH_CONFIG[Math.min(depth, DEPTH_CONFIG.length - 1)];
            if (selectedCells.has(cell)) {
                mesh.material.color.setHex(0x4488ff);
                mesh.material.emissive?.setHex(0x112244);
            } else {
                mesh.material.color.setHex(cfg.floorColor);
                mesh.material.emissive?.setHex(0x000000);
            }
        }
    }

    // ─── Private: build one cell ───────────────────────────

    _buildCell(cell, isInterior, renderedWalls) {
        const [wx, , wz] = cell.worldPosition;
        const S    = cell.worldScale;
        const depth = cell._depth || 0;
        const cfg  = DEPTH_CONFIG[Math.min(depth, DEPTH_CONFIG.length - 1)];
        const half = S / 2;

        const group = new THREE.Group();
        group.position.set(wx, cfg.yOffset, wz);
        group.userData.cell = cell;

        let floorMesh = null;

        // Floor — leaf nodes only
        if (!isInterior) {
            const floorGeo = new THREE.PlaneGeometry(S * 0.97, S * 0.97);
            const fMat = new THREE.MeshStandardMaterial({
                color: cfg.floorColor,
                roughness: 0.9,
            });
            floorMesh = new THREE.Mesh(floorGeo, fMat);
            floorMesh.rotation.x = -Math.PI / 2;
            floorMesh.position.y = 0.01;
            floorMesh.userData.cell = cell;
            group.add(floorMesh);

            // Cell edge lines
            const edgeMat = new THREE.LineBasicMaterial({ color: 0x556688, transparent: true, opacity: 0.25 });
            const edgeGeo = new THREE.EdgesGeometry(floorGeo);
            const edges   = new THREE.LineSegments(edgeGeo, edgeMat);
            edges.rotation.x = -Math.PI / 2;
            edges.position.y = 0.02;
            group.add(edges);
        }

        // Walls
        for (const face of HORIZONTAL_FACES) {
            const optId = cell.faceOptions?.[face]?.[0];
            if (optId === undefined || optId === null) continue;
            const opt = OPTION_REGISTRY[optId];
            if (!opt || opt.type === OPTION_TYPE.OPEN) continue;

            // Dedup key: world position of the wall's center edge
            let key;
            if (face === FACE.POS_X) key = `${(wx + half).toFixed(3)},${wz.toFixed(3)},x`;
            else if (face === FACE.NEG_X) key = `${(wx - half).toFixed(3)},${wz.toFixed(3)},x`;
            else if (face === FACE.POS_Z) key = `${wx.toFixed(3)},${(wz + half).toFixed(3)},z`;
            else key = `${wx.toFixed(3)},${(wz - half).toFixed(3)},z`;

            const dedupKey = isInterior ? `i:${key}` : key;
            if (renderedWalls.has(dedupKey)) continue;
            renderedWalls.add(dedupKey);

            const wallGeo = new THREE.BoxGeometry(
                S + WALL_THICKNESS, cfg.wallHeight, WALL_THICKNESS
            );
            const wallColor = optId === 20 ? 0xaaccee     // window: light blue
                            : optId <= 2  ? 0xc9a96e      // door: warm tan
                            : cfg.wallColor;
            const wallMat = new THREE.MeshStandardMaterial({
                color:       wallColor,
                roughness:   0.55,
                transparent: isInterior,
                opacity:     isInterior ? 0.18 : 1.0,
            });
            const wallMesh = new THREE.Mesh(wallGeo, wallMat);
            wallMesh.position.y = cfg.wallHeight / 2;

            const wrapper = new THREE.Group();
            wrapper.add(wallMesh);
            switch (face) {
                case FACE.POS_X: wrapper.position.set( half, 0, 0); wrapper.rotation.y =  Math.PI / 2; break;
                case FACE.NEG_X: wrapper.position.set(-half, 0, 0); wrapper.rotation.y = -Math.PI / 2; break;
                case FACE.POS_Z: wrapper.position.set(0, 0,  half); wrapper.rotation.y = 0;            break;
                case FACE.NEG_Z: wrapper.position.set(0, 0, -half); wrapper.rotation.y = Math.PI;      break;
            }
            group.add(wrapper);
        }

        this._sceneGroup.add(group);
        return { group, floorMesh };
    }

    // ─── Private: helpers ─────────────────────────────────

    _clearSceneGroup() {
        while (this._sceneGroup.children.length > 0) {
            const child = this._sceneGroup.children[0];
            this._sceneGroup.remove(child);
            child.traverse(obj => {
                obj.geometry?.dispose();
                if (obj.material) {
                    (Array.isArray(obj.material) ? obj.material : [obj.material])
                        .forEach(m => m.dispose());
                }
            });
        }
    }

    _onResize(canvas) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}
