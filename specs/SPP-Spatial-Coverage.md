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

*End of SPP-Spatial-Coverage.*
