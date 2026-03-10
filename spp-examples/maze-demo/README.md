# SPP Maze Demo

A browser-based demonstration of the SPP (String Particle Protocol) forward generation pipeline — from superposition to collapse to 3D space.

## What It Does

1. A single **ParticleCell** (box) is displayed, with each face showing its available options
2. **Double-click** the box — a cascade collapse algorithm generates a 30–50 cell maze
3. The superposition resolves into concrete 3D space: walls, doors, arches, hedges
4. Explore the maze from any angle in full 3D
5. **Double-click** the maze — it contracts back into a single particle, ready to generate a new maze

## How to Run

1. Host a local HTTP server in the project root:
   ```bash
   # From the spp-protocol root directory
   npx serve .
   ```
   Or use VSCode Live Server.

2. Open the demo page in a browser. No API key needed — maze generation is fully algorithmic.

## Architecture

| File | Role |
|---|---|
| `index.html` | Layout, styles, and Three.js importmap |
| `js/main.js` | UI logic, Three.js scene, double-click interactions, animations |
| `js/maze-generator.js` | Cascade collapse algorithm (BFS expansion from center cell) |
| `js/renderer-3d.js` | Three.js wall/floor rendering from `ParticleCell` data |
| `js/animations.js` | Expand/contract transition animations |
| `js/particle.js` | Re-exports from [`spp-lib/spp-core.js`](../../spp-lib/spp-core.js) |

## Key Concepts Demonstrated

- **Superposition → Collapse**: Each cell starts with all face options available. The cascade algorithm resolves each face to a single option, producing a consistent spatial structure.
- **Face Topology**: Walls, doors, and openings are not arbitrary meshes — they are semantic face-level attributes that enforce structural consistency across adjacent cells.
- **Infinite Regeneration**: The same protocol data model produces a unique maze every time, demonstrating SPP's generative capacity.
