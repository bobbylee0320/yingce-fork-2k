import { expect, test } from "bun:test";
import { imageLayerBackgroundPatch, imageLayerExtractionTargets, imageLayerModelCalls, resolveImageLayerExtractions, validateImageLayerRegion, type ImageLayerExtraction } from "@/lib/canvas/canvas-image-layer-strategy";
import { parseImageLayerPlan } from "@/lib/canvas/canvas-image-layer-plan";

const region = { bbox: [100, 200, 600, 800] as [number, number, number, number], shape: "rect" as const };
const methods: ImageLayerExtraction[] = [{ method: "source" }, { method: "source-region", region }];

test("原图与模型混合按结构处理，原图全链路零图片调用", () => {
    expect(resolveImageLayerExtractions(2, methods, [false, false])).toEqual(methods);
    expect(imageLayerModelCalls(methods, true)).toBe(0);
    expect(imageLayerModelCalls([{ method: "generate" }, methods[1], { method: "generate" }], true)).toBe(3);
    expect(resolveImageLayerExtractions(2)).toEqual([{ method: "generate" }, { method: "generate" }]);
});

test("区域、角色、数量不合法时拒绝，显式缺失策略不能偷偷改为付费生成", () => {
    expect(() => resolveImageLayerExtractions(2, methods, [false, true])).toThrow("不能同时移除");
    expect(() => resolveImageLayerExtractions(2, [methods[1], methods[0]])).toThrow("第 1 层");
    expect(() => resolveImageLayerExtractions(2, [methods[0], undefined as any])).toThrow("缺失");
    expect(() => resolveImageLayerExtractions(2, [methods[0]])).toThrow("数量");
    for (const bbox of [
        [0, 0, 1001, 1000],
        [400, 0, 300, 500],
        [0, 0, NaN, 500],
        [0, 0, 1, 100],
    ])
        expect(() => validateImageLayerRegion({ ...region, bbox: bbox as any })).toThrow("区域无效");
    expect(() => validateImageLayerRegion({ ...region, shape: "rounded-rect", radiusRatio: 1 })).toThrow("圆角");
});

test("只有所有待移除层均有原图区域时才限制背景生成范围", () => {
    const generated: ImageLayerExtraction[] = [{ method: "generate" }, methods[1], { method: "generate" }];
    expect(imageLayerBackgroundPatch({ dataUrl: "original" }, generated, [false, true, false])?.regions).toEqual([region]);
    expect(imageLayerBackgroundPatch({ dataUrl: "original" }, generated, [false, true, true])).toBeUndefined();
    expect(imageLayerBackgroundPatch({ dataUrl: "original" }, methods, [false, false])).toBeUndefined();
});

test("编辑区域后背景提示与本地实际提取使用同一坐标", () => {
    const targets = imageLayerExtractionTargets(["底图", "面板：全部内容，区域 <bbox>0 0 100 100</bbox>"], methods);
    expect(targets[1]).toBe("面板：全部内容，区域 <bbox>100 200 600 800</bbox>");
    expect(targets[1].match(/<bbox>/g)).toHaveLength(1);
});

test("规划声明结构化原图策略，像素坐标按实际参考尺寸换算", () => {
    const plan = parseImageLayerPlan(
        JSON.stringify({
            canPlan: true,
            coordinateSpace: "pixels",
            imageSize: { width: 1000, height: 500 },
            layers: [
                { name: "完整底图", description: "保留全部内容", kind: "background", generation: { prompt: "保留完整原图", background: "opaque" }, extraction: { method: "source" } },
                {
                    name: "规则区域",
                    description: "完整独立区域",
                    kind: "object",
                    generation: { prompt: "复制完整规则区域", background: "transparent" },
                    removeFromBackground: false,
                    bbox: [100, 100, 600, 400],
                    extraction: { method: "source-region", shape: "rounded-rect", radiusRatio: 0.05 },
                },
            ],
        }),
        { width: 1000, height: 500 },
    );
    expect(plan.layers[1].extraction?.region).toEqual({ bbox: [100, 200, 600, 800], shape: "rounded-rect", radiusRatio: 0.05 });
    expect(
        resolveImageLayerExtractions(
            2,
            plan.layers.map((layer) => layer.extraction!),
            [false, false],
        ),
    ).toHaveLength(2);
});

test("无效可选坐标保留语义，但显式原图策略阻断付费回退", () => {
    const plan = parseImageLayerPlan(
        JSON.stringify({
            canPlan: true,
            layers: [
                { name: "底图", description: "完整底图", kind: "background", generation: { prompt: "保留环境并修补遮挡", background: "opaque" } },
                { name: "图形", description: "独立图形", kind: "object", generation: { prompt: "复制独立图形", background: "transparent" }, bbox: [0, 0, 1001, 500], extraction: { method: "source-region", shape: "rect" } },
            ],
        }),
    );
    expect(plan.layers).toHaveLength(2);
    expect(plan.layers[1].extraction?.method).toBe("source-region");
    expect(() => resolveImageLayerExtractions(2, [{ method: "generate" }, plan.layers[1].extraction!])).toThrow("区域无效");
});
