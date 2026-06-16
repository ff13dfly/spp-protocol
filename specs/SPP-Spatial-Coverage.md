# SPP-Spatial-Coverage

**String Particle Protocol – Spatial Coverage Theory**

| Field       | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Status      | Informative (non-normative)                              |
| Companion to| SPP-Core v1.0                                            |
| Author      | 傅忠强 (Zhongqiang Fu)                                    |
| Date        | 2026-03-05                                               |
| License     | CC BY-NC 4.0                                             |

---

## Abstract

This document explores the spatial coverage properties of String Particle arrangements. It clarifies that SPP-Core does not require complete spatial tessellation (space-filling), and examines both tessellated and sparse arrangements, their theoretical implications, and practical applications.

---

## 1. Tessellation Coverage

A **tessellated** arrangement is one in which ParticleCells fill a region of space without gaps or overlaps.

The simplest tessellation unit is the cube (a ParticleCell with equal `size` components). Cubes are one of the five convex polyhedra capable of monohedral tessellation of three-dimensional Euclidean space.

In a tessellated arrangement:

- Every point in the covered region belongs to exactly one ParticleCell.
- Every internal face is shared by exactly two adjacent cells.
- The resulting face-adjacency graph is **complete** — all spatial relationships within the region are described.

```
Tessellated (no gaps):

■ ■ ■ ■ ■
■ ■ ■ ■ ■
■ ■ ■ ■ ■
```

Tessellated arrangements are best suited for:

- Building interiors (rooms, corridors, staircases)
- Urban layouts (city blocks, streets)
- Game levels requiring full spatial control

---

## 2. Sparse Coverage

SPP-Core does not require tessellation. A `ParticleChunk` MAY contain a sparse set of cells with uncovered regions between them.

```
Sparse (with gaps):

■   ■   ■
  ■   ■
■   ■   ■
```

In a sparse arrangement:

- Covered cells and their face relationships remain **fully valid and semantically meaningful**.
- Uncovered regions are **outside the scope of the protocol** — SPP makes no assertion about them.
- Uncovered space is not "empty" (which would be a positive assertion, e.g., `faceOptions = [0]`); it is **undescribed**.

### 2.1 Undescribed vs. Empty

| Concept       | SPP Representation              | Meaning                                  |
| ------------- | ------------------------------- | ---------------------------------------- |
| **Empty**     | `faceOptions[face] = [0]`      | "This face is explicitly open/clear."    |
| **Undescribed**| No ParticleCell at that position | "The protocol has no assertion here."    |

This distinction is important: an implementation MAY render undescribed regions as void, fog, sky, terrain, or simply omit them. The protocol is silent.

### 2.2 Applications of Sparse Coverage

| Pattern              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| **Floating islands** | Clusters of cells separated by undescribed void      |
| **Underground**      | Only excavated areas have cells; surrounding rock is undescribed |
| **Bridge / corridor**| Two rooms connected by a narrow chain of cells       |
| **Procedural growth**| Start with one cell, expand organically              |

---

## 3. Multi-Scale Coverage

SPP-Core's `size` field enables particles of different volumetric extents to coexist within the same chunk.

```
ParticleCell
├─ size = [1, 1, 1]     → fine detail (room-scale)
├─ size = [4, 4, 4]     → medium detail (building-scale)
└─ size = [100, 100, 100] → coarse detail (city-block-scale)
```

A multi-scale arrangement allows **adaptive resolution**:

```
┌─────────────────────────────────────┐
│          size = [100]               │  ← city block
│  ┌──────────┐                      │
│  │ size=[10]│  ← building          │
│  │ ┌──┬──┐  │                      │
│  │ │1 │1 │  │  ← rooms             │
│  │ ├──┼──┤  │                      │
│  │ │1 │1 │  │                      │
│  │ └──┴──┘  │                      │
│  └──────────┘                      │
└─────────────────────────────────────┘
```

This pattern mirrors human spatial cognition: high detail for nearby or important areas, low detail for distant or peripheral areas.

### 3.1 Hierarchical Expansion

A large particle MAY be replaced by a grid of smaller particles at runtime — a process analogous to "zooming in":

```
Stage 1:  One particle [size = 10]
              ↓  Expand
Stage 2:  A 10×10 grid of particles [size = 1], each with its own faceOptions
              ↓  Collapse
Stage 3:  A detailed spatial structure within the original footprint
```

This expansion is recursive: any cell at any scale MAY be further subdivided, enabling theoretically unbounded spatial resolution.

---

## 4. Theoretical Boundaries

### 4.1 What SPP Can Describe

Any **discrete, structured, face-connected spatial arrangement** can be represented in SPP, provided:

1. The space is decomposable into convex polyhedral cells.
2. Spatial relationships between cells are expressible as face-level options.
3. An Option Registry exists with sufficient entries to cover the required face types.

### 4.2 What SPP Cannot Describe

| Limitation                      | Reason                                                |
| ------------------------------- | ----------------------------------------------------- |
| Continuous curved surfaces      | Cells are polyhedral; curves require fine approximation |
| Organic / amorphous geometry    | No encoding for non-planar or irregular faces          |
| Sub-face detail                 | Granularity is per-face, not per-point                 |
| Material / texture properties   | Outside protocol scope (rendering layer concern)       |

### 4.3 Sufficiency Condition

A space can be fully described by SPP if and only if:

> **Every spatial relationship of interest can be reduced to a face-level option between adjacent cells.**

This condition holds for the vast majority of human-made architectural and urban spaces.

---

## 5. Connectivity as Surface — Fitting Organic Geometry (Design Note)

> Non-normative. Captures a recurring design question: *can SPP's connectivity
> states be used to fit a complex/organic 3D surface (e.g. a human face)?* This
> section records the reasoning and a minimal empirical check so it isn't re-derived.

### 5.1 The idea

Rather than filling a volume with tiny solid cells, choose **which faces are
connected (Open) vs. barriers (Wall)**; the boundary between connected and
unconnected regions *is* a closed surface. Sculpt that boundary to fit a target.
The instinct is sound — the Open/Wall boundary is a well-defined surface.

### 5.2 The degeneracy: connectivity carries shape only where there is topology

Connectivity is an **independent degree of freedom only when the space has
topology** — two solid cells can still be separated by a Wall or joined by a Door
(meaningful for rooms). For a **solid organic blob** (a face is a solid bust),
each cell is merely *inside* or *outside*; whether a face is a Wall is fully
determined by the occupancy of its two sides. So:

> For a solid object, "choosing connectivity" ≡ "choosing occupancy" — the shape
> lives entirely in the **boundary location**, and you are voxelizing by another name.

With the current vocabulary (axis-aligned **flat** Open/Wall faces, §4.2) the best
achievable boundary is a **staircase** — exactly the "Continuous curved surfaces"
and "Sub-face detail" limitations of §4.2.

### 5.3 The viable extension: a geometric face vocabulary

The limit is the **vocabulary**, not the grid or the recursion (§3). Replace the
*semantic* options (Wall/Door/Window) with **geometric surface-patch options**
(flat, slanted, convex/concave corner …) and assign one patch per boundary cell
at its zero-crossing. This is **Marching Cubes / Dual Contouring / Surface Nets**.
Notably, SPP's collapse-as-classification framing **survives**: each cell still
picks one option from a *finite* case set — the regression→classification reframe
of SPP-Inverse-Modeling still applies, just with a geometric registry. SPP-Core
already hints this way (`Half-height Wall` is a partial-geometry face; SPP-Inverse
§5.4 "Hybrid Precision" lets an Option ID reference an external SDF/mesh/NeRF).

### 5.4 Minimal empirical check

`scripts/surface-fit-demo.mjs` extracts the **same** cell grid two ways and
measures RMS distance to the true surface (in cell-widths):

| Target | Grid | Blocky (flat Open/Wall) | Geometric patch (Surface-Nets) |
| ------ | ---- | ----------------------- | ------------------------------ |
| Sphere (pure blob) | 43³ | RMS **0.20** (faceted) | RMS **0.02** (smooth) |
| Torus (has a hole) | 43³ | RMS **0.20** (faceted) | RMS **0.03** (smooth) |

Same container, ~same face count — the geometric vocabulary fits ~7–10× closer.
This confirms the grid *can* fit organic surfaces; fidelity is gated by the
per-cell face vocabulary.

### 5.5 Verdict and boundaries

- **As shipped** (semantic flat faces): organic-surface fitting → staircase. Not suitable for a face.
- **As an extension** (geometric patch vocabulary): viable and even elegant — but it
  is *dual contouring with SPP as the adaptive container*. The surface-fidelity
  machinery (case table, QEF/normal fitting for sharp features) is established
  graphics; SPP contributes the multi-scale container and the per-cell classification.
- **Still external**: (a) a target SDF/point-cloud to fit *against*, and (b) the
  image→3D front-end (photogrammetry / NeRF / 3DMM / Gaussian splatting). SPP
  reconstructs neither — it stores/refines a structure.
- **Where the connectivity idea pays off**: shapes with **real topology** — holes,
  passages, mechanical cavities, semi-open architecture — not smooth solid blobs,
  for which dedicated representations dominate.

---

*End of SPP-Spatial-Coverage.*
