# SPP Orthogonal Reconstruction Demo

This demo illustrates the **String Particle Protocol (SPP)** applied to 3D hull reconstruction from 2D orthogonal silhouettes.

## Key Features
- **Adaptive Refinement:** Recursively splits space into smaller cells to accurately capture shape details.
- **Recursive Reconciliation:** Ensures consistent faces between cells at different refinement levels, eliminating internal walls.
- **Face-Line Scanning:** Uses image-based analysis along cell edges to determine spatial boundaries.

## Running the Demo

To start this specific demo:

1. Open your terminal in this directory (`spp-examples/orthogonal-demo/`).
2. Run the start script:
   ```bash
   ./start-demo.sh
   ```
3. Open the provided link in your browser.

Alternatively, running `npx serve .` from the project root will also work (navigate to `/spp-examples/orthogonal-demo/`).

## Implementation Details
- **`js/spp-builder.js`**: Core tree building and reconciliation logic.
- **`js/face-scanner.js`**: Pixel classification and face boundary scanning.
- **`js/main.js`**: Application entry and interaction handling.
