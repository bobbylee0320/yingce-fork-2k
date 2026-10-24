import { expect, test } from "bun:test";
import { resolveCanvasConnectionTarget } from "../src/lib/canvas/canvas-connection-hit";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const front: CanvasNodeData = { id: "front", title: "前景", type: CanvasNodeType.Text, position: { x: 100, y: 200 }, width: 400, height: 300 };
const back = { ...front, id: "back" };
const options = { nodes: [front, back], current: { nodeId: "source", handleType: "source" as const }, point: { x: 300, y: 350 }, radius: 56, bodyNodeId: front.id, scriptScrollTopById: {}, canConnect: () => true };

test("visible node wins regardless of creation order and geometric overlap", () => {
    for (const nodes of [
        [front, back],
        [back, front],
    ]) {
        expect(resolveCanvasConnectionTarget({ ...options, nodes }).nodeId).toBe(front.id);
    }
});

test("an invalid visible body blocks the rear node and the create menu", () => {
    const result = resolveCanvasConnectionTarget({ ...options, canConnect: (node) => node.id !== front.id });
    expect(result.nodeId).toBeNull();
    expect(result.isNearNode).toBe(true);
});

test("port snapping keeps its screen-space radius and blank canvas opens creation", () => {
    for (const scale of [0.25, 1, 4]) {
        const radius = 56 / scale;
        const base = { ...options, nodes: [front], bodyNodeId: null, radius };
        expect(resolveCanvasConnectionTarget({ ...base, point: { x: 100 - radius, y: 350 } }).nodeId).toBe(front.id);
        expect(resolveCanvasConnectionTarget({ ...base, point: { x: 100 - radius - 1, y: 350 } })).toEqual({ nodeId: null, isNearNode: false });
    }
});

test("visible body wins over another node's nearby port in either direction", () => {
    const adjacent = { ...back, position: { x: 520, y: 200 } };
    for (const handleType of ["source", "target"] as const) {
        expect(resolveCanvasConnectionTarget({ ...options, nodes: [front, adjacent], current: { nodeId: "source", handleType }, point: { x: 490, y: 350 } }).nodeId).toBe(front.id);
    }
});

test("an obscured geometric body is not selected without a visible DOM hit", () => {
    expect(resolveCanvasConnectionTarget({ ...options, bodyNodeId: null })).toEqual({ nodeId: null, isNearNode: false });
});

test("script headers without row ports block fall-through to the node behind", () => {
    const result = resolveCanvasConnectionTarget({ ...options, nodes: [{ ...front, type: CanvasNodeType.Script }, back], point: { x: 300, y: 210 } });
    expect(result.nodeId).toBeNull();
    expect(result.isNearNode).toBe(true);
});
