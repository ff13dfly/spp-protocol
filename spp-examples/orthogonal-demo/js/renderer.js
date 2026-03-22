/**
 * renderer.js — Multi-depth Three.js renderer
 *
 * Renders SPP recursive cells with depth-based coloring.
 * Leaf cells are solid; interior (refined) cells are semi-transparent.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RecursiveGridManager } from './shim.js';

export const CELL_SIZE = 2.0;
const WALL_THICKNESS = 0.12;

const DEPTH_COLORS = [
    { wall: 0xd4886b, floor: 0xe8e0d8, height: 2.8 },  // depth 0: warm terracotta
    { wall: 0x6b8fd4, floor: 0xd8e0f0, height: 2.6 },  // depth 1: steel blue
    { wall: 0x4db89b, floor: 0xd0f0e0, height: 2.4 },  // depth 2: teal
    { wall: 0x9b6bd4, floor: 0xe8d8f8, height: 2.2 },  // depth 3: violet
    { wall: 0xd4c56b, floor: 0xf0f0d0, height: 2.0 },  // depth 4: gold
];

export class OrthoRenderer {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.group = null;
        this._isTop = false;
        this._savedPos = null;
        this._savedTarget = null;
    }

    init(canvas) {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf5f5fa);

        this.camera = new THREE.PerspectiveCamera(
            50, canvas.clientWidth / canvas.clientHeight, 0.1, 200
        );
        this.camera.position.set(5, 8, 10);

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        this.renderer.shadowMap.enabled = true;

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(8, 15, 10);
        dir.castShadow = true;
        this.scene.add(dir);
        this.scene.add(new THREE.DirectionalLight(0xc4d4ff, 0.3).translateX(-6).translateY(8).translateZ(-4));

        // Ground
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(80, 80),
            new THREE.MeshStandardMaterial({ color: 0xeeeef3, roughness: 0.9 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.01;
        ground.receiveShadow = true;
        this.scene.add(ground);

        const animate = () => {
            requestAnimationFrame(animate);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();

        window.addEventListener('resize', () => {
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        });
    }

    render(chunk) {
        if (this.group) {
            this.scene.remove(this.group);
            this.group = null;
        }
        if (!chunk || !chunk.cells.length) return;

        this.group = new THREE.Group();
        this._gridX = chunk.gridX || 1;
        this._gridZ = chunk.gridZ || 1;

        // Flatten to get leaf cells with world coordinates
        const leaves = RecursiveGridManager.flattenRecursiveCells(chunk.cells);

        // Render each leaf
        for (const leaf of leaves) {
            this._renderLeaf(leaf);
        }

        this.scene.add(this.group);

        // Entrance animation
        this.group.scale.set(0.001, 0.001, 0.001);
        const start = performance.now();
        const anim = (now) => {
            const t = Math.min(1, (now - start) / 500);
            this.group.scale.setScalar(1 - Math.pow(1 - t, 3));
            if (t < 1) requestAnimationFrame(anim);
        };
        requestAnimationFrame(anim);
    }

    _renderLeaf(cell) {
        const depth = cell._depth || 0;
        const scheme = DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)];
        const scale = cell.worldScale || 1;
        const [wx, , wz] = cell.worldPosition || [cell.position[0], 0, cell.position[2]];

        const cs = CELL_SIZE * scale;
        // Wall height is UNIFORM — real walls don't shrink when grid is subdivided
        const wallH = scheme.height;
        const cx = wx * CELL_SIZE + cs / 2;
        const cz = wz * CELL_SIZE + cs / 2;

        // Floor
        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(cs * 0.96, cs * 0.96),
            new THREE.MeshStandardMaterial({ color: scheme.floor, roughness: 0.8 })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(cx, 0.01 + depth * 0.005, cz);
        floor.receiveShadow = true;
        this.group.add(floor);

        // Walls — only where faceOptions says Wall(10) or Window(20)
        const opts = cell.faceOptions;
        if (!opts) return;

        const wallMat = new THREE.MeshStandardMaterial({
            color: scheme.wall,
            roughness: 0.6,
        });

        const wallDefs = [
            { face: 0, dx: cs / 2, dz: 0, rotY: 0 },        // +X
            { face: 1, dx: -cs / 2, dz: 0, rotY: 0 },       // -X
            { face: 4, dx: 0, dz: -cs / 2, rotY: Math.PI / 2 }, // +Z
            { face: 5, dx: 0, dz: cs / 2, rotY: Math.PI / 2 },  // -Z
        ];

        for (const wd of wallDefs) {
            const fo = opts[wd.face];
            if (!fo || fo.length === 0) continue;
            const id = fo[0];
            if (id === 0) continue; // Open

            // Wall thickness: keep visible even at high subdivision
            const thick = Math.max(WALL_THICKNESS * scale, WALL_THICKNESS * 0.5);
            const geo = new THREE.BoxGeometry(thick, wallH, cs + thick);
            const wall = new THREE.Mesh(geo, wallMat);
            wall.rotation.y = wd.rotY;
            wall.position.set(cx + wd.dx, wallH / 2, cz + wd.dz);
            wall.castShadow = true;
            wall.receiveShadow = true;
            this.group.add(wall);
        }
    }

    focusScene() {
        if (!this.group) return;
        // Use grid dimensions instead of bounding box (which is near-zero during entrance animation)
        const gx = this._gridX || 4;
        const gz = this._gridZ || 4;
        const cx = (gx * CELL_SIZE) / 2;
        const cz = (gz * CELL_SIZE) / 2;
        const maxDim = Math.max(gx, gz) * CELL_SIZE;
        this.controls.target.set(cx, 0, cz);
        this.camera.position.set(cx + maxDim, maxDim * 1.2, cz + maxDim);
        this.controls.update();
    }

    toggleTopView() {
        if (this._isTop) {
            this.camera.position.copy(this._savedPos);
            this.controls.target.copy(this._savedTarget);
            this.controls.maxPolarAngle = Math.PI * 0.48;
            this._isTop = false;
        } else {
            this._savedPos = this.camera.position.clone();
            this._savedTarget = this.controls.target.clone();
            const t = this.controls.target;
            this.camera.position.set(t.x, 30, t.z + 0.01);
            this.controls.maxPolarAngle = 0.01;
            this._isTop = true;
        }
        this.controls.update();
    }
}
