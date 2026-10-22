import { beforeEach, describe, expect, test } from "bun:test";

import { normalizePrevisMode, PREVIS_DEFAULT_MODE, PREVIS_MODES, previsModeCapabilities, resolvePrevisModeTransition, type PrevisMode } from "../src/lib/canvas/previs/previs-modes";
import { createPrevisScene } from "../src/lib/canvas/previs/previs-scene";
import { createPrevisSceneFromTemplate } from "../src/lib/canvas/previs/previs-templates";
import { usePrevisWorkbenchStore } from "../src/stores/canvas/use-previs-workbench-store";

const ALL_MODES: PrevisMode[] = ["layout", "animate"];

describe("两模式骨架", () => {
    test("只有摆场 / 动画两个一级模式", () => {
        expect(PREVIS_MODES.map((item) => item.mode)).toEqual(ALL_MODES);
        expect(PREVIS_MODES.map((item) => item.label)).toEqual(["摆场", "动画"]);
    });

    test("默认模式是摆场", () => {
        expect(PREVIS_DEFAULT_MODE).toBe("layout");
        expect(usePrevisWorkbenchStore.getState().mode).toBe("layout");
    });

    test("每个模式都有可读标签与提示", () => {
        for (const item of PREVIS_MODES) {
            expect(item.label.length).toBeGreaterThan(0);
            expect(item.hint.length).toBeGreaterThan(0);
        }
    });

    test("旧的 pose / camera 模式并入摆场，未知值也回落摆场", () => {
        expect(normalizePrevisMode("pose")).toBe("layout");
        expect(normalizePrevisMode("camera")).toBe("layout");
        expect(normalizePrevisMode("nope")).toBe("layout");
        expect(normalizePrevisMode(undefined)).toBe("layout");
        expect(normalizePrevisMode("animate")).toBe("animate");
    });
});

describe("能力矩阵", () => {
    test("只有动画模式显示时间轴、允许关键帧与 Auto Key", () => {
        for (const mode of ALL_MODES) {
            const capabilities = previsModeCapabilities(mode);
            expect(capabilities.timeline).toBe(mode === "animate");
            expect(capabilities.keyframes).toBe(mode === "animate");
        }
    });

    test("两个模式都能调姿势与骨骼（选中演员时）", () => {
        for (const mode of ALL_MODES) expect(previsModeCapabilities(mode).bones).toBe(true);
    });

    test("两个模式都提供全部渲染视图", () => {
        for (const mode of ALL_MODES) expect(previsModeCapabilities(mode).renderModes).toEqual(["beauty", "clay", "pose", "depth", "normal"]);
    });

    test("未知模式回落到摆场能力，不返回 undefined", () => {
        expect(previsModeCapabilities("nope" as PrevisMode)).toEqual(previsModeCapabilities("layout"));
    });
});

describe("切换清理：离开动画不得残留后台动画写入", () => {
    test("离开动画模式一定停播并关掉 Auto Key", () => {
        const next = resolvePrevisModeTransition({ mode: "layout", playing: true, autoKey: true, renderMode: "beauty" });
        expect(next.playing).toBe(false);
        expect(next.autoKey).toBe(false);
    });

    test("留在动画模式时保留播放与 Auto Key", () => {
        const next = resolvePrevisModeTransition({ mode: "animate", playing: true, autoKey: true, renderMode: "beauty" });
        expect(next.playing).toBe(true);
        expect(next.autoKey).toBe(true);
    });

    test("切模式保留渲染视图", () => {
        expect(resolvePrevisModeTransition({ mode: "layout", playing: false, autoKey: false, renderMode: "depth" }).renderMode).toBe("depth");
        expect(resolvePrevisModeTransition({ mode: "animate", playing: false, autoKey: false, renderMode: "pose" }).renderMode).toBe("pose");
    });
});

describe("store 的 setMode", () => {
    beforeEach(() => {
        usePrevisWorkbenchStore.getState().reset();
    });

    test("切到动画再切回摆场：playing 与 autoKey 都被清掉", () => {
        const store = usePrevisWorkbenchStore;
        store.getState().setMode("animate");
        store.getState().setPlaying(true);
        store.getState().setAutoKey(true);
        store.getState().setMode("layout");
        expect(store.getState().mode).toBe("layout");
        expect(store.getState().playing).toBe(false);
        expect(store.getState().autoKey).toBe(false);
    });

    test("切模式不影响选择状态", () => {
        const store = usePrevisWorkbenchStore;
        store.getState().setSelectedObjectId("obj-1");
        store.getState().setMode("animate");
        expect(store.getState().selectedObjectId).toBe("obj-1");
        store.getState().setMode("layout");
        expect(store.getState().selectedObjectId).toBe("obj-1");
    });

    test("切模式不重置 playhead", () => {
        const store = usePrevisWorkbenchStore;
        store.getState().setMode("animate");
        store.getState().setPlayhead(2.5);
        store.getState().setMode("layout");
        expect(store.getState().playhead).toBe(2.5);
    });

    test("reset 回到默认摆场", () => {
        const store = usePrevisWorkbenchStore;
        store.getState().setMode("animate");
        store.getState().reset();
        expect(store.getState().mode).toBe("layout");
    });

    test("摆场可直接切深度、法线、骨骼视图", () => {
        const store = usePrevisWorkbenchStore;
        for (const mode of ["pose", "depth", "normal", "clay", "beauty"] as const) {
            store.getState().setRenderMode(mode);
            expect(store.getState().renderMode).toBe(mode);
        }
    });
});

describe("mode 不进 PrevisScene schema", () => {
    test("兼容 factory 与模板生成的场景都没有 mode 字段", () => {
        expect(Object.keys(createPrevisScene("s"))).not.toContain("mode");
        expect(Object.keys(createPrevisSceneFromTemplate("dialogue"))).not.toContain("mode");
    });

    test("切模式不产生任何场景对象：mode 纯属工作台 UI 状态", () => {
        const store = usePrevisWorkbenchStore;
        const before = createPrevisSceneFromTemplate("monologue");
        const snapshot = JSON.stringify(before);
        store.getState().setMode("animate");
        store.getState().setMode("layout");
        expect(JSON.stringify(before)).toBe(snapshot);
    });
});
