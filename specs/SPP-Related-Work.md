# SPP-Related-Work

**String Particle Protocol – Related Work & Prior Art**

| Field        | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Status       | Informative (non-normative)                              |
| Companion to | SPP-Core v1.0                                            |
| Author       | 傅忠强 (Zhongqiang Fu)                                    |
| Date         | 2026-06-16                                               |
| License      | CC BY-NC 4.0                                             |

---

## Abstract

This document positions SPP against existing protocols, standards, and algorithms.
There is no single prior work that *is* SPP; rather, SPP sits at the intersection
of four established lineages. Each individual mechanism has precedent — the
contribution is the **combination**: a minimal, semantic, face-connectivity,
collapse-resolved, recursively multi-scale spatial protocol that runs **both**
forward (generation) and inverse (reconstruction-as-classification), with spatial
logic separated from visual representation. This note records the comparison so
"how is this different from X?" does not have to be re-answered each time.

---

## 1. Constraint-collapse generation — Wave Function Collapse & Model Synthesis

- **Wave Function Collapse** (Gumin, 2016): each cell holds a domain of possible
  tiles; the algorithm picks a cell to **collapse**, then **propagates** adjacency
  constraints to neighbors. SPP's "collapse process that resolves possibilities
  into a consistent configuration" is the same mechanism — `faceOptions` ≈ a cell's
  candidate domain, face connectivity ≈ adjacency rules.
- **Model Synthesis** (Merrell, 2007–2011): the academic predecessor of WFC, framed
  as a constraint-satisfaction problem (AC-4 to prune labels violating adjacency),
  for 2D and 3D.

**Shared:** per-cell option domains, adjacency constraints, collapse/propagation.
**SPP differs:** WFC/Model Synthesis are purely **generative** and **semantics-free**
(tiles are abstract, not Wall/Door/Window), with no perception/inverse direction.
SPP adds a semantic face vocabulary and an image→structure inverse path.

## 2. Semantic boundary models — CityGML & IFC

These are the closest **actual interoperability standards** in SPP's conceptual space.

- **CityGML**: semantic 3D city models with explicit boundary-surface classes
  (WallSurface, RoofSurface, doors, windows), explicit relations ("a door belongs to
  the wall that contains it"), and **multi-scale via 5 LODs** (LOD0 footprint →
  LOD4 interiors) — parallel to SPP's semantic faces + multi-scale refinement.
- **IFC** (BIM): even closer on one point — **doors/windows are openings that pierce
  walls**, mirroring SPP's "feature piercing" (a door/window option overwriting a
  Wall face).

**Shared:** semantic Wall/Door/Window faces, multi-scale, separation of spatial
semantics from rendering, explicit door-in-wall relations.
**SPP differs:** CityGML/IFC are explicit B-rep / parametric solids authored by
CAD/BIM tools — not a grid-cell + collapse model, and not AI-generative. SPP
discretizes onto cells, resolves by collapse, and is designed for AI generation.

## 3. AI-native structured reconstruction — SceneScript

The strongest modern parallel, and the one most likely to be raised.

- **SceneScript** (Meta, ECCV 2024): reconstructs a scene as a **sequence of
  structured-language commands** (`make_wall`, `make_door`, `make_window`) via an
  autoregressive transformer from visual data; explicitly "departs from meshes,
  voxel grids, point clouds or radiance fields"; extends by adding commands.

**Shared:** image → a discrete, semantic, **structured** scene description (not a
mesh/point cloud), decoupled from rendering; reconstruction reframed as producing a
finite structured vocabulary; extensibility by adding vocabulary entries.
**SPP differs:** SceneScript is a token **sequence** decoded by a transformer; SPP
is a **grid of cells with face options** resolved by collapse/classification.
SceneScript is a model + representation; SPP is closer to a data **protocol/format**.
They are cousins solving the same "structured semantics instead of a mesh" problem.

## 4. Sparse recursive containers — SVO / OpenVDB / O-Voxel

- **Sparse Voxel Octree** / **OpenVDB**: hierarchical octree subdivision storing only
  occupied/surface cells — SPP's sparse coverage + recursive refinement container.
- **O-Voxel** (2025): structured sparse-voxel latent encoding geometry + appearance,
  modeling arbitrary topology.

**Shared:** sparse, recursively subdivided multi-scale grid as the spatial container.
**SPP differs:** these store **geometry/occupancy/appearance** (color, density, SDF,
PBR) with no semantic face-connectivity vocabulary, no collapse, no doors/windows.
SPP borrows the container and layers semantics + connectivity on top. (Conversely,
for the smooth/organic surfaces SPP is *not* built for — see SPP-Spatial-Coverage §5 —
these containers, plus dual contouring, are the right tools.)

---

## 5. Summary

| If you focus on SPP's… | Closest prior art | Its nature |
| ---------------------- | ----------------- | ---------- |
| Collapse + adjacency-constraint generation | WFC / Model Synthesis | algorithm |
| Semantic Wall/Door/Window + multi-scale + logic≠visuals | **CityGML / IFC** | interoperability standard |
| AI image→structured-semantic reconstruction | **SceneScript** | research model + representation |
| Sparse recursive multi-scale container | SVO / OpenVDB / O-Voxel | geometry container |

- **Closest at the standard/protocol level:** CityGML and IFC.
- **Closest living research idea:** WFC (collapse) + SceneScript (AI inverse).
- **What is distinctive about SPP:** not any single ingredient, but their union into a
  minimal, bidirectional (generate *and* reconstruct), semantic, recursively
  multi-scale protocol. No single lineage above covers all of it simultaneously.

A practical implication for design: the mechanisms above are the natural ones to
**borrow from and benchmark against** — SceneScript's command-style extensibility,
CityGML's LOD semantics, WFC's constraint propagation, SVO's sparse recursion.

---

## References

- Gumin, M. *Wave Function Collapse algorithm* (2016). Explainer: <https://www.boristhebrave.com/2020/04/13/wave-function-collapse-explained/>
- Merrell, P. *Model Synthesis* (PhD dissertation, 2009) and *Example-Based Model Synthesis*. Code: <https://github.com/merrell42/model-synthesis>
- Avetisyan et al. *SceneScript: Reconstructing Scenes With An Autoregressive Structured Language Model* (Meta, ECCV 2024). arXiv:2403.13064 — <https://arxiv.org/abs/2403.13064>
- Gröger & Plümer. *CityGML – Interoperable semantic 3D city models* (ISPRS, 2012). <https://www.sciencedirect.com/science/article/abs/pii/S0924271612000779>
- buildingSMART. *Industry Foundation Classes (IFC)*. IFC→CityGML LOD3: <https://github.com/tum-gis/ifc-to-citygml3>
- Laine & Karras. *Efficient Sparse Voxel Octrees* (2010). Overview: <https://en.wikipedia.org/wiki/Sparse_voxel_octree>
- *Native and Compact Structured Latents for 3D Generation (O-Voxel)* (2025). arXiv:2512.14692 — <https://arxiv.org/html/2512.14692v1>

---

*End of SPP-Related-Work.*
