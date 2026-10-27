import { describe, expect, test } from "bun:test";

import { agentCanvasFocusTargets, agentFocusDuration, canvasNodesVisibleInArea, interpolateCameraViewport } from "../src/lib/canvas/agent-canvas-focus";
import { viewportForAgentNodes } from "../src/lib/canvas/canvas-viewport";
import type { CanvasNodeData } from "../src/types/canvas";

function node(id: string, x = 0, y = 0, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type: "image", title: id, position: { x, y }, width: 200, height: 120, metadata } as CanvasNodeData;
}

describe("Agent 镜头跟随目标", () => {
    test("新建节点优先，并标记为新建", () => {
        const before = { nodes: [node("a")], connections: [] };
        const after = { nodes: [node("a"), node("b", 400)], connections: [] };
        expect(agentCanvasFocusTargets(before, after)).toEqual({ nodes: [after.nodes[1]], created: true });
    });

    test("只刷新任务进度不算操作，状态变化和移动算", () => {
        const loading = node("a", 0, 0, { status: "loading", taskId: "t", taskStatus: "running", taskProgress: 10, taskStage: "排队" });
        const progressed = { ...loading, updatedAt: "later", metadata: { ...loading.metadata, taskProgress: 60, taskStage: "生成中", taskUpdatedAt: "later" } };
        expect(agentCanvasFocusTargets({ nodes: [loading] }, { nodes: [progressed] })).toBeNull();
        const done = { ...loading, metadata: { ...loading.metadata, status: "success" as const, taskStatus: "succeeded" as const } };
        expect(agentCanvasFocusTargets({ nodes: [loading] }, { nodes: [done] })).toEqual({ nodes: [done], created: false });
        const moved = { ...loading, position: { x: 300, y: 0 } };
        expect(agentCanvasFocusTargets({ nodes: [loading] }, { nodes: [moved] })?.nodes).toEqual([moved]);
    });

    test("新连线聚焦两端节点，删除节点不聚焦", () => {
        const a = node("a");
        const b = node("b", 500);
        const linked = agentCanvasFocusTargets({ nodes: [a, b], connections: [] }, { nodes: [a, b], connections: [{ id: "e", fromNodeId: "a", toNodeId: "b" }] });
        expect(linked?.nodes.map((item) => item.id).sort()).toEqual(["a", "b"]);
        expect(agentCanvasFocusTargets({ nodes: [a, b] }, { nodes: [a] })).toBeNull();
        expect(agentCanvasFocusTargets(undefined, { nodes: [a] })).toBeNull();
    });
});

describe("Agent 镜头运动", () => {
    const area = { left: 0, top: 0, right: 1000, bottom: 800 };

    test("可见判断考虑边距和遮挡后的可用区域", () => {
        expect(canvasNodesVisibleInArea([node("a", 100, 100)], { x: 0, y: 0, k: 1 }, area)).toBe(true);
        expect(canvasNodesVisibleInArea([node("a", 900, 100)], { x: 0, y: 0, k: 1 }, area)).toBe(false);
        expect(canvasNodesVisibleInArea([node("a", 100, 100)], { x: 0, y: 0, k: 1 }, { ...area, left: 200 })).toBe(false);
    });

    test("不主动放大，缩得太小时推近到可读尺寸", () => {
        expect(viewportForAgentNodes([node("a")], { x: 0, y: 0, k: 0.8 }, area)?.k).toBe(0.8);
        expect(viewportForAgentNodes([node("a")], { x: 0, y: 0, k: 0.2 }, area)?.k).toBe(0.5);
    });

    test("插值首尾精确落点，锚点处的世界坐标连续移动", () => {
        const from = { x: 0, y: 0, k: 1 };
        const to = { x: -2000, y: -600, k: 0.6 };
        const anchor = { x: 500, y: 400 };
        const size = { width: 1000, height: 800 };
        expect(interpolateCameraViewport(from, to, 0, anchor, size)).toEqual(from);
        expect(interpolateCameraViewport(from, to, 1, anchor, size)).toEqual(to);
        const middle = interpolateCameraViewport(from, to, 0.5, anchor, size);
        expect(middle.k).toBeLessThan(Math.sqrt(from.k * to.k));
        expect(middle.k).toBeGreaterThan(0.4);
        const duration = agentFocusDuration(from, to, size);
        expect(duration).toBeGreaterThanOrEqual(420);
        expect(duration).toBeLessThanOrEqual(900);
        expect(agentFocusDuration(from, { x: -10, y: 0, k: 1 }, size)).toBeLessThan(duration);
    });
});
