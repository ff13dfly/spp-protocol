# 房型图结构提取 — 实施计划

## 1. 目标

**输入：** 一张标准房型图（含房间标注、门窗弧线、家具等）

**输出：** 结构化的几何数据，可直接用于 orthogonal-demo 的确定性还原

```
房型图 → [AI 提取] → 结构数据（JSON）→ [Canvas 绘制] → 纯几何图 → [SPP 确定性还原]
```

**核心验证点：** AI 能否从复杂的房型图中准确提取出建筑结构的几何框架

---

## 2. 提取目标

从房型图中提取三类结构数据：

### 2.1 外墙轮廓

建筑物的外边界，由直角折线构成的闭合多边形。

```json
{
  "outline": [[0, 0], [0.6, 0], [0.6, 0.4], [1, 0.4], [1, 1], [0, 1]]
}
```

- 坐标归一化到 0–1 范围
- 所有角均为直角（正交约束）
- 闭合多边形（首尾相连）

### 2.2 内墙

房间之间的分隔墙，每面墙用两个端点表示。

```json
{
  "innerWalls": [
    { "from": [0.4, 0], "to": [0.4, 0.6] },
    { "from": [0.4, 0.6], "to": [1, 0.6] }
  ]
}
```

- 端点必须落在外墙轮廓上或其他内墙交点上
- 所有墙段为水平或垂直线（正交约束）

### 2.3 门窗

门和窗在墙段上的位置。

```json
{
  "doors": [
    { "wall": [0.4, 0.2], "width": 0.08 }
  ],
  "windows": [
    { "wall": [0.0, 0.3], "width": 0.12 }
  ]
}
```

- `wall` 坐标为门/窗中心点，落在某段墙上
- `width` 为门/窗在墙方向上的占比宽度

---

## 3. 分步提取策略

不要一步到位，分步提取降低 AI 单次任务的复杂度：

```
Step 1: [AI] 提取外墙轮廓 → outline 多边形
Step 2: [AI] 提取内墙分隔 → innerWalls 线段列表
Step 3: [AI] 提取门窗位置 → doors[], windows[]
Step 4: [Canvas] 用提取到的数据绘制纯几何图
Step 5: [验证] 叠加原图对比精度
```

### 3.1 为什么分步

| 一步到位 | 分步提取 |
|---------|---------|
| AI 同时处理轮廓+内墙+门窗 | 每步只关注一个层次 |
| 输出 JSON 复杂，容易出错 | 每步输出简单，容易验证 |
| 错了不知道哪里错 | 每步可独立检查和重试 |

---

## 4. AI 提示词设计

### 4.1 Step 1：外墙轮廓

```
You are analyzing an architectural floor plan image.

Extract the OUTER WALL boundary of the building as a closed polygon.
All corners are 90-degree angles (orthogonal only).

Rules:
1. Trace the outermost wall line of the building.
2. Output coordinates as [x, y] pairs, normalized to 0–1 range
   where (0,0) = top-left of the floor plan area and (1,1) = bottom-right.
3. List points in clockwise order starting from top-left corner.
4. All segments must be horizontal or vertical — no diagonals.
5. The polygon must be closed (last point connects back to first).

Return ONLY a JSON object:
{ "outline": [[x,y], [x,y], ...] }
```

### 4.2 Step 2：内墙分隔

```
You are analyzing an architectural floor plan image.

The outer wall boundary is:
__OUTLINE__

Now extract all INTERIOR WALLS that divide the building into rooms.

Rules:
1. Each wall is a straight line segment: { "from": [x,y], "to": [x,y] }
2. All segments are horizontal or vertical.
3. Wall endpoints must connect to the outer boundary or to other interior walls.
4. Do NOT include door openings as walls — only solid wall segments.
5. Use the same 0–1 normalized coordinate system as the outline.

Return ONLY a JSON object:
{ "innerWalls": [{ "from": [x,y], "to": [x,y] }, ...] }
```

### 4.3 Step 3：门窗位置

```
You are analyzing an architectural floor plan image.

The building structure is:
Outline: __OUTLINE__
Interior walls: __INNER_WALLS__

Now identify all DOORS and WINDOWS.

Rules:
1. A door appears as an arc symbol (quarter-circle swing path) on a wall.
2. A window appears as parallel short lines on an outer wall.
3. For each, report the center point on the wall and its width.
4. Use the same 0–1 normalized coordinate system.

Return ONLY a JSON object:
{
  "doors": [{ "center": [x,y], "width": 0.08 }, ...],
  "windows": [{ "center": [x,y], "width": 0.12 }, ...]
}
```

---

## 5. Canvas 绘制

将 AI 提取的结构数据渲染为纯几何图：

```js
function drawStructure(ctx, w, h, data) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;

    // 1. 外墙轮廓
    const pts = data.outline;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x * w, y * h);
    ctx.closePath();
    ctx.stroke();

    // 2. 内墙
    for (const wall of data.innerWalls) {
        ctx.beginPath();
        ctx.moveTo(wall.from[0] * w, wall.from[1] * h);
        ctx.lineTo(wall.to[0] * w, wall.to[1] * h);
        ctx.stroke();
    }

    // 3. 门（在墙上画缺口）
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    for (const door of data.doors) {
        // 在门位置覆盖一段白色，形成"开口"
        // 方向由所在墙段决定
    }

    // 4. 窗（可选：在外墙上画标记）
}
```

输出的图可以直接送入 orthogonal-demo 的算法进行确定性 SPP 还原。

---

## 6. 验证方式

### 6.1 叠加对比

将 AI 提取 → Canvas 绘制的结构图，与原始房型图叠加，视觉检查对齐度。

### 6.2 逐步检查

| Step | 检查方式 |
|------|---------|
| Step 1 外墙 | 轮廓多边形是否包围了所有房间 |
| Step 2 内墙 | 内墙端点是否连接到轮廓或其他墙 |
| Step 3 门窗 | 门窗位置是否在墙段上，宽度是否合理 |

### 6.3 数据一致性校验（确定性）

```js
function validate(data) {
    // 1. outline 是闭合多边形
    // 2. 所有线段为水平或垂直
    // 3. 内墙端点在 outline 边缘上或在其他内墙交点上
    // 4. 门窗中心点在某段墙上
    // 5. 门窗宽度 < 所在墙段长度
}
```

---

## 7. 文件结构

```
spp-examples/floorplan-extract/
  index.html                 — 可视化页面（上传图片 → 提取 → 绘制 → 对比）
  js/
    main.js                  — 流程编排 + UI
    extractor.js             — AI 调用（3 步提取）
    drawer.js                — Canvas 绘制结构图
    validator.js             — 数据一致性校验
  assets/
    floorplan.png            — 测试图（复用 inverse-demo-v2 的）
  implementation-plan.md
```

---

## 8. 实施顺序

| 步骤 | 内容 | 目标 |
|------|------|------|
| A | 写提取脚本（Node.js），用 floorplan.png 测试 Step 1 | 验证 AI 能否准确提取外墙轮廓 |
| B | 测试 Step 2（内墙）和 Step 3（门窗） | 验证分步提取可行性 |
| C | 实现 Canvas 绘制，输出纯几何图 | 验证提取数据 → 几何图的完整链路 |
| D | 叠加原图对比 | 评估精度 |
| E | 接入 orthogonal-demo 的 SPP 还原 | 完整链路：房型图 → AI 提取 → 几何图 → SPP |

**先做 Step A 验证可行性，再决定是否继续。**

---

## 9. 与其他 demo 的关系

```
floorplan-extract（本 demo）
  ↓ 输出结构数据 JSON
  ↓ Canvas 绘制纯几何图
  ↓
orthogonal-demo
  ↓ 确定性 SPP 还原
  ↓
SPP ParticleChunk（可渲染、可编辑）
```

各 demo 职责清晰分离：
- **floorplan-extract**：AI 擅长的事 — 从复杂图中理解语义、提取结构
- **orthogonal-demo**：算法擅长的事 — 精确几何还原、递归细化
- **inverse-demo-v2**：端到端方案（对比参考）
