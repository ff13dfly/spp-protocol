/**
 * animations.js — Cascade collapse animation system
 *
 * Flow:
 * 1. Ghost grid appears (fade in)
 * 2. Cells collapse one by one from center (ghost → resolved)
 * 3. Collapse back: resolved → ghost → fade out → center only
 */

import * as THREE from 'three';

// ─── Easing ─────────────────────────────────────────────────

function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
    return t * t * t;
}

// ─── Face Cycling ───────────────────────────────────────────

export function updateFaceCycling(faceGroups, time) {
    const cycleSpeed = 1.2;
    for (const faceIndex in faceGroups) {
        const options = faceGroups[faceIndex];
        if (options.length === 0) continue;
        const activeIndex = Math.floor((time / cycleSpeed) + Number(faceIndex) * 0.7) % options.length;
        for (let i = 0; i < options.length; i++) {
            const { mesh } = options[i];
            if (mesh) mesh.visible = (i === activeIndex);
        }
    }
}

// ─── Grid Appear Animation ──────────────────────────────────

/**
 * Fade in ghost blocks from center outward.
 * @param {Map<string, THREE.Group>} ghostMap
 * @param {number} duration
 */
export function createGridAppearAnimation(ghostMap, duration = 0.8) {
    const items = [];

    for (const [key, ghost] of ghostMap) {
        const [x, z] = ghost.userData.gridPos;
        const dist = Math.abs(x) + Math.abs(z); // Manhattan distance from center
        const delay = dist * 0.06;

        ghost.scale.set(0.001, 0.001, 0.001);
        ghost.visible = true;

        items.push({ ghost, delay, dist });
    }

    let elapsed = 0;
    let done = false;

    return {
        update(dt) {
            if (done) return true;
            elapsed += dt;
            let allDone = true;

            for (const item of items) {
                const t = Math.max(0, Math.min(1, (elapsed - item.delay) / duration));
                if (t < 1) allDone = false;
                const e = easeOutBack(t);
                const s = Math.max(0.001, e);
                item.ghost.scale.set(s, s, s);
            }

            if (allDone) {
                done = true;
                for (const item of items) item.ghost.scale.set(1, 1, 1);
            }
            return done;
        },
        isDone() { return done; },
    };
}

// ─── Cascade Collapse Animation ─────────────────────────────

/**
 * Step-by-step collapse: ghost → resolved cell.
 * Each cell takes `cellDuration` seconds to resolve.
 * Cells are staggered by `cellDelay`.
 *
 * @param {Array} collapseOrder — [{key, resolvedGroup, ghostGroup}]
 * @param {number} cellDuration — seconds per cell transition
 * @param {number} cellDelay — seconds between each cell start
 */
export function createCascadeAnimation(collapseOrder, cellDuration = 0.4, cellDelay = 0.08) {
    // collapseOrder[0] is center (skip, it's already visible)
    const items = collapseOrder.map((item, index) => ({
        ...item,
        startTime: index * cellDelay,
        started: false,
        finished: false,
    }));

    let elapsed = 0;
    let done = false;

    return {
        update(dt) {
            if (done) return true;
            elapsed += dt;
            let allDone = true;

            for (const item of items) {
                if (item.finished) continue;

                if (elapsed < item.startTime) {
                    allDone = false;
                    continue;
                }

                if (!item.started) {
                    item.started = true;
                    // Hide ghost, show resolved
                    if (item.ghostGroup) item.ghostGroup.visible = false;
                    if (item.resolvedGroup) {
                        item.resolvedGroup.visible = true;
                        item.resolvedGroup.scale.set(0.001, 0.001, 0.001);
                    }
                }

                const localT = (elapsed - item.startTime) / cellDuration;
                const t = Math.min(1, localT);

                if (item.resolvedGroup) {
                    const e = easeOutBack(t);
                    const s = Math.max(0.001, e);
                    item.resolvedGroup.scale.set(s, s, s);
                }

                if (t >= 1) {
                    item.finished = true;
                    if (item.resolvedGroup) item.resolvedGroup.scale.set(1, 1, 1);
                } else {
                    allDone = false;
                }
            }

            if (allDone) done = true;
            return done;
        },
        isDone() { return done; },
    };
}

// ─── Collapse Back Animation ────────────────────────────────

/**
 * Phase 1: Resolved cells fade to ghost blocks (reverse order)
 * Phase 2: Ghost blocks shrink away
 * Phase 3: Only center remains
 *
 * @param {Array} resolvedGroups — list of THREE.Group
 * @param {Map} ghostMap — posKey → ghost group
 */
export function createCollapseBackAnimation(resolvedGroups, ghostMap, duration = 1.5) {
    const totalItems = resolvedGroups.length;
    const phase1Duration = duration * 0.5;  // resolved → ghost
    const phase2Duration = duration * 0.5;  // ghost → gone

    // Reverse order items for collapse (outer first)
    const items = resolvedGroups.map((rg, i) => {
        const [x, z] = rg.userData.gridPos || [0, 0];
        const dist = Math.abs(x) + Math.abs(z);
        return { resolvedGroup: rg, dist, gridPos: [x, z] };
    }).sort((a, b) => b.dist - a.dist); // outer first

    let elapsed = 0;
    let done = false;

    return {
        update(dt) {
            if (done) return true;
            elapsed += dt;

            if (elapsed < phase1Duration) {
                // Phase 1: shrink resolved cells (outer first)
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const delay = (i / items.length) * phase1Duration * 0.8;
                    const lt = Math.max(0, Math.min(1, (elapsed - delay) / (phase1Duration * 0.5)));
                    const e = easeInCubic(lt);
                    const s = Math.max(0.001, 1 - e * 0.999);
                    item.resolvedGroup.scale.set(s, s, s);

                    if (lt >= 1) {
                        item.resolvedGroup.visible = false;
                        // Show ghost briefly
                        const key = `${item.gridPos[0]},${item.gridPos[1]}`;
                        const ghost = ghostMap.get(key);
                        if (ghost) {
                            ghost.visible = true;
                            ghost.scale.set(1, 1, 1);
                        }
                    }
                }
            } else {
                // Phase 2: shrink ghosts inward
                const p2t = (elapsed - phase1Duration) / phase2Duration;

                for (const [key, ghost] of ghostMap) {
                    const [x, z] = ghost.userData.gridPos;
                    const dist = Math.abs(x) + Math.abs(z);
                    const maxDist = 6;
                    const delay = (1 - dist / maxDist) * 0.5; // inner last
                    const lt = Math.max(0, Math.min(1, (p2t - delay) / 0.5));
                    const e = easeInCubic(lt);
                    const s = Math.max(0.001, 1 - e * 0.999);
                    ghost.scale.set(s, s, s);
                    if (lt >= 1) ghost.visible = false;
                }

                if (p2t >= 1.2) done = true;
            }

            return done;
        },
        isDone() { return done; },
    };
}
