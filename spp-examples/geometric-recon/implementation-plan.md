# SPP 几何平面重建 — 实施计划

## 1. 目标

**输入：** 一张正交几何形状的平面图（矩形、L 形、凹字形等由直角构成的封闭轮廓）

**输出：** 精确还原的 SPP ParticleChunk，每个 cell 的 faceOptions 准确反映该位置的墙/开口关系

**核心验证点：** SPP 的递归 refinement 能力 + 普通大模型 = 逐步逼近精准几何还原

---

## 2. 与 inverse-demo-v2 的本质区别

| 维度 | inverse-demo-v2 | 几何平面重建 |
|------|-----------------|-------------|
| 输入 | 建筑户型图（含标注、家具、门窗弧线） | 纯几何轮廓（黑线白底，无标注） |
| 目标 | 还原"房间布局" | 还原"几何边界" |
| AI 任务 | 语义分类（这是什么房间） | 二值判断（这里有没有墙） |
| 复杂度来源 | 房间数量、门窗类型、走廊形状 | 轮廓精度、直角对齐 |
| 价值验证 | 端到端户型重建 | **SPP 递归分辨率收敛** |

---

## 3. SPP 递归还原的核心原理

SPP-Core v1.1 定义了递归结构：

```
ParticleCell
├─ faceOptions    → 该 cell 的边界接口（外部看到什么）
└─ refinement?    → 该 cell 的内部细分（内部是什么）
     └─ ParticleChunk
          └─ cells[]    → 更细的 ParticleCell（可继续递归）
```

**关键性质：**

1. **边界一致性不变量**：子网格的外边缘 face 必须与父 cell 的 faceOptions 一致
2. **内部自由**：只要外边缘匹配，内部拓扑可以完全不同
3. **精度递增**：每层递归将一个 cell 细分为 n×n 子 cell，分辨率指数增长

**这正好适合几何还原：**

```
Depth 0:  4×4 粗网格    → AI 判断每个格子"有墙/无墙" → 误差 ≤ 1 格
Depth 1:  每格细分 3×3  → AI 在子图上重新判断       → 误差 ≤ 1/3 格
Depth 2:  继续细分 3×3  → AI 在更小的子图上判断     → 误差 ≤ 1/9 格
```

**N 层递归后，精度提升 3^N 倍。** 每次 AI 只需回答一个极简问题："这个小区域里，哪些格子在轮廓内，哪些在外？"

---

## 4. 流程设计

### 4.1 总流程

```
Step 1: [确定性]  初始化粗网格（gridX × gridZ）
Step 2: [AI]      粗网格填充（每个 cell → inside / outside）
Step 3: [确定性]  生成 SPP cells + 面拓扑
Step 4: [循环]    递归细化
         │
         ├─ 识别边界 cell（相邻 cell 内外不同的 cell）
         ├─ 对每个边界 cell：
         │    ├─ 裁剪该 cell 对应的图片区域
         │    ├─ 提取边界约束（四边 open/wall）
         │    ├─ [AI] 子网格填充（n×n，inside/outside）
         │    └─ [确定性] 写入 cell.refinement
         └─ 深度 < maxDepth ? → 继续循环
              │
              └─ 结束
Step 5: [确定性]  输出最终 ParticleChunk
```

### 4.2 数据流

```
输入图片（纯几何轮廓）
     ↓
┌──────────────────────┐
│ Step 1: 粗网格 4×4   │
│  ┌─┬─┬─┬─┐          │
│  │·│·│·│·│          │ ·=未知
│  ├─┼─┼─┼─┤          │
│  │·│·│·│·│          │
│  ├─┼─┼─┼─┤          │
│  │·│·│·│·│          │
│  ├─┼─┼─┼─┤          │
│  │·│·│·│·│          │
│  └─┴─┴─┴─┘          │
└──────────────────────┘
     ↓ Step 2 [AI]
┌──────────────────────┐
│ 粗分类               │
│  ┌─┬─┬─┬─┐          │
│  │■│□│□│■│          │ ■=outside, □=inside
│  ├─┼─┼─┼─┤          │
│  │□│□│□│□│          │
│  ├─┼─┼─┼─┤          │
│  │□│□│□│■│          │
│  ├─┼─┼─┼─┤          │
│  │■│□│■│■│          │
│  └─┴─┴─┴─┘          │
└──────────────────────┘
     ↓ Step 3 [确定性]
┌──────────────────────┐
│ 识别边界 cell         │
│  内外交界处 = 边界     │
│  例如 (0,0) outside    │
│       (1,0) inside     │
│  → (1,0) 的 -X face   │
│    = wall              │
└──────────────────────┘
     ↓ Step 4 [循环递归]
┌──────────────────────┐
│ 对每个边界 cell 细分   │
│                       │
│ 例 (1,0) 细分为 3×3:  │
│  ┌──┬──┬──┐           │
│  │■ │□ │□ │           │
│  ├──┼──┼──┤           │
│  │□ │□ │□ │           │
│  ├──┼──┼──┤           │
│  │□ │□ │□ │           │
│  └──┴──┴──┘           │
│                       │
│ 写入 cell.refinement  │
│ 约束：右边 = open     │
│       左边 = wall     │
│       ...             │
└──────────────────────┘
     ↓ 重复直到 maxDepth
     ↓
   最终 ParticleChunk
   （叶节点精确贴合轮廓）
```

---

## 5. AI 提示词设计

### 5.1 Step 2：粗网格填充

```
You are analyzing a geometric shape image.
The image shows a closed shape made of straight lines and right angles
(rectangle, L-shape, U-shape, etc.) on a white background.

The image has been divided into a __GRID_X__ × __GRID_Z__ grid.

For each cell, determine if it is INSIDE the shape or OUTSIDE.

Return ONLY a JSON 2D array where:
- 1 = cell is inside the shape (or mostly inside)
- 0 = cell is outside the shape (or mostly outside)

Example for a 4×4 grid:
[[0,1,1,0],[1,1,1,1],[1,1,1,0],[0,1,0,0]]
```

**核心特征：** AI 只做一个二值判断——inside 还是 outside。不命名、不分类、不猜语义。

### 5.2 Step 4：子网格填充（递归细化）

```
You are analyzing a CROPPED region of a geometric shape.

This region has been subdivided into a __SUB_X__ × __SUB_Z__ grid.

Boundary constraints (from the parent grid):
- Left edge:   __LEFT__   (wall = shape boundary here; open = no boundary)
- Right edge:  __RIGHT__
- Top edge:    __TOP__
- Bottom edge: __BOTTOM__

For each cell, determine: 1 = inside the shape, 0 = outside.
The boundary constraints MUST be respected:
- "wall" edge: at least one cell on that edge must be 0 (outside)
- "open" edge: all cells on that edge must be 1 (inside)

Return ONLY a JSON 2D array.
```

**递归约束传递：**
- 父 cell 的 faceOptions[+X] = wall → 子网格右边缘约束 = wall
- 父 cell 的 faceOptions[-X] = open → 子网格左边缘约束 = open
- 这就是 SPP-Core Section 3.2.5 的边界一致性不变量

---

## 6. 确定性逻辑

### 6.1 从 inside/outside 网格生成 SPP cells

```js
function generateCellsFromBinaryGrid(grid, gridX, gridZ) {
    const cells = [];
    for (let z = 0; z < gridZ; z++) {
        for (let x = 0; x < gridX; x++) {
            if (grid[z][x] === 0) continue; // outside, skip

            // 每个 inside cell 的四个水平 face:
            //   邻居 inside → open (0)
            //   邻居 outside 或出界 → wall (10)
            const faceOptions = [
                x + 1 < gridX && grid[z][x+1] === 1 ? [0] : [10],  // +X
                x - 1 >= 0    && grid[z][x-1] === 1 ? [0] : [10],  // -X
                [],  // +Y unused
                [],  // -Y unused
                z + 1 < gridZ && grid[z+1]?.[x] === 1 ? [0] : [10],  // +Z
                z - 1 >= 0    && grid[z-1]?.[x] === 1 ? [0] : [10],  // -Z
            ];

            cells.push({
                position: [x, 0, z],
                size: [1, 1, 1],
                faceStates: 0b111111,
                faceOptions,
            });
        }
    }
    return cells;
}
```

### 6.2 识别边界 cell

```js
function findBoundaryCells(cells, grid, gridX, gridZ) {
    // 边界 cell = inside cell 且至少有一个 face 是 wall
    return cells.filter(cell => {
        return cell.faceOptions.some((opts, fi) =>
            opts.length === 1 && opts[0] === 10 && fi !== 2 && fi !== 3
        );
    });
}
```

### 6.3 提取边界约束

```js
function extractConstraints(parentCell) {
    // 从父 cell 的 faceOptions 提取四边约束
    const get = (fi) => {
        const opt = parentCell.faceOptions[fi]?.[0];
        return opt === 0 ? 'open' : 'wall';
    };
    return {
        right:  get(0),  // +X
        left:   get(1),  // -X
        bottom: get(4),  // +Z
        top:    get(5),  // -Z
    };
}
```

### 6.4 写入 refinement

```js
function writeRefinement(parentCell, subGrid, subX, subZ) {
    const subCells = generateCellsFromBinaryGrid(subGrid, subX, subZ);
    parentCell.refinement = {
        gridX: subX,
        gridZ: subZ,
        cells: subCells,
    };
}
```

---

## 7. 测试用图

### 7.1 基础测试集

| # | 形状 | 复杂度 | 验证点 |
|---|------|--------|--------|
| 1 | 矩形 | 最低 | 基线：所有内部 cell 正确填充 |
| 2 | L 形 | 低 | 非矩形轮廓，递归能正确处理拐角 |
| 3 | U 形 | 中 | 内凹区域，递归不会错误填充凹陷处 |
| 4 | T 形 | 中 | 多方向突出，边界 cell 数量多 |
| 5 | 十字形 | 高 | 四方向突出，边界 cell 密集 |
| 6 | 回字形（带内孔） | 最高 | 内外边界都有，递归需区分两种 outside |

### 7.2 图片规格

- 白底黑线，无标注、无文字
- 线宽统一（2-4px）
- 所有角都是直角
- 图片尺寸：400×400 ~ 800×800

---

## 8. 渲染

复用 `spp-lib` 现有能力：

- 渲染 depth 0 粗网格（brick-red）
- 递归进入 refinement，渲染 depth 1（blue-grey）、depth 2（teal）
- 叠加原图作为底图对比
- 支持手动修正单个 face

---

## 9. 文件结构

```
spp-examples/geometric-recon/
  index.html
  js/
    main.js              — UI + 流程编排
    binary-grid.js       — inside/outside 网格生成 + 边界检测 + refinement
  assets/
    rect.png             — 测试图：矩形
    l-shape.png          — 测试图：L 形
    u-shape.png          — 测试图：U 形
  implementation-plan.md
```

---

## 10. 实施顺序

| 步骤 | 内容 | 依赖 |
|------|------|------|
| A | 准备测试图（矩形 + L 形） | 无 |
| B | 实现 Step 1–3：粗网格 + AI 填充 + 面拓扑生成 | A |
| C | 搭建渲染页面，可视化 depth 0 结果 | B |
| D | 实现 Step 4：递归细化（单层） | C |
| E | 验证递归多层（depth 0→1→2），观察精度收敛 | D |
| F | 测试 L 形、U 形等非矩形轮廓 | E |
| G | 测试回字形（带内孔） | F |

---

## 11. 成功标准

| 指标 | 目标 |
|------|------|
| 矩形 depth 0 | 所有 cell 正确（inside/outside 无误） |
| L 形 depth 1 | 拐角处边界精度提升至 1/3 cell |
| 任意形状 depth 2 | 边界与原图偏差 < 2px（在 400px 图上） |
| AI 调用次数 | depth 0: 1 次；depth 1: ≤ 边界 cell 数；depth 2: 同理 |
| 边界一致性 | 所有 refinement 外边缘与父 cell faceOptions 一致 |
