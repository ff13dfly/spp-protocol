# SPP Examples

A collection of interactive demonstrations of the **String Particle Protocol (SPP)**.

## Available Examples

| Demo | Type | Description |
|---|---|---|
| [**Maze Demo**](./maze-demo/) | Forward | Demonstrates superposition, cascade collapse, and algorithmic maze generation. |
| [**Inverse Demo**](./inverse-demo/) | Inverse | Demonstrates 3D reconstruction from 2D floor plans using the AI inverse modeling engine. |

---

## Shared Foundation

All examples are built on the shared library located in the root [`spp-lib/`](../spp-lib/) directory:
- **`spp-core.js`**: Pure SPP data model (Face constants, Option registry).
- **`spp-inverse-engine.js`**: AI-driven reconstruction pipeline used by the Inverse Demo.

## Running the Examples

All examples are browser-based. To run them locally:

1. Open the project root in a terminal.
2. Start a simple HTTP server:
   ```bash
   npx serve .
   ```
3. Open the provided link (usually `http://localhost:3000`) and navigate into the `spp-examples/` directory.
