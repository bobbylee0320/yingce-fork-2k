import { describe, expect, test } from "bun:test";

import { canvasLayoutLane, layoutCanvasAuto, layoutCanvasFlow, layoutCanvasNodesByMediaType, spreadCanvasNodes } from "@/lib/canvas/canvas-layout";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

function node(id: string, type: CanvasNodeType, width = 320, height = 180, locked = false): CanvasNodeData {
    return { id, type, title: id, position: { x: 100, y: 100 }, width, height, metadata: locked ? { locked: true } : undefined };
}

function overlaps(a: CanvasNodeData, b: CanvasNodeData, gap: number) {
    return a.position.x < b.position.x + b.width + gap && b.position.x < a.position.x + a.width + gap
        && a.position.y < b.position.y + b.height + gap && b.position.y < a.position.y + a.height + gap;
}

/** gap 默认 0；传入标题高度可验证上一行底部不会压住下一行节点标题。 */
function expectNoOverlap(nodes: CanvasNodeData[], positions: Map<string, Position>, gap = 0) {
    const placed = nodes.map((item) => ({ ...item, position: positions.get(item.id) ?? item.position }));
    for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
            if (overlaps(placed[i]!, placed[j]!, gap)) throw new Error(`${placed[i]!.id} overlaps ${placed[j]!.id}`);
        }
    }
}

describe("canvas media-aware layout", () => {
    test("无连线时按文本、图片、视频、音频分成纵向泳道", () => {
        const text = node("text", CanvasNodeType.Text, 300, 120);
        const image = node("image", CanvasNodeType.Image, 420, 260);
        const video = node("video", CanvasNodeType.Video, 500, 280);
        const audio = node("audio", CanvasNodeType.Audio, 360, 100);
        const positions = layoutCanvasNodesByMediaType([video, text, audio, image]);

        expect(positions.get("text")!.y).toBeLessThan(positions.get("image")!.y);
        expect(positions.get("image")!.y).toBeLessThan(positions.get("video")!.y);
        expect(positions.get("video")!.y).toBeLessThan(positions.get("audio")!.y);
        expect(positions.get("image")!.y).toBeGreaterThanOrEqual(positions.get("text")!.y + text.height);
    });

    test("有连线时保持从左到右的拓扑层，单链路沿父节点中心对齐", () => {
        const text = node("text", CanvasNodeType.Text);
        const image = node("image", CanvasNodeType.Image);
        const video = node("video", CanvasNodeType.Video);
        const connections: CanvasConnection[] = [
            { id: "a", fromNodeId: text.id, toNodeId: image.id },
            { id: "b", fromNodeId: image.id, toNodeId: video.id },
        ];
        const positions = layoutCanvasFlow([video, image, text], connections);

        expect(positions.get("text")!.x).toBeLessThan(positions.get("image")!.x);
        expect(positions.get("image")!.x).toBeLessThan(positions.get("video")!.x);
        expect(positions.get("image")!.y).toBe(positions.get("text")!.y);
        expect(positions.get("video")!.y).toBe(positions.get("image")!.y);
        expectNoOverlap([text, image, video], positions);
    });

    test("同一拓扑层和媒体泳道中的不同尺寸节点不会重叠", () => {
        const first = node("first", CanvasNodeType.Image, 420, 300);
        const second = node("second", CanvasNodeType.Image, 240, 120);
        const positions = layoutCanvasFlow([first, second], []);

        expectNoOverlap([first, second], positions);
    });

    test("扇出、汇合与环形连线整理后互不重叠，且环不会卡死布局", () => {
        const nodes = [
            node("prompt", CanvasNodeType.Text, 300, 140),
            node("ref-a", CanvasNodeType.Image, 420, 520),
            node("ref-b", CanvasNodeType.Image, 260, 180),
            node("ref-c", CanvasNodeType.Image, 360, 360),
            node("video", CanvasNodeType.Video, 520, 300),
            node("loop", CanvasNodeType.Text, 280, 160),
            node("loose", CanvasNodeType.Audio, 360, 100),
        ];
        const connections: CanvasConnection[] = [
            { id: "1", fromNodeId: "prompt", toNodeId: "ref-a" },
            { id: "2", fromNodeId: "prompt", toNodeId: "ref-b" },
            { id: "3", fromNodeId: "prompt", toNodeId: "ref-c" },
            { id: "4", fromNodeId: "ref-a", toNodeId: "video" },
            { id: "5", fromNodeId: "ref-c", toNodeId: "video" },
            { id: "6", fromNodeId: "video", toNodeId: "loop" },
            { id: "7", fromNodeId: "loop", toNodeId: "prompt" },
        ];
        const positions = layoutCanvasFlow(nodes, connections);

        expect(positions.size).toBe(nodes.length);
        expect(positions.get("prompt")!.x).toBeLessThan(positions.get("ref-a")!.x);
        expect(positions.get("ref-a")!.x).toBeLessThan(positions.get("video")!.x);
        expectNoOverlap(nodes, positions);
    });

    test("大量随机节点与连线整理后无重叠（含标题间距）", () => {
        let seed = 7;
        const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const types = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio];
        const nodes = Array.from({ length: 60 }, (_, index) => ({
            ...node(`n${index}`, types[index % types.length]!, 200 + Math.floor(random() * 400), 100 + Math.floor(random() * 500)),
            position: { x: Math.floor(random() * 2000), y: Math.floor(random() * 2000) },
        }));
        const connections: CanvasConnection[] = Array.from({ length: 50 }, (_, index) => ({
            id: `e${index}`,
            fromNodeId: `n${Math.floor(random() * 60)}`,
            toNodeId: `n${Math.floor(random() * 60)}`,
        }));
        const positions = layoutCanvasAuto(nodes, connections);

        expect(positions.size).toBe(nodes.length);
        expectNoOverlap(nodes, positions, 24);
    });

    test("自动整理绕开锁定节点、框架与选区外障碍", () => {
        const movable = [node("a", CanvasNodeType.Image, 400, 300), node("b", CanvasNodeType.Image, 400, 300), node("c", CanvasNodeType.Text, 300, 200)];
        const locked = { ...node("locked", CanvasNodeType.Image, 600, 600, true), position: { x: 300, y: 100 } };
        const outside = { ...node("outside", CanvasNodeType.Video, 800, 400), position: { x: 100, y: 500 } };
        const positions = layoutCanvasAuto([...movable, locked], [], [outside]);

        expect(positions.has("locked")).toBe(false);
        movable.forEach((item) => {
            const box = { ...item, position: positions.get(item.id)! };
            [locked, outside].forEach((fixed) => expect(overlaps(box, fixed, 0)).toBe(false));
        });
        expectNoOverlap(movable, positions);
    });

    test("自动整理只返回可移动节点，并忽略选区外连接", () => {
        const image = node("image", CanvasNodeType.Image);
        const video = node("video", CanvasNodeType.Video);
        const locked = node("locked", CanvasNodeType.Image, 320, 180, true);
        const frame = node("frame", CanvasNodeType.Frame);
        const positions = layoutCanvasAuto([image, video, locked, frame], [{ id: "external", fromNodeId: image.id, toNodeId: "outside" }]);

        expect([...positions.keys()].sort()).toEqual(["image", "video"]);
        expect(positions.get("image")!.y).toBeLessThan(positions.get("video")!.y);
    });

    test("节点类型映射为稳定的四类泳道", () => {
        expect(canvasLayoutLane(node("script", CanvasNodeType.Script))).toBe("text");
        expect(canvasLayoutLane(node("drawing", CanvasNodeType.Drawing))).toBe("image");
        expect(canvasLayoutLane(node("video", CanvasNodeType.Video))).toBe("video");
        expect(canvasLayoutLane(node("audio", CanvasNodeType.Audio))).toBe("audio");
    });
});

describe("canvas relative-layout spread", () => {
    test("keeps relative occupancy and increases the gap between neighbors", () => {
        const left: CanvasNodeData = { ...node("left", CanvasNodeType.Image, 100, 80), position: { x: 0, y: 0 } };
        const right: CanvasNodeData = { ...node("right", CanvasNodeType.Image, 100, 80), position: { x: 120, y: 10 } };
        const positions = spreadCanvasNodes([left, right], { scale: 1.5, minGap: 40 });

        expect(positions.get("left")!.x).toBe(0);
        expect(positions.get("right")!.x).toBeGreaterThan(120);
        expect(positions.get("right")!.x).toBeGreaterThan(positions.get("left")!.x);
        expect(positions.get("right")!.x - (positions.get("left")!.x + left.width)).toBeGreaterThanOrEqual(40);
    });

    test("keeps a left node left of a right node after resolving overlap", () => {
        const first: CanvasNodeData = { ...node("first", CanvasNodeType.Image, 120, 90), position: { x: 40, y: 20 } };
        const second: CanvasNodeData = { ...node("second", CanvasNodeType.Image, 120, 90), position: { x: 80, y: 30 } };
        const positions = spreadCanvasNodes([first, second], { scale: 1, minGap: 48 });

        expect(positions.get("first")!.x).toBeLessThan(positions.get("second")!.x);
        expect(positions.get("second")!.x - (positions.get("first")!.x + first.width)).toBeGreaterThanOrEqual(48);
    });

    test("returns no moves for a single node", () => {
        expect(spreadCanvasNodes([node("only", CanvasNodeType.Text)]).size).toBe(0);
    });
});
