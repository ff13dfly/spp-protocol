/**
 * animations.js — Transition effects for expand/collapse/cycling
 */

import * as THREE from 'three';
import { CELL_SIZE } from './renderer-3d.js';

// ─── Easing ─────────────────────────────────────────────────

function easeOutExpo(t) {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function easeInExpo(t) {
    return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

// ─── Face Cycling (Superposition Visualization) ─────────────

export function updateFaceCycling(faceGroups, time) {
    const cycleSpeed = 1.2; // seconds per option

    for (const faceIndex in faceGroups) {
        const options = faceGroups[faceIndex];
        if (options.length === 0) continue;

        const activeIndex = Math.floor((time / cycleSpeed) + Number(faceIndex) * 0.7) % options.length;

        for (let i = 0; i < options.length; i++) {
            const { mesh } = options[i];
            if (mesh) {
                mesh.visible = (i === activeIndex);
            }
        }
    }
}

// ─── Expand Animation ───────────────────────────────────────

/**
 * All children of mazeGroup start at origin, scale up and fly out to their positions.
 */
export function createExpandAnimation(mazeGroup, duration = 1.8) {
    const items = [];
    const origin = new THREE.Vector3(0, 0, 0);

    // Calculate maze center for centering the expansion
    let cx = 0, cz = 0, count = 0;
    mazeGroup.children.forEach(child => {
        cx += child.position.x;
        cz += child.position.z;
        count++;
    });
    const center = new THREE.Vector3(cx / count, 0, cz / count);

    mazeGroup.children.forEach((child, index) => {
        const target = child.position.clone();
        // Distance from center determines delay (ripple effect)
        const dist = target.distanceTo(center);
        const maxDist = 80; // large enough
        const delay = (dist / maxDist) * 0.6;

        items.push({
            obj: child,
            target,
            delay,
        });

        // Start at center
        child.position.copy(center);
        child.scale.set(0.001, 0.001, 0.001);
        child.visible = true;
    });

    let elapsed = 0;
    let done = false;

    return {
        update(dt) {
            if (done) return true;
            elapsed += dt;

            let allDone = true;
            for (const item of items) {
                const t = Math.max(0, Math.min(1, (elapsed - item.delay) / duration));
                const e = easeOutExpo(t);

                item.obj.position.lerpVectors(center, item.target, e);
                const s = Math.max(0.001, e);
                item.obj.scale.set(s, s, s);

                if (t < 1) allDone = false;
            }

            if (allDone) {
                done = true;
                for (const item of items) {
                    item.obj.position.copy(item.target);
                    item.obj.scale.set(1, 1, 1);
                }
            }
            return done;
        },
        isDone() { return done; },
    };
}

// ─── Collapse Animation ─────────────────────────────────────

export function createCollapseAnimation(mazeGroup, duration = 1.0) {
    const items = [];

    let cx = 0, cz = 0, count = 0;
    mazeGroup.children.forEach(child => {
        cx += child.position.x;
        cz += child.position.z;
        count++;
    });
    const center = new THREE.Vector3(cx / count, 0, cz / count);

    mazeGroup.children.forEach((child, index) => {
        const start = child.position.clone();
        const dist = start.distanceTo(center);
        const maxDist = 80;
        const delay = (1 - dist / maxDist) * 0.3; // inner cells collapse first

        items.push({
            obj: child,
            start,
            delay,
        });
    });

    let elapsed = 0;
    let done = false;

    return {
        update(dt) {
            if (done) return true;
            elapsed += dt;

            let allDone = true;
            for (const item of items) {
                const t = Math.max(0, Math.min(1, (elapsed - item.delay) / duration));
                const e = easeInExpo(t);

                item.obj.position.lerpVectors(item.start, center, e);
                const s = Math.max(0.001, 1 - e * 0.999);
                item.obj.scale.set(s, s, s);

                if (t < 1) allDone = false;
            }

            if (allDone) done = true;
            return done;
        },
        isDone() { return done; },
    };
}
