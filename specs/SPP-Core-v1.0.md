# SPP-Core v1.0

**String Particle Protocol – Core Semantic Specification**

| Field       | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Status      | Stable                                                   |
| Version     | 1.1                                                      |
| Author      | 傅忠强 (Zhongqiang Fu)                                    |
| Date        | 2026-03-14                                               |
| License     | CC BY-NC 4.0                                             |

---

## Abstract

This document defines SPP-Core, a minimal semantic protocol for describing collapsible three-dimensional spatial structures. SPP-Core provides a representation layer in which space is modeled as a network of discrete nodes, each carrying a set of directional options that describe possible spatial relationships. The protocol is independent of any specific geometry, rendering engine, or storage format.

---

## 1. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

The following terms are used throughout this specification:

- **String Particle**: A discrete 3D spatial node that carries directional spatial options. The fundamental unit of SPP-Core.
- **Face**: One of the six axial directions of a String Particle (+X, −X, +Y, −Y, +Z, −Z).
- **Option**: A reference to an external dataset that defines a possible spatial structure for a given face (e.g., wall, door, staircase). The reference format is implementation-defined.
- **Size**: A three-component integer vector defining the volumetric extent of a String Particle in grid units. Smaller sizes enable finer spatial detail; larger sizes represent coarser granularity.
- **Collapse**: The process of resolving a set of options on each face into a single concrete selection, producing a determined spatial configuration. Collapse strategies are outside the scope of this specification.
- **Superposition State**: The pre-collapse state of a String Particle in which all options coexist as possibilities.
- **Resolved State**: The post-collapse state in which each face has been resolved to exactly one option.
- **Chunk**: A container holding an ordered collection of String Particles.
- **Refinement**: An optional nested `ParticleChunk` embedded within a `ParticleCell`. A refinement subdivides the interior of its parent cell into a finer grid while the parent's `faceOptions` continue to define the boundary interface. `ParticleCell` and `ParticleChunk` are mutually recursive types by design.

---

## 2. Scope

This specification defines:

- The semantic data model for String Particles.
- The meaning of each field in the data model.
- The lifecycle stages of a String Particle (Wave Function → Classical → Concrete Space).

This specification does NOT define:

- Geometric models, materials, meshes, or any rendering data.
- Binary encoding or wire formats.
- Collapse algorithms or strategies.
- The concrete type or format of option identifiers.

---

## 3. Data Model

### 3.1 ParticleCell

A `ParticleCell` is the core data unit. Every conforming implementation MUST represent a String Particle with the following logical fields:

```
ParticleCell
├─ position    : integer3
├─ size        : integer3
├─ faceStates  : bitmask (6 bits)
├─ faceOptions : id[6][]
└─ refinement? : ParticleChunk        -- optional; see Section 3.2.5
```

`ParticleCell` and `ParticleChunk` are mutually recursive: a cell MAY contain a chunk, and a chunk contains cells. This nesting MAY continue to arbitrary depth, with each level representing a finer spatial resolution than its parent.

### 3.2 Field Definitions

#### 3.2.1 `position`

A three-component integer vector `[x, y, z]`.

- MUST represent the particle's location in a discrete 3D grid.
- Implementations MAY define their own coordinate system origin and axis orientation, but MUST document any deviation from the default right-handed coordinate system.

#### 3.2.2 `size`

A three-component integer vector `[w, h, d]` defining the volumetric extent of the particle in grid units.

- MUST represent the width, height, and depth of the space this particle occupies.
- A particle with `size = [2, 2, 2]` occupies an 8-unit volume and enables finer structural detail.
- A particle with `size = [4, 4, 4]` occupies a 64-unit volume and represents coarser granularity.
- Implementations MAY mix particles of different sizes within the same chunk to achieve multi-scale spatial descriptions.

#### 3.2.3 `faceStates`

A 6-bit bitmask indicating which faces participate in spatial relationships.

| Bit | Direction |
| --- | --------- |
| 0   | +X        |
| 1   | −X        |
| 2   | +Y        |
| 3   | −Y        |
| 4   | +Z        |
| 5   | −Z        |

- A bit value of `1` indicates the face HAS a spatial relationship (open).
- A bit value of `0` indicates the face is fully enclosed (closed).
- If a bit is `0`, the corresponding entry in `faceOptions` SHOULD be empty.

#### 3.2.4 `faceOptions`

An array of 6 elements, one per face direction. Each element is a variable-length list of option identifiers.

```
faceOptions : id[6][]
```

- Each `id` is a reference to an external dataset describing a possible spatial structure (e.g., a wall variant, a door, a staircase).
- The format and type of `id` is implementation-defined. Conforming implementations MAY use database keys, content hashes (e.g., IPFS CID), URIs, or any other identifier scheme.
- A non-empty list represents the **superposition** of that face: all concurrent possibilities before collapse.
- An empty list indicates no spatial options exist for that face.

#### 3.2.5 `refinement` (OPTIONAL)

An optional embedded `ParticleChunk` that subdivides the interior of this cell into a finer grid.

```
refinement? : ParticleChunk
  └─ cells : list<ParticleCell>   -- each at a finer resolution
```

- When present, `refinement` defines the **interior** of the cell. The parent cell's `faceOptions` continue to define the **boundary** — the interface this cell exposes to its neighbors.
- The two fields are complementary and non-overlapping in semantic scope:
  - `faceOptions` → what this cell looks like from outside (boundary)
  - `refinement`  → what this cell contains inside (interior)
- **Boundary consistency invariant**: the outer faces of the refinement's cells MUST be consistent with the parent's resolved `faceOptions`. Specifically, an edge of the refinement that is adjacent to an exterior face of the parent MUST carry the same connectivity (Open or Wall) as that face. The internal topology is unconstrained.
- A cell without a `refinement` is a **leaf node** — the finest resolved unit at its depth.
- A cell with a `refinement` is an **interior node** — its visual representation defers to the refinement's leaf nodes.
- Implementations SHOULD define a maximum nesting depth to bound rendering and processing cost.

---

## 4. Container Structure

### 4.1 ParticleChunk

A `ParticleChunk` is the minimal container for grouping String Particles.

```
ParticleChunk
└─ cells : list<ParticleCell>
              └─ ...
              └─ refinement? : ParticleChunk   -- same type, recursive
                    └─ cells : list<ParticleCell>
                                  └─ ...
```

- A chunk MUST contain zero or more `ParticleCell` entries.
- Because `ParticleCell` MAY contain a `refinement : ParticleChunk`, the full structure forms a **recursive tree**: each node is a `ParticleChunk`, and the leaves are `ParticleCell` entries without a `refinement`.
- The semantic scope of a chunk is implementation-defined. It MAY represent a room, a floor, a building, a city block, a dungeon zone, or any other spatial grouping.
- At the root level, a `ParticleChunk` describes the coarsest resolution of a space. Refinements at successive depths describe progressively finer detail within the same spatial volume.

---

## 5. Lifecycle

A String Particle progresses through three stages:

```
┌───────────────────────────────┐
│  Stage 1: Superposition       │
│  All face options coexist.    │
│  ParticleCell as defined in   │
│  this specification.          │
└──────────────┬────────────────┘
               │  Collapse
               ▼
┌───────────────────────────────┐
│  Stage 2: Resolved            │
│  Each face resolves to        │
│  exactly one option.          │
└──────────────┬────────────────┘
               │  Unfold
               ▼
┌───────────────────────────────┐
│  Stage 3: Concrete Space      │
│  Renderable, interactable     │
│  3D geometry.                 │
└───────────────────────────────┘
```

- **Stage 1** is the domain of this specification.
- **Stage 2** (collapse strategy) and **Stage 3** (rendering / unfolding) are outside the scope of this specification and are defined by their respective implementation layers.

---

## 6. Comparison with Existing Systems

This section is informative (non-normative).

| System              | Core Unit          | Essence          |
| ------------------- | ------------------ | ---------------- |
| Polygon Modeling    | Vertices / Faces   | Geometry         |
| Voxels              | Blocks             | Occupied / Empty |
| WFC                 | Tiles              | Local Rules      |
| **SPP (String Particle)** | Spatial Node + Options | Semantic Collapse |

For a discussion of spatial coverage strategies (tessellation vs. sparse placement) and multi-scale arrangements, see [SPP-Spatial-Coverage](./SPP-Spatial-Coverage.md).

---

## 7. Example

This section is informative (non-normative).

### 7.1 Basic adjacency

Two horizontally adjacent String Particles:

```
A: position = (0, 0, 0)
B: position = (1, 0, 0)
```

Face +X of A and face −X of B share a boundary. After collapse selects option `2` (Rectangular Door) for both faces:

```
→ A door connects A and B.
```

### 7.2 Recursive refinement

A coarse cell C at depth 0 represents a room. Its boundary is resolved:

```
C: position = (2, 0, 1)
   faceOptions[+X] = [10]   -- Wall (resolved)
   faceOptions[−X] = [2]    -- Door (resolved)
   faceOptions[+Z] = [10]   -- Wall (resolved)
   faceOptions[−Z] = [10]   -- Wall (resolved)
   refinement = ParticleChunk {
     cells = [               -- 2×2 finer grid inside C
       { position=(0,0,0), faceOptions=[[10],[2],[],[],[0],[10]], ... },
       { position=(1,0,0), faceOptions=[[10],[0],[],[],[10],[10]], ... },
       { position=(0,0,1), faceOptions=[[0],[10],[],[],[10],[0]], ... },
       { position=(1,0,1), faceOptions=[[10],[0],[],[],[10],[0]], ... },
     ]
   }
```

Reading this structure:

- `faceOptions` on C defines the boundary: left face is a door, other three faces are walls.
- `refinement` subdivides C's interior into a 2×2 grid with its own internal wall topology.
- The left column of the refinement (positions x=0) carries the door connection on their −X face, consistent with C's resolved `faceOptions[−X] = [2]`.
- Rendering defers entirely to the refinement's leaf cells. C itself is not drawn.

The same structure applies at any depth: any leaf cell in the refinement MAY itself carry a further `refinement`, producing a tree of arbitrary depth.

---

## 8. Generation Flow

This section is informative (non-normative).

### 8.1 Forward (generative)

A typical end-to-end forward flow:

```
1. AI generates a coarse ParticleChunk          (Stage 1 — this spec)
2. Each face carries a set of spatial options    (Stage 1 — this spec)
3. A collapse algorithm resolves each face       (Stage 2 — external)
4. Regions requiring detail → AI generates a    (Stage 1 — this spec,
   refinement ParticleChunk inside the cell      applied recursively)
5. Collapse and refine until leaf resolution     (Stage 2 — external)
6. An engine flattens the tree and unfolds       (Stage 3 — external)
   leaf nodes into 3D geometry
```

### 8.2 Inverse (reconstructive)

The recursive structure emerges naturally from the inverse pipeline:

```
Phase 1–4 (global):  observe full image → build root ParticleChunk
Phase 5 (loop):      render top-down → compare with source
  for each divergent region:
    Phase 1–4 (local): observe crop → build refinement ParticleChunk
                        attach as cell.refinement in root chunk
  re-render → repeat until converged
```

The output is a single `ParticleChunk` whose cells MAY contain `refinement` sub-chunks to arbitrary depth. The boundary consistency invariant (Section 3.2.5) is maintained at each level by passing parent face connectivity as constraints to the local Phase 1 call.

For a full description of the inverse pipeline, see [SPP-Inverse-Modeling](./SPP-Inverse-Modeling.md).

---

*End of SPP-Core v1.0 Specification.*
