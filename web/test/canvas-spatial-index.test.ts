import { describe, expect, test } from "bun:test";

import { buildCanvasSpatialIndex, canvasNodeBounds } from "@/lib/canvas/canvas-spatial-index";
import { buildCanvasConnectionIndex } from "@/lib/canvas/canvas-connection-index";
import { visibleCanvasMinimapNodes } from "@/lib/canvas/canvas-frame";
import { retainCanvasLayoutNodes } from "@/lib/canvas/canvas-layout-snapshot";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

describe("canvas spatial index", () => {
    test("queries intersecting entries across buckets in source order", () => {
        const index = buildCanvasSpatialIndex([
            { id: "far", bounds: { left: 2048, top: 0, right: 2200, bottom: 120 }, value: "far" },
            { id: "near", bounds: { left: 900, top: 40, right: 1100, bottom: 160 }, value: "near" },
            { id: "cross", bounds: { left: 1000, top: -40, right: 2100, bottom: 40 }, value: "cross" },
        ], 1024);

        expect(index.query({ left: 950, top: 0, right: 1150, bottom: 100 })).toEqual(["near", "cross"]);
        expect(index.query({ left: 2100, top: 0, right: 2200, bottom: 100 })).toEqual(["far"]);
    });

    test("does not return edge-touching or invalid entries", () => {
        const index = buildCanvasSpatialIndex([
            { id: "touching", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, value: "touching" },
            { id: "invalid", bounds: { left: 0, top: 0, right: 0, bottom: 10 }, value: "invalid" },
        ]);

        expect(index.query({ left: 10, top: 0, right: 20, bottom: 10 })).toEqual([]);
        expect(index.query({ left: 1, top: 1, right: 2, bottom: 2 })).toEqual(["touching"]);
    });

    test("builds bounds from canvas node geometry", () => {
        expect(canvasNodeBounds({ position: { x: -20, y: 30 }, width: 120, height: 80 })).toEqual({ left: -20, top: 30, right: 100, bottom: 110 });
    });

    test("keeps very large entries out of the bucket build loop", () => {
        const index = buildCanvasSpatialIndex([
            { id: "large", bounds: { left: -100_000, top: -100_000, right: 100_000, bottom: 100_000 }, value: "large" },
            { id: "small", bounds: { left: 20_000, top: 20_000, right: 20_100, bottom: 20_100 }, value: "small" },
        ], 100);

        expect(index.query({ left: 0, top: 0, right: 10, bottom: 10 })).toEqual(["large"]);
        expect(index.query({ left: 20_000, top: 20_000, right: 20_050, bottom: 20_050 })).toEqual(["large", "small"]);
    });

    test("supports a bounded query for dense buckets", () => {
        const index = buildCanvasSpatialIndex(Array.from({ length: 10 }, (_, index) => ({
            id: `node-${index}`,
            bounds: { left: index * 2, top: 0, right: index * 2 + 1, bottom: 1 },
            value: index,
        })));

        expect(index.query({ left: 0, top: 0, right: 100, bottom: 100 }, 3)).toEqual([0, 1, 2]);
    });

    test("filters collapsed frame children with one parent index", () => {
        const frame: CanvasNodeData = { id: "frame", type: CanvasNodeType.Frame, title: "框", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { frame: { collapsed: true } } };
        const child: CanvasNodeData = { id: "child", type: CanvasNodeType.Image, title: "子节点", parentId: frame.id, position: { x: 20, y: 20 }, width: 120, height: 80, metadata: {} };
        const visible = visibleCanvasMinimapNodes([frame, child]);
        expect(visible.map((node) => node.id)).toEqual([frame.id]);
    });

    test("reuses the layout snapshot for metadata-only updates", () => {
        const original: CanvasNodeData = { id: "node", type: CanvasNodeType.Image, title: "图", position: { x: 0, y: 0 }, width: 120, height: 80, metadata: {} };
        const metadataUpdate = { ...original, metadata: { status: "success" as const } };
        const geometryUpdate = { ...metadataUpdate, position: { x: 40, y: 0 } };
        const previous = [original];
        expect(retainCanvasLayoutNodes(previous, [metadataUpdate])).toBe(previous);
        expect(retainCanvasLayoutNodes(previous, [geometryUpdate])).not.toBe(previous);
    });

    test("keeps connection index geometry independent from node metadata", () => {
        const from: CanvasNodeData = { id: "from", type: CanvasNodeType.Text, title: "起点", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: {} };
        const to: CanvasNodeData = { id: "to", type: CanvasNodeType.Text, title: "终点", position: { x: 300, y: 0 }, width: 100, height: 80, metadata: {} };
        const index = buildCanvasConnectionIndex([from, to], [{ id: "edge", fromNodeId: from.id, toNodeId: to.id }]);
        expect(index.index.query({ left: -1, top: -1, right: 500, bottom: 100 }).map((item) => item.connection.id)).toEqual(["edge"]);
        expect(index.entriesById.get("edge")).toMatchObject({ fromId: "from", toId: "to" });
    });

    test("keeps the target 50k canvas mix query-bounded", () => {
        const nodes = buildLargeCanvasFixture();
        const counts = nodes.reduce<Record<string, number>>((result, node) => {
            result[node.type] = (result[node.type] || 0) + 1;
            return result;
        }, {});
        expect(counts[CanvasNodeType.Image]).toBe(35000);
        expect(counts[CanvasNodeType.Video]).toBe(14000);
        expect(counts[CanvasNodeType.Text]).toBe(1000);

        const index = buildCanvasSpatialIndex(nodes.map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node.id })));
        const visible = index.query({ left: 0, top: 0, right: 1600, bottom: 900 }, 720);
        expect(visible.length).toBeLessThanOrEqual(720);
        expect(visible.every((id) => id.startsWith("node"))).toBe(true);
    });
});

function buildLargeCanvasFixture(): CanvasNodeData[] {
    return Array.from({ length: 50000 }, (_, index) => ({
        id: `node${index}`,
        type: index < 35000 ? CanvasNodeType.Image : index < 49000 ? CanvasNodeType.Video : CanvasNodeType.Text,
        title: `节点 ${index}`,
        position: { x: (index % 250) * 360, y: Math.floor(index / 250) * 220 },
        width: 320,
        height: 180,
        metadata: {},
    }));
}
