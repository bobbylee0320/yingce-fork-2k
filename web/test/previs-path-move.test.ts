import { describe, expect, test } from "bun:test";

import { buildPrevisPathKeyframes, movePrevisPathKeyframe } from "../src/lib/canvas/previs/previs-path";

const base = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };

describe("拖动走位路径点", () => {
    // L 形路径：共线点会被简化掉，拐角必须保留三个关键帧。
    const keyframes = buildPrevisPathKeyframes({
        base,
        points: [
            [0, 0, 0],
            [2, 0, 0],
            [2, 0, 2],
        ],
        duration: 3,
        orientToPath: true,
    });
    test("夹具保留三个路径点", () => expect(keyframes.length).toBe(3));

    test("只改目标点的 XZ，时间与 Y 不变", () => {
        const moved = movePrevisPathKeyframe(keyframes, 1, { x: 2, z: 1.5 }, true);
        expect(moved[1].transform.position).toEqual([2, 0, 1.5]);
        expect(moved[1].time).toBe(keyframes[1].time);
        expect(moved[0].transform.position).toEqual(keyframes[0].transform.position);
    });

    test("orientToPath 时重算朝向，演员面朝新方向", () => {
        const moved = movePrevisPathKeyframe(keyframes, 2, { x: 2, z: 3 }, true);
        // 最后一段从 (2,0) 到 (2,3)：朝 +Z，yaw = 0
        expect(moved[2].transform.rotation[1]).toBeCloseTo(0, 5);
    });

    test("越界或非法坐标原样返回", () => {
        expect(movePrevisPathKeyframe(keyframes, 9, { x: 1, z: 1 })).toEqual(keyframes);
        expect(movePrevisPathKeyframe(keyframes, 0, { x: Number.NaN, z: 1 })).toEqual(keyframes);
    });
});
