# SPP-Inverse-Modeling

**String Particle Protocol – Inverse Modeling and 3D Reconstruction**

| Field       | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Status      | Informative (non-normative)                              |
| Companion to| SPP-Core v1.0                                            |
| Author      | 傅忠强 (Zhongqiang Fu)                                    |
| Date        | 2026-03-05                                               |
| License     | CC BY-NC 4.0                                             |

---

## Abstract

SPP-Core defines a forward flow: semantic data → collapse → concrete space. This document explores the **inverse** direction: reconstructing SPP data from real-world observations. When combined with AI-driven classification, this inverse process enables editable 3D reconstruction — a capability absent from current reconstruction methods.

---

## 1. Forward vs. Inverse

SPP-Core Section 8 describes the standard generation flow:

```
Forward (generative):
  AI generates ParticleChunk → Collapse → Unfold → 3D Space
```

The inverse process reverses this direction:

```
Inverse (reconstructive):
  Real-world observation → AI fitting → Resolved ParticleChunk → Editable 3D model
```

Both directions operate on the same data model (`ParticleCell`), but serve different purposes:

| Direction | Input         | AI Task        | Output                  |
| --------- | ------------- | -------------- | ----------------------- |
| Forward   | Intent / Prompt | Generate options | Superposition → Collapse |
| Inverse   | Images / Scans  | Classify faces   | Directly Resolved state  |

---

## 2. Inverse Modeling Pipeline

### 2.1 Overview

```
Multi-view images / LiDAR scan
        │
        ▼
┌─────────────────────────┐
│  Step 1: Coarse fitting │  Large-size particles frame the overall volume.
│  size = [10, 10, 10]    │  AI determines: "building / open space / terrain"
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Step 2: Binary         │  For each cell face: Wall or Open only.
│  topology               │  Establishes structural shell; no features yet.
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Step 3: Feature        │  AI identifies doors and windows from the source
│  piercing               │  image. Wall faces replaced with feature IDs.
└───────────┬─────────────┘
            ▼
┌─────────────────────────────────────────────────┐
│  Step 4: Visual regression loop (AI-driven)     │
│                                                 │
│  ① Render top-down orthographic view            │
│  ② Frontend pixel-diff: rendered vs. source     │
│  ③ For each divergent region:                   │
│     - Crop source image to local patch          │
│     - Extract boundary connectivity (Open/Wall) │
│     - AI regenerates region as unified sub-grid │
│     - Integrate sub-grid back into structure    │
│  ④ Re-render → repeat until converged           │
│                                                 │
│  User manual selection = override / fallback    │
└───────────┬─────────────────────────────────────┘
            ▼
   Resolved ParticleChunk
   (editable, renderable, multi-depth)
```

### 2.2 Step 1 — Coarse Volume Fitting

The reconstruction begins by overlaying a grid of large particles on the observed volume. At this stage, the AI performs a coarse segmentation:

- Areas with structure receive particles.
- Empty or irrelevant areas are left uncovered (see [SPP-Spatial-Coverage](./SPP-Spatial-Coverage.md), Section 2: Sparse Coverage).
- Each particle is assigned a semantic room label directly (e.g. "Kitchen", "Bedroom"), not an abstract ID.

### 2.3 Step 2 — Binary Topology

Each cell face is classified as one of two states:

- `Open (0)` — same-room adjacency, passage continues.
- `Wall (10)` — different-room adjacency or exterior boundary.

This step focuses exclusively on the structural shell. Doors and windows are intentionally excluded and handled in Step 3.

### 2.4 Step 3 — Feature Piercing

The AI receives the source image together with the list of wall faces from Step 2, and identifies all doors and windows. Wall faces are then replaced with the corresponding feature Option ID:

- `1` — Arch Door
- `2` — Rectangular Door
- `20` — Window (exterior walls only)

This step is split into two sub-steps: an AI classification call that returns `{ x, z, face, optionId }` annotations, followed by a deterministic write pass that only replaces faces currently set to Wall.

### 2.5 Step 4 — Visual Regression Loop (Recursive Local Pipeline)

After the initial reconstruction (Steps 1–3), the system enters a feedback loop. Step 4 is not an independent "refinement" step — it is a **controller that re-executes Steps 1–3 locally** on divergent sub-regions until the reconstruction converges.

**Global first pass vs. local recursive pass:**

| | Global (Steps 1–3) | Local (Step 4 triggered) |
|--|--|--|
| Step 1 input | Full floor plan image | Cropped patch of divergent region |
| Step 1 constraint | None | Four-edge Open/Wall connectivity from parent grid |
| Steps 2–3 | Same | Same, scoped to local region |
| Output integration | Builds root grid | Replaces coarse cells in that region at next depth |

**Execution loop:**

1. **Render** the current ParticleChunk as a top-down orthographic image (image A).
2. **Compare** image A pixel-by-pixel (at cell granularity) against the source image (image B). Identify divergent regions.
3. **For each divergent region**, re-execute Steps 1–3 locally:
   - Crop image B to the region bounding box.
   - Extract boundary connectivity constraints (Open/Wall per edge) from the current cell data.
   - **Local Step 1:** AI re-grids the cropped patch within the boundary constraints.
   - **Local Step 2:** AI re-classifies binary topology for the local grid.
   - **Local Step 3:** AI re-detects doors and windows in the local patch.
   - Apply local Step 4 (deterministic piercing). Integrate result back into the main structure.
4. **Re-render** and return to step 1. Stop when no region exceeds the divergence threshold or the maximum depth is reached.

User-initiated selection (click or drag-box) triggers the identical local Steps 1–3 pipeline on demand, serving as a manual override when the automatic pass is insufficient.

#### 2.5.1 Region-Level Sub-Grids

Refinement operates at the **region level**, not the per-cell level. Selecting a 2×2 region at scale 3 produces one unified 6×6 sub-grid that occupies exactly the same world-space footprint as the original 2×2 region. The coarse cells in that region are rendered semi-transparently behind the sub-grid.

#### 2.5.2 Boundary Connectivity Constraint

The constraint passed to the AI for each refinement is minimal by design:

```
{ left: 'open' | 'wall', right: 'open' | 'wall',
  top:  'open' | 'wall', bottom: 'open' | 'wall' }
```

A side is `open` if any face on that edge is Open; `wall` if all faces are non-Open. The AI must ensure that the sub-grid's corresponding edges respect this connectivity, but is otherwise free to place internal walls anywhere.

This minimal constraint is sufficient for spatial consistency while maximising the AI's freedom to capture local detail.

#### 2.5.3 Token Efficiency

Sending only a small cropped image patch (instead of the full floor plan) and four single-word constraints (instead of the full topology JSON) reduces the token cost of each refinement call by approximately one order of magnitude compared to resending the full context.

### 2.6 Step 3 (original) — Face-Level Semantic Classification

> **Note:** This section is retained for reference. In the current floor-plan pipeline, face classification is split into Step 2 (binary topology) and Step 3 (feature piercing) as described above.

For each face of each refined particle, the AI selects an Option ID. This is the core step, and it differs fundamentally from traditional reconstruction:

| Traditional reconstruction | SPP inverse modeling              |
| -------------------------- | --------------------------------- |
| Output: continuous 3D coordinates | Output: discrete Option ID  |
| Task: regression (∞ output space) | Task: classification (N choices) |
| Result: unstructured point cloud  | Result: structured semantic graph |

The classification target per face is: given the visual evidence from the input images, which registered option (from the Option Registry) best describes this face?

---

## 3. The Classification Advantage

The most significant theoretical property of SPP inverse modeling is the **reduction from regression to classification**.

Traditional 3D reconstruction requires predicting continuous 3D coordinates for every surface point — an output space that is effectively infinite. SPP inverse modeling reduces this to selecting from a finite set of registered options per face.

```
Traditional:  f(images) → ℝ³ per point     (regression, infinite output space)
SPP:          f(images) → {0, 1, 2, ..., N} per face  (classification, finite output space)
```

Consequences:

- **Higher reliability**: Classification models are more robust than regression models at comparable scales.
- **Verifiable output**: Each predicted ID can be validated against the Option Registry.
- **Graceful degradation**: A misclassified face produces a wrong-but-valid structure (e.g., a wall instead of a door), not a corrupted mesh.

### 3.1 Unified View: Forward and Inverse

The classification advantage applies equally in both directions of the SPP lifecycle:

| Direction | Mainstream approach | SPP approach |
| --------- | ------------------- | ------------ |
| **Forward** (generation) | AI outputs vertex coordinates, UVs, material parameters (regression over continuous space) | AI outputs Option IDs per face (selection from finite set) |
| **Inverse** (reconstruction) | AI predicts 3D point positions or radiance fields (regression) | AI classifies each face against Option Registry (selection from finite set) |

In both cases, SPP transforms the task from an open-ended **fill-in-the-blank** problem into a constrained **multiple-choice** problem. This is not an incremental improvement — it is a change in problem type. Classification models are fundamentally more reliable, verifiable, and composable than regression models at comparable scale.

Furthermore, errors in classification are **semantic** (a door becomes a wall) rather than **structural** (a mesh tears open). Semantic errors preserve scene validity and are correctable by changing a single ID; structural errors typically require full regeneration.

---

## 4. Editability

A key benefit of SPP-based reconstruction over NeRF, 3D Gaussian Splatting, or mesh reconstruction is that the output is **natively editable at the semantic level**.

| Operation          | NeRF / 3DGS        | Mesh            | SPP                     |
| ------------------ | ------------------- | --------------- | ------------------------ |
| Move a door        | ✗ Not possible      | ✗ Complex re-mesh | ✓ Change one face ID     |
| Replace wall type  | ✗ Not possible      | ✗ Re-model      | ✓ Change one face ID     |
| Add a floor        | ✗ Not possible      | ✗ Manual work   | ✓ Add cells with options |
| Change visual style| ✗ Re-train          | Partial         | ✓ Swap Unfold layer      |

Editing a reconstructed SPP model requires only changing Option IDs — the same operation used in forward (generative) mode. The reconstructed model is indistinguishable in format from one that was generated from scratch.

---

## 5. Size, Precision, and Practical Limits

### 5.1 Size–Precision Relationship

| Particle size      | Spatial precision | Typical use case      |
| ------------------ | ----------------- | --------------------- |
| `[10, 10, 10]`    | ~10 m             | City blocks, terrain  |
| `[1, 1, 1]`       | ~1 m              | Rooms, corridors      |
| `[0.1, 0.1, 0.1]` | ~10 cm            | Furniture, fixtures   |
| `[0.01, 0.01, 0.01]`| ~1 cm            | Small objects, details|

### 5.2 Practical Lower Bound

As particle size decreases:

- Cell count grows cubically (halving size → 8× cells).
- The Option Registry must shift to match the new scale's vocabulary.
- Below a critical size, spatial relationships can no longer be meaningfully reduced to face-level options — at that point, direct geometry (mesh, SDF) becomes more appropriate.

### 5.3 Optimal Domain

SPP inverse modeling is most effective for spaces that are:

- **Structured**: composed of planar surfaces and regular patterns.
- **Repetitive**: a finite vocabulary of face types covers most of the space.
- **Semantically enumerable**: face types can be named and registered.

This includes: buildings, interiors, furniture, urban environments, game levels, industrial facilities.

It excludes: organic shapes (trees, terrain), artistic sculptures, sub-centimeter surface detail.

### 5.4 Hybrid Precision via Extended Options

The practical lower bound described in Section 5.2 is not a hard limit. SPP-Core specifies that Option IDs are **references to external datasets** with an implementation-defined format. This means an Option ID may reference any content type:

| Option ID range | Content type              | Precision       |
| --------------- | ------------------------- | --------------- |
| `0–99`          | Parametric description    | Semantic level  |
| `1000–1999`     | Polygon mesh (`.glb`)     | Millimeter      |
| `2000–2999`     | Signed distance field     | Continuous      |
| `3000–3999`     | NeRF checkpoint           | Photorealistic  |
| `4000–4999`     | Procedural generator (WASM) | Adaptive       |

The above ranges are illustrative; any partitioning scheme is valid.

#### 5.4.1 Mixed-Precision Reconstruction

In practice, most spaces contain a mix of standard and non-standard elements. A hybrid approach applies standard semantic options where they suffice and falls back to high-fidelity assets where they do not:

```
Building reconstruction (mixed precision):

  Standard walls   → Option 10 (brick wall, parametric)      ← classification
  Standard doors   → Option 1  (arch door, parametric)       ← classification
  Ornate entrance  → Option 5001 → carved_gate.glb           ← mesh reference
  Curved roofline  → Option 5002 → roof_surface.sdf          ← SDF reference
  Courtyard tree   → Option 5003 → tree_capture.ckpt         ← NeRF reference
```

From the protocol's perspective, all five lines are identical: a face carrying a single resolved Option ID. The heterogeneity exists only in the Option Registry's backend, not in the SPP data itself.

#### 5.4.2 AI Compatibility

Extending the Option Registry does not change the AI's task type. The model still performs classification — selecting one ID from a set of candidates:

```
Two-stage classification:

  Stage 1 (fast): Is this face standard or non-standard?
    → Standard:     classify among {0, 1, 2, 10, 11, 12, 13, ...}
    → Non-standard: proceed to Stage 2

  Stage 2 (precise): Which registered asset best matches this face?
    → classify among {5001, 5002, 5003, ...}
    → or flag as "new asset needed" for manual creation
```

This two-stage approach keeps the common path fast (most faces in structured spaces match standard options) while allowing arbitrary precision for exceptional cases.

#### 5.4.3 Implications

This extensibility means SPP functions as a **spatial organization layer** that is agnostic to the precision of its content:

- Standard options provide semantic-level descriptions (the protocol's sweet spot).
- Extended options provide geometry-level or appearance-level descriptions (traditional methods).
- Both coexist within the same `faceOptions` data model.
- The AI classification paradigm remains intact regardless of content complexity.

The protocol does not need to understand meshes, SDFs, or NeRF checkpoints. It only needs to store and transmit their identifiers. Content interpretation is entirely the responsibility of the Unfold layer (SPP-Core Stage 3).

---

## 6. Relationship to Existing Methods

SPP inverse modeling does not replace traditional reconstruction — it occupies a different niche:

```
                    Pixel-level fidelity
                         ▲
                         │
              NeRF ●     │
                         │
           3DGS ●        │
                         │
          Mesh ●         │
                         │
                         │         ● SPP
                         │
                         └──────────────────► Editability
```

SPP trades pixel-level fidelity for semantic editability. The two approaches are complementary: a NeRF can capture visual appearance; SPP can capture spatial structure. A combined pipeline might use NeRF for texture reference and SPP for the editable spatial skeleton.

---

*End of SPP-Inverse-Modeling.*
