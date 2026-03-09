# SPP Inverse Modeling Demo

This is a reverse-modeling demonstration tool based on the SPP (String Particle Protocol). It uses the capabilities of Vision-Language Models (VLMs) like Qwen-VL or Gemini to directly reverse-engineer 2D floor plan images into 3D spatial structures built upon fundamental data units (`ParticleCell`).

## Implementation Concept

The entire reverse-engineering process is broken down into a **Two-step AI Analysis** prompting strategy. The results are then processed by the frontend for geometric parsing, 3D rendering, and interactive fine-tuning.

### 1. Floor Plan Bounding Box Detection & Grid Layout (Step 1)
* **Input**: A high-resolution floor plan image uploaded by the user.
* **Process**: Sends an image-text prompt to the selected VLM, requesting two core visual judgments:
  * **A. Building Envelope Detection (Crop)**: Proactively filters out surrounding margins, title annotations, and dimension lines to extract only the normalized bounding box (cropX, cropY, cropW, cropH) of the actual architectural layout.
  * **B. Spatial Grid Subdivision & Room Mapping**: Splits the indoor layout into a fine-grained grid (e.g., 8×10, adaptable between 4×4 and 12×12) proportionally based on the dimensions of each room. It labels each grid cell with its corresponding topological ID (e.g., `Space_A`, `Space_B`, and `null` for exterior areas).
  * **C. Fractional Wall Snapping (Area-Majority Rule)**: During coarse-grained modeling, real physical walls rarely align perfectly with rigid grid lines. If a physical wall falls directly inside a cell (e.g., dividing the cell such that 70% of its area belongs to 'Space_A' and 30% belongs to 'Space_B'), the VLM evaluates the **Area Ratio**. The cell is entirely assigned to the space that occupies the majority (e.g., >= 50%) of its physical footprint. Consequently, the logical wall is automatically snapping to the closest semantic grid boundary. This simple thresholding significantly enhances topological accuracy during low-res generation.

### 2. Validating Face Connections (Step 2: Face Classification)
* **Input**: The grid dimensions and the spatial layout matrix obtained from Step 1.
* **Process**: A secondary analysis request is sent. The VLM must assign Face Options IDs based on the SPP protocol to the 4 horizontal faces (+X, -X, +Z, -Z) of every valid architectural cell:
  * `0`: **Open** — Connects adjacent grid cells that belong to the *same* room (no wall).
  * `2`: **Door** — A doorway connecting different adjacent rooms.
  * `10`: **Wall** — Solid walls separating different rooms or thick load-bearing exterior walls.
  * `20`: **Window** — Exterior walls facing outside equipped with windows.
* **Core Advantage**: Splitting this into two steps severely reduces the probability of VLM spatial hallucinations. It forces the model to mathematically map "which cells belong to Room A" before realizing that "cells within the same Room A should inherently be 'Open'". This circumvents the chaos typically seen when prompting models to spit out large batches of 3D coordinates all at once.

### 3. Parsing & 3D Reconstruction
* The JSON results are parsed and formatted through `js/parser.js`.
* The core mapping class, `js/particle.js`, flattens the 2D grid logic and projects it into authentic `ParticleCell` objects (the foundational structural units of the SPP protocol).
* Three.js (`js/renderer-3d.js`) takes over to visualize all walls, openings, and interconnected geometries as 3D nodes on the right-side canvas.

### 4. Advanced Architecture: Decoupling Geometry from Semantics (Anti-Hallucination)
To further prevent VLMs from falling into the trap of "Semantic Coupling Hallucinations" (e.g., forcing a 20-square-meter bathroom to be split because the AI's prior knowledge dictates bathrooms must be small), the system architecture embraces a **Geometry-First** principle.

Instead of prompting the AI to assign human-readable names (`"Bathroom"`, `"Kitchen"`) during the structural generation phase:
1. **Phase 1: Pure Geometric Topology**: The VLM is instructed to act merely as an edge-detection engine. It assigns meaningless topological IDs (e.g., `"Space_A"`, `"Space_B"`) to enclosed regions. The VLM focuses 100% on the physical lines of the drawing without being biased by what the room is supposed to be.
2. **Phase 2: Face Generation**: The engine perfectly connects `Space_A` to `Space_A` as `Open (0)`, and builds `Wall (10)` or `Door (2)` between `Space_A` and `Space_B`. The flawless 3D whitebox schema is established.
3. **Phase 3: Semantic Inference Overlay (Lazy Loading)**: After the pure 3D geometry is locked in, a secondary lightweight prompt (or post-processing analysis) is used to observe the structural layout and reverse-engineer the actual functions of `Space_A` and `Space_B` based on fixture icons (like toilets or stoves) found on the 2D floor plan. 

This decoupling ensures that the `room` attribute in `ParticleCell` is treated internally as a **Connected Component ID** for robust topological mapping, significantly elevating the accuracy of coarse-grained modeling on highly complex or unconventional floor plans.

### 5. Recursive Data Structure Design (High Precision)
To support the "Recursive Refinement" natively rather than just as a conceptual grid scale-up, the underlying data structure of the Spatial Grid has been rethinked. Instead of an isolated flat 2D array, we introduce a hierarchical **Tree-based Grid System (Quadtree/Octree inspired)**.

#### **Previous Flat Structure vs. New Recursive Structure**

*   **Previous Flat Structure (v1)**:
    *   **Data Model**: A simple 2D array matrix: `layout[z][x] = "Space_A"`. 
    *   **Limitation**: To add details to a single $1\times1$ bathroom, you had to multiply the *entire* global grid by a scale factor (e.g., scale=2 turns an $8\times10$ grid into a $16\times20$ grid). This exponentially increases memory footprint, rendering costs, and most importantly, blows up the LLM's context window since it now has to evaluate $320$ cells instead of $80$.
    *   **JSON Representation**:
        ```json
        {
          "gridX": 8, "gridZ": 10,
          "cells": [
            { "position": [0, 0, 0], "room": "Space_A", "faceOptions": [...] },
            { "position": [1, 0, 0], "room": "Space_A", "faceOptions": [...] }
          ]
        }
        ```

*   **New Recursive Structure (v2)**:
    *   **Data Model**: A hierarchical node structure where any `ParticleCell` can recursively contain its own `subGrid`.
    *   **Advantage**: You keep the global grid small (e.g., $8\times10$) to handle base topology. When encountering a complex "Macro-cell", only that specific cell is passed back to the AI for a localized $4\times4$ subdivision. The rendering engine recursively traverses the tree to draw details only where they exist.
    *   **JSON Representation**:
        ```json
        {
          "gridX": 8, "gridZ": 10,
          "cells": [
            {
              "position": [0, 0, 0],
              "room": "Space_A",
              "faceOptions": [ [0], [10], [], [], [10], [20] ],
              "subGrid": null
            },
            {
              "position": [2, 0, 3],
              "room": "Space_B",
              "faceOptions": [ [10], [10], [], [], [10], [10] ],
              "subGrid": {
                 "gridX": 4, "gridZ": 4,
                 "cells": [
                   { "position": [0, 0, 0], "room": "Space_B_1", "faceOptions": [...] },
                   { "position": [1, 0, 0], "room": "Space_B_2", "faceOptions": [...] }
                 ]
              }
            }
          ]
        }
        ```
    *   **Why this is better**: This aligns perfectly with the SPP protocol's capability for nested spaces. It achieves infinite precision locally without inflating the global coordinate logic. When sending prompts to the AI for local refinement, the AI only needs to process a tiny matrix relative to the local bounding box, ensuring maximum accuracy and zero hallucination.

### 5. Interactive Editing, Refinement & Output
* **WYSIWYG Tweaking**: Users can interact directly with the generated 3D viewport. Clicking on specific wall structures cycles them through various forms (`wall → door → window → open → ...`).
* **Automated Artifact Cleaning (Isolated Wall Filter)**: Because the generated result is a mathematical topologically connected graph (Face Topology) rather than just a loose collection of 3D meshes, the system can automatically run a post-processing algorithm to sweep the grid. If a segment of wall Face is detected as an "island" (meaning both ends of the wall do not connect to any other walls, intersections, or corners, resulting in a connection degree of 0 or 1), or if a wall inexplicably appears completely isolated inside the interior bounds of a single `Living Room` layout space without dividing anything, the system confidently identifies it as a VLM "hallucination dirt" and automatically erases it (switching it back to `Open` state) before rendering.
* **JSON Export**: The finalized 3D grid space can be exported as a standard SPP JSON architecture file, ready to be mounted onto any robust ecosystem engine or application that integrates the SPP standard.

## How to Run

1. No build tools (like Webpack or Vite) are required. Simply host a local Http server (e.g., `npx serve .` or use VSCode Live Server), or even double-click `index.html` to open it in a modern browser.
2. Enter your API Key in the left panel. Currently, it features built-in support for Alibaba Cloud DashScope's Qwen-VL series and Google GenAI's Gemini series.
3. Drag and drop any 2D floor plan image, then click `✨ Analyze & Reconstruct`.
4. Wait for the two-step AI generation to complete. You will then receive a reconstructed 3D blueprint on the right viewport.
