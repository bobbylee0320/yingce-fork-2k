import { describe, expect, test } from "bun:test";
import { createGalleryWheelGesture } from "../src/pages/create/creation-gallery-gesture";

describe("创作轮播连续滚动", () => {
    test("一次触摸板滑动的加速及惯性尾巴只切换一张", () => {
        const gesture = createGalleryWheelGesture();
        const deltas = [2, 6, 18, 42, 70, 55, 32, 18, 8, 4, 2, 1];
        expect(deltas.map((delta, index) => gesture(delta, index * 30)).filter(Boolean)).toEqual([1]);
    });

    test("惯性尚未结束时再次同方向发力仍能翻页", () => {
        const gesture = createGalleryWheelGesture();
        const deltas = [20, 65, 50, 30, 15, 7, 3, 1, 4, 18, 45, 30, 15, 5];
        expect(deltas.map((delta, index) => gesture(delta, index * 30)).filter(Boolean)).toEqual([1, 1]);
    });

    test("短暂停顿后的轻滑不受上一次大力度峰值限制", () => {
        const gesture = createGalleryWheelGesture();
        expect(gesture(160, 0)).toBe(1);
        expect(gesture(20, 40)).toBe(0);
        expect(gesture(4, 220)).toBe(0);
        expect(gesture(5, 240)).toBe(1);
        expect(gesture(8, 440)).toBe(1);
    });

    test("反向手势立即生效，微小抖动不触发", () => {
        const gesture = createGalleryWheelGesture();
        expect(gesture(20, 0)).toBe(1);
        expect(gesture(-0.2, 20)).toBe(0);
        expect(gesture(-12, 40)).toBe(-1);
        expect(gesture(-6, 60)).toBe(0);
        expect(gesture(12, 80)).toBe(1);
    });

    test("离散滚轮每次滚动均可连续切换", () => {
        const gesture = createGalleryWheelGesture();
        expect([0, 200, 400, 600].map((now) => gesture(48, now))).toEqual([1, 1, 1, 1]);
    });
});
