/**
 * recursive-core.js
 * 
 * SPP 递归网格（Recursive Grid）核心计算逻辑
 * 这个文件演示了如何在不修改原版平面矩阵（Flat Array）渲染流程的前提下，
 * 独立实现局部网格的提取、合并与世界坐标扁平化映射计算。
 */

export class RecursiveGridManager {
    /**
     * 1. 【局部提取】为 AI 准备局部重绘的上下文 prompt 和参数
     * 当用户选中一个边界复杂或细节较多的大格子（Macro-cell）时，调用此方法。
     * 
     * @param {Object} parentCell - 父级网格节点 (例如一个浴室的格子)
     * @param {number} subGridSize - 目标切割精度 (例如 4 代表 4x4)
     * @returns {Object} 包含给大模型的上下文提示数据
     */
    static createSubGridPromptContext(parentCell, subGridSize = 4) {
        // AI 在处理局部区域时，必须参考外围已经定死的主墙面状态（防止大模型把承重墙改成开放门）
        const parentFaceConstraints = {
            posX: parentCell.faceOptions[0],
            negX: parentCell.faceOptions[1],
            posZ: parentCell.faceOptions[4],
            negZ: parentCell.faceOptions[5]
        };

        return {
            roomType: parentCell.room,
            resolution: `${subGridSize}x${subGridSize}`,
            boundaryConstraints: parentFaceConstraints,
            instruction: `This is a local refinement for a ${parentCell.room}. ` +
                         `Divide the space into a ${subGridSize}x${subGridSize} grid. ` +
                         `Do not violate the external boundary conditions: ${JSON.stringify(parentFaceConstraints)}.`
        };
    }

    /**
     * 2. 【结果整合】将 AI 重新计算的局部高精度结果合并回父级弦粒子
     * 
     * @param {Object} parentCell - 原来的宏观格子
     * @param {Object} aiResultJSON - AI 吐出的针对该局部的 4x4 Cells
     * @returns {Object} 经过数据更新和校验后的 ParentCell
     */
    static integrateSubGrid(parentCell, aiResultJSON) {
        // 将结果植入父格子的 subGrid 树结构中
        parentCell.subGrid = {
            gridX: aiResultJSON.gridX,
            gridZ: aiResultJSON.gridZ,
            cells: aiResultJSON.cells
        };

        return parentCell;
    }

    /**
     * 3. 【递归铺平与坐标映射】将递归的树状结构降维铺平，供 Three.js 等引擎渲染
     * 采用标准的数学坐标映射矩阵（类似四叉树展开），将逐级的相对坐标转化为绝对的世界坐标。
     * 
     * @param {Array} cells - 当前层级的节点数组
     * @param {Array} parentWorldPos - 父级在世界中的起点 [x, y, z]
     * @param {number} parentWorldScale - 父级在世界中的尺寸缩放
     * @returns {Array} 铺平后带有 worldPosition 和 worldScale 的叶子节点（真实的物理像素/网格）
     */
    static flattenRecursiveCells(cells, parentWorldPos = [0, 0, 0], parentWorldScale = 1.0) {
        let flattenedLeaves = [];

        for (const cell of cells) {
            // 计算当前格子在世界坐标系中的真实绝对坐标
            // 公式: 绝对起点 = 父级绝对起点 + 相对偏移量 * 父级缩放比例
            const worldX = parentWorldPos[0] + cell.position[0] * parentWorldScale;
            const worldY = parentWorldPos[1] + cell.position[1] * parentWorldScale;
            const worldZ = parentWorldPos[2] + cell.position[2] * parentWorldScale;

            if (cell.subGrid && Array.isArray(cell.subGrid.cells)) {
                // 如果是“宏观节点”并且具有子网格，则继续递归
                // 继续下钻的缩放等于：父级缩放 / 子网格的跨度 (假定 X Z 等比例切分)
                const gridSpan = Math.max(cell.subGrid.gridX, cell.subGrid.gridZ);
                const currentScale = parentWorldScale / gridSpan;

                // 递归深入
                const subCellLeaves = this.flattenRecursiveCells(
                    cell.subGrid.cells,
                    [worldX, worldY, worldZ],
                    currentScale
                );
                
                flattenedLeaves.push(...subCellLeaves);
            } else {
                // 这个是没有子节点的“叶子节点”，那就是物理上最终的网格
                flattenedLeaves.push({
                    ...cell,
                    worldPosition: [worldX, worldY, worldZ],
                    worldScale: parentWorldScale
                });
            }
        }

        return flattenedLeaves;
    }
}
