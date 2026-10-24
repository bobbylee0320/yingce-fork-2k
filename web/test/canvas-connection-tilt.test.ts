import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canvasConnectionTilt, latchCanvasConnectionApproach } from "../src/lib/canvas/canvas-connection-tilt";

const node = { position: { x: 100, y: 200 }, width: 400, height: 200 };
test("connection approach determines tilt direction and glare position", () => {
    expect(canvasConnectionTilt(node, { x: 100, y: 300 })).toEqual({ rotateX: 0, rotateY: -8, glareX: "0%", glareY: "50%" });
    expect(canvasConnectionTilt(node, { x: 500, y: 300 })).toEqual({ rotateX: 0, rotateY: 8, glareX: "100%", glareY: "50%" });
    expect(canvasConnectionTilt(node, { x: 300, y: 200 })?.rotateX).toBe(8);
    expect(canvasConnectionTilt(node, { x: 300, y: 400 })?.rotateX).toBe(-8);
});
test("snap padding is clamped, absent or invalid approach stays flat", () => {
    expect(canvasConnectionTilt(node, { x: -100, y: 700 })).toEqual({ rotateX: -8, rotateY: -8, glareX: "0%", glareY: "100%" });
    expect(canvasConnectionTilt(node)).toBeUndefined();
    expect(canvasConnectionTilt(node, { x: NaN, y: 0 })).toBeUndefined();
    expect(canvasConnectionTilt({ ...node, width: 0 }, { x: 0, y: 0 })).toBeUndefined();
});

test("connection pointer tracking updates the shell without React renders and cleans up", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-connection-tilt.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15000 });
    expect(result.exitCode, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
});
test("world-space approach is independent of viewport scaling", () => {
    const point = { x: 150, y: 250 };
    const result = canvasConnectionTilt(node, point);
    for (const scale of [0.25, 1, 4]) {
        const screen = { x: point.x * scale + 30, y: point.y * scale - 70 };
        expect(canvasConnectionTilt(node, { x: (screen.x - 30) / scale, y: (screen.y + 70) / scale })).toEqual(result);
    }
});
test("only connection targets receive approach data; memo tracks it and selection does not activate tilt", () => {
    const source = readFileSync(new URL("../src/components/canvas/canvas-node.tsx", import.meta.url), "utf8");
    const layers = readFileSync(new URL("../src/pages/canvas/canvas-project-world-layers.tsx", import.meta.url), "utf8");
    expect(source).toContain("isConnectionTarget && !disableMediaEffects && !dragOffset");
    expect(source).toContain("previous.connectionApproach?.x === next.connectionApproach?.x");
    expect(source).toContain('data-connection-tilt={connectionTilt ? "true" : undefined}');
    expect(layers).toContain("props.connectionApproach?.nodeId === node.id ? props.connectionApproach.point : undefined");
    expect(layers).not.toMatch(/connectionApproach=\{[^\n]*mouseWorld/);
});

test("600 pointer frames inside one target retain identical entry data", () => {
    const entry = latchCanvasConnectionApproach(null, "target", { x: 10, y: 20 });
    for (let frame = 0; frame < 600; frame++) {
        expect(latchCanvasConnectionApproach(entry, "target", { x: frame, y: frame })).toBe(entry);
    }
    expect(entry?.point).toEqual({ x: 10, y: 20 });
    const next = latchCanvasConnectionApproach(entry, "other", { x: 100, y: 200 });
    expect(next).not.toBe(entry);
    expect(next?.point).toEqual({ x: 100, y: 200 });
    expect(latchCanvasConnectionApproach(next, null, { x: 0, y: 0 })).toBeNull();
    expect(latchCanvasConnectionApproach(null, "target", { x: 30, y: 40 })?.point).toEqual({ x: 30, y: 40 });
});
