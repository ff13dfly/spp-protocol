# SPP Examples

A collection of interactive demonstrations of the **String Particle Protocol (SPP)**.

## Available Examples

| Demo | Type | Description |
|---|---|---|
| [**Maze Demo**](./maze-demo/) | Forward | Demonstrates superposition, cascade collapse, and algorithmic maze generation. |
| [**Inverse Demo**](./inverse-demo/) | Inverse | Demonstrates 3D reconstruction from 2D floor plans using the AI inverse modeling engine. |
| [**Orthogonal Demo**](./orthogonal-demo/) | Inverse | Demonstrates orthogonal hull reconstruction from 2D silhouettes with cell refinement. |

---

## Shared Foundation

All examples are built on the shared library located in the root [`spp-lib/`](../spp-lib/) directory:
- **`spp-core.js`**: Pure SPP data model (Face constants, Option registry).
- **`spp-inverse-engine.js`**: AI-driven reconstruction pipeline used by the Inverse Demo.

## Running the Examples

All examples are browser-based. To run them locally:

1. **Using the Start Script (in Demo directory):**
   ```bash
   cd spp-examples/orthogonal-demo/
   ./start-demo.sh
   ```
   This will launch the server for that specific demo.

2. **Manual Start:**
   Open the project root and run:
   ```bash
   npx serve .
   ```
   Then navigate to `http://localhost:3000/spp-examples/` in your browser.
