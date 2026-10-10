import { describe, expect, test } from "bun:test";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { resolveImageRequestSize, validateImageSize } from "@/services/api/image-validation";
import { applyImageLayerPlanningPurpose, imageLayerOutputSize, imageLayerPlannerError, imageLayerPlanningPrompt, imageLayerPlanTargets, imageLayerTargetName, latestImageLayerPlan, parseImageLayerPlan } from "@/lib/canvas/canvas-image-layer-plan";
import type { GenerationTask } from "@/services/api/task-center";
import { supportsExperimentalLayerExtraction } from "@/lib/canvas/canvas-image-layers";
import { defaultConfig, createModelChannel, selectableModelsByCapability } from "@/stores/use-config-store";

const vision = defaultModelCapabilityConfig();
vision.text!.references.maxImages = 2;
vision.text!.references.maxImageBytes = 30 * 1024 * 1024;
const blind = defaultModelCapabilityConfig();
const image = defaultModelCapabilityConfig("km-kemei-seedream", "doubao-seedream-5-0-pro-260628");
const channel = createModelChannel({
    id: "models",
    models: ["visual", "blind", "editor"],
    modelCosts: [
        { model: "visual", capability: "text", billingMode: "token", unitPriceMicrocredits: 1, capabilityConfig: vision },
        { model: "blind", capability: "text", billingMode: "token", unitPriceMicrocredits: 1, capabilityConfig: blind },
        { model: "editor", capability: "image", billingMode: "fixed_request", unitPriceMicrocredits: 1, capabilityConfig: image },
    ],
});
const config = { ...defaultConfig, channels: [channel] };
const backgroundGeneration = { prompt: "保留环境，移除已拆对象并补全遮挡", background: "opaque" };
const objectGeneration = { prompt: "只保留本层对象的原始轮廓、位置和细节", background: "transparent" };

test("默认背景前景拆分将旧副本规划转为修补背景，保留完整场景的原像素提取", () => {
    const oldCopy = parseImageLayerPlan(
        JSON.stringify({
            canPlan: true,
            layout: "composition",
            layers: [
                { name: "原图底板", description: "保留原图", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } },
                { name: "场景", description: "保留内部背景", kind: "object", generation: objectGeneration, editUnit: "scene", removeFromBackground: false, bbox: [100, 200, 600, 800], extraction: { method: "source-region", shape: "rect" } },
                { name: "标题", description: "标题文字", kind: "object", generation: objectGeneration, editUnit: "text", removeFromBackground: false, extraction: { method: "generate" } },
            ],
        }),
    );
    const split = applyImageLayerPlanningPurpose(oldCopy, "recompose");
    expect(split.layers.map((layer) => layer.removeFromBackground)).toEqual([undefined, true, true]);
    expect(split.layers.map((layer) => layer.extraction?.method)).toEqual(["generate", "source-region", "generate"]);
    expect(split.layers[1].extraction?.region?.bbox).toEqual([100, 200, 600, 800]);
    expect(oldCopy.layers[0].extraction?.method).toBe("source");
    expect(oldCopy.layers[1].removeFromBackground).toBe(false);
    expect(imageLayerPlanningPrompt("自动拆分")).toContain("不是原图副本");
    expect(imageLayerPlanningPrompt("自动拆分", undefined, "materials")).toContain("无需重画底板");
});
test("规划依据与编辑单元可检查；无效可选字段不破坏已有计划", () => {
    const layers = [
        { name: "底图", description: "保留原图", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } },
        { name: "面板", description: "完整内部场景", kind: "object", generation: objectGeneration, editUnit: "scene", removeFromBackground: false, extraction: { method: "source-region", shape: "rect" } },
    ];
    const reasoning = { structure: "两个独立容器", editingGoal: "复用完整组件", strategy: "复制场景原像素，边界由用户框选" };
    const plan = parseImageLayerPlan(JSON.stringify({ canPlan: true, layers, reasoning }));
    expect(plan.reasoning).toEqual(reasoning);
    expect(plan.layers[1].editUnit).toBe("scene");
    expect(plan.layers[1].extraction?.method).toBe("source-region");
    expect(plan.layers[1].extraction?.region).toBeUndefined();
    const invalid = parseImageLayerPlan(JSON.stringify({ canPlan: true, layers: [layers[0], { ...layers[1], editUnit: "anything" }], reasoning: { structure: 8 } }));
    expect(invalid.layers).toHaveLength(2);
    expect(invalid.reasoning).toBeUndefined();
    expect(invalid.layers[1].editUnit).toBeUndefined();
    expect(invalid.warnings?.length).toBeGreaterThan(1);
});
function response(names = ["背景", "人物", "花束", "标题文字"]) {
    return {
        canPlan: true,
        layers: names.map((name, index) => ({
            name,
            description: `只保留${name}，排除其他层`,
            kind: index === 0 ? "background" : "object",
            generation: index === 0 ? backgroundGeneration : objectGeneration,
            ...(index ? { bbox: [100, 200, 800, 900] } : {}),
        })),
    };
}

describe("通用图层规划", () => {
    test("连续场景局部裁块不自动作为素材输出，不把可疑裁图改成收费重画", () => {
        const layers = [
            { name: "底图", description: "原图", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } },
            { name: "主要主体", description: "完整轮廓", kind: "object", generation: objectGeneration, editUnit: "object", extraction: { method: "generate" } },
            { name: "背景局部", description: "画幅内一角", kind: "object", generation: objectGeneration, editUnit: "group", bbox: [100, 100, 400, 300], extraction: { method: "source-region", shape: "rect" } },
        ];
        const raw = parseImageLayerPlan(JSON.stringify({ canPlan: true, layout: "continuous", layers }));
        const next = applyImageLayerPlanningPurpose(raw, "materials");
        expect(next.layers.map((layer) => layer.name)).toEqual(["原图底板", "主要主体"]);
        expect(next.warnings?.join(" ")).toContain("未自动裁成素材");
        expect(applyImageLayerPlanningPurpose({ ...raw, layout: "composition" }, "materials").layers).toHaveLength(3);
        expect(applyImageLayerPlanningPurpose({ ...raw, layout: "mixed" }, "materials").layers).toHaveLength(3);
        expect(() => applyImageLayerPlanningPurpose({ ...raw, layers: [raw.layers[0], raw.layers[2]] }, "materials")).toThrow("没有可靠的独立素材");
    });
    test("素材目的纠正模型重画底板和移除项，保留区域与主体各自的提取方式", () => {
        const raw = parseImageLayerPlan(
            JSON.stringify({
                canPlan: true,
                layers: [
                    { name: "底板", description: "清空内容", kind: "background", generation: backgroundGeneration, extraction: { method: "generate" } },
                    {
                        name: "完整插图",
                        description: "完整内部环境",
                        kind: "object",
                        generation: objectGeneration,
                        editUnit: "scene",
                        removeFromBackground: true,
                        bbox: [50, 150, 480, 540],
                        extraction: { method: "source-region", shape: "rounded-rect", radiusRatio: 0.06 },
                    },
                    { name: "不规则主体", description: "主体轮廓", kind: "object", generation: objectGeneration, editUnit: "object", removeFromBackground: true, extraction: { method: "generate" } },
                ],
            }),
        );
        const plan = applyImageLayerPlanningPurpose(raw, "materials");
        expect(plan.layers[0].extraction).toEqual({ method: "source" });
        expect(plan.layers[1].extraction).toEqual(raw.layers[1].extraction);
        expect(plan.layers[2].extraction).toEqual({ method: "generate" });
        expect(plan.layers.slice(1).every((layer) => layer.removeFromBackground === false)).toBe(true);
        expect(raw.layers[0].extraction?.method).toBe("generate");
        const recomposed = applyImageLayerPlanningPurpose(raw, "recompose");
        expect(recomposed.layers[0].extraction?.method).toBe("generate");
        expect(recomposed.layers[1].removeFromBackground).toBe(true);
    });
    test("完整场景分类与付费重画冲突时等待框选，不猜形状、不静默生成", () => {
        for (const extraction of [undefined, { method: "generate" }]) {
            const raw = parseImageLayerPlan(
                JSON.stringify({
                    canPlan: true,
                    layers: [
                        { name: "底图", description: "保留", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } },
                        { name: "完整场景", description: "照片", kind: "object", generation: objectGeneration, editUnit: "scene", bbox: [100, 100, 500, 700], extraction },
                    ],
                }),
            );
            const planned = applyImageLayerPlanningPurpose(raw, "materials");
            expect(planned.layers[1].extraction).toEqual({ method: "source-region" });
            expect(planned.warnings?.join(" ")).toContain("请框选完整边界");
        }
    });
    test("重组目的存在移除项时不能原样复制底图，未知分类不冒充完整场景", () => {
        const plan = parseImageLayerPlan(
            JSON.stringify({
                canPlan: true,
                layers: [
                    { name: "底图", description: "保留", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } },
                    { name: "复杂组合", description: "重叠轮廓", kind: "object", generation: objectGeneration, editUnit: "group", removeFromBackground: true, extraction: { method: "generate" } },
                ],
            }),
        );
        const next = applyImageLayerPlanningPurpose(plan, "recompose");
        expect(next.layers[0].extraction?.method).toBe("generate");
        expect(next.layers[1].extraction?.method).toBe("generate");
        expect(imageLayerTargetName("场景名称：内部描述，区域 <bbox>0 0 200 500</bbox>")).toBe("场景名称");
    });
    test("识图模型的 extraction 内坐标仍按显式单位校验，冲突坐标不得静默选择", () => {
        const size = { width: 1000, height: 500 };
        const layer = {
            name: "场景",
            description: "完整场景与内部背景",
            kind: "object",
            generation: objectGeneration,
            editUnit: "scene",
            removeFromBackground: false,
            extraction: { method: "source-region", shape: "rounded-rect", radiusRatio: 0.04, bbox: [50, 100, 450, 400] },
        };
        const value = { canPlan: true, coordinateSpace: "pixels", imageSize: size, layers: [{ name: "底图", description: "保留原图", kind: "background", generation: backgroundGeneration, extraction: { method: "source" } }, layer] };
        const plan = parseImageLayerPlan(JSON.stringify(value), size);
        expect(plan.layers[1].extraction?.region?.bbox).toEqual([50, 200, 450, 800]);
        expect(plan.layers[1].extraction?.region?.shape).toBe("rounded-rect");
        expect(parseImageLayerPlan(JSON.stringify(value)).layers[1].extraction?.region).toBeUndefined();
        expect(parseImageLayerPlan(JSON.stringify(value), { width: 500, height: 250 }).layers[1].extraction?.region).toBeUndefined();
        const conflict = parseImageLayerPlan(JSON.stringify({ ...value, layers: [value.layers[0], { ...layer, bbox: [60, 100, 450, 400] }] }), size);
        expect(conflict.layers[1].extraction?.region).toBeUndefined();
        expect(conflict.warnings?.join(" ")).toContain("冲突");
        expect(parseImageLayerPlan(JSON.stringify({ ...value, layers: [value.layers[0], { ...layer, bbox: layer.extraction.bbox }] }), size).layers[1].bbox).toEqual([50, 200, 450, 800]);
    });
    test("原图比例在持久化任务前转为协议像素尺寸，提取与去背景都满足后端尺寸校验", () => {
        const profile = defaultModelCapabilityConfig("openai", "image-2.5-flare").image!;
        profile.size = { ...profile.size, parameter: "size", values: ["auto"], allowCustom: true };
        for (const source of [
            { width: 731, height: 412 },
            { width: 600, height: 900 },
        ]) {
            const request = resolveImageRequestSize(profile, undefined, `${source.width}:${source.height}`)!;
            expect(request.parameter).toBe("size");
            expect(request.value).toMatch(/^\d+x\d+$/);
            const [width, height] = request.value.split("x").map(Number);
            expect(() => validateImageSize(width, height)).not.toThrow();
            expect(Math.abs(width / height / (source.width / source.height) - 1)).toBeLessThan(0.01);
        }
    });
    test("文本模型保持可选，只有选中的无识图能力模型报错，不猜模型名", () => {
        expect(selectableModelsByCapability(config, "text")).toContain("models::visual");
        expect(selectableModelsByCapability(config, "text")).toContain("models::blind");
        expect(imageLayerPlannerError(config, "models::visual")).toBe("");
        expect(imageLayerPlannerError(config, "models::blind")).toContain("未配置识图");
        expect(imageLayerPlannerError(config, "models::editor")).toContain("文本模型");
        expect(imageLayerPlannerError(config, "")).toContain("请选择");
    });
    test("普通拆层不局限 OpenAI 协议，必须是接受参考图的图片模型", () => {
        expect(supportsExperimentalLayerExtraction(config, "models::editor")).toBe(true);
        expect(supportsExperimentalLayerExtraction(config, "models::visual")).toBe(false);
        const noReferences = { ...image, image: { ...image.image!, references: { ...image.image!.references, maxImages: 0 } } };
        const altered = { ...config, channels: [{ ...channel, modelCosts: channel.modelCosts!.map((cost) => (cost.model === "editor" ? { ...cost, capabilityConfig: noReferences } : cost)) }] };
        expect(supportsExperimentalLayerExtraction(altered, "models::editor")).toBe(false);
    });
    test("规划层数和题材来自模型真实结果，允许二层和多层", () => {
        const plan = parseImageLayerPlan(JSON.stringify(response()));
        expect(plan.layers.map((layer) => layer.name)).toEqual(["背景", "人物", "花束", "标题文字"]);
        expect(imageLayerPlanTargets(plan)[1]).toContain("区域 <bbox>100 200 800 900</bbox>");
        expect(parseImageLayerPlan("```json\n" + JSON.stringify(response(["背景", "产品"])) + "\n```").layers).toHaveLength(2);
    });
    test("未声明移除时保留原内容；模型显式选项必须是布尔值", () => {
        const planned = response();
        expect(parseImageLayerPlan(JSON.stringify(planned)).layers.map((layer) => layer.removeFromBackground)).toEqual([undefined, false, false, false]);
        const details = { ...planned, layers: planned.layers.map((layer, i) => ({ ...layer, ...(i ? { removeFromBackground: i === 2 } : {}) })) };
        expect(parseImageLayerPlan(JSON.stringify(details)).layers.map((layer) => layer.removeFromBackground)).toEqual([undefined, false, true, false]);
        expect(() => parseImageLayerPlan(JSON.stringify({ ...details, layers: details.layers.map((layer) => ({ ...layer, removeFromBackground: "true" })) }))).toThrow("移除选项");
    });
    test("不能识图、空结果或非 JSON 不作为计划继续执行", () => {
        expect(() => parseImageLayerPlan('{"canPlan":false,"reason":"无法读取图片"}')).toThrow("无法读取图片");
        expect(() => parseImageLayerPlan("我建议分三层")).toThrow("JSON");
        expect(() => parseImageLayerPlan(JSON.stringify(response(["只有一层"])))).toThrow("2–8");
        expect(() => parseImageLayerPlan(JSON.stringify(response(Array.from({ length: 9 }, (_, index) => `层${index}`))))).toThrow("2–8");
    });
    test("拒绝无效语义，丢弃无效可选坐标而保留已识别图层", () => {
        expect(() => parseImageLayerPlan(JSON.stringify(response(["背景", "重复", "重复"])))).toThrow("重复");
        const wrong = response();
        wrong.layers[1].kind = "background";
        expect(() => parseImageLayerPlan(JSON.stringify(wrong))).toThrow("独立对象");
        for (const bbox of [
            [800, 200, 100, 900],
            [0, 0, 1001, 900],
            [0, 0, 1, 1],
        ]) {
            const bad = response();
            bad.layers[1].bbox = bbox;
            const plan = parseImageLayerPlan(JSON.stringify(bad));
            expect(plan.layers).toHaveLength(4);
            expect(plan.layers[1]).not.toHaveProperty("bbox");
            expect(plan.warnings?.[0]).toContain("坐标");
        }
        expect(parseImageLayerPlan(JSON.stringify({ ...response(), code: "ignored", model: "untrusted" }))).not.toHaveProperty("model");
    });
    test("四格海报部分旧坐标超过1000时，七层语义仍可用且不猜坐标单位", () => {
        const names = ["底图背景", "主标题文字", "副标题文字", "左上照片", "右上照片", "左下照片", "右下照片"];
        const value = response(names);
        value.layers[1].bbox = [65, 30, 1010, 85];
        value.layers[4].bbox = [547, 167, 1017, 547];
        const plan = parseImageLayerPlan(JSON.stringify(value));
        expect(plan.layers.map((layer) => layer.name)).toEqual(names);
        expect(plan.warnings).toHaveLength(2);
        expect(imageLayerPlanTargets(plan)[1]).not.toContain("bbox");
        expect(plan.layers[2].bbox).toEqual([100, 200, 800, 900]);
    });
    test("显式单位与已知实际输入尺寸才转换像素坐标，保持归一化提示合同", () => {
        const size = { width: 1600, height: 800 };
        const value = response();
        value.layers[1].bbox = [160, 160, 1280, 720];
        const text = JSON.stringify({ ...value, coordinateSpace: "pixels", imageSize: size });
        expect(parseImageLayerPlan(text, size).layers[1].bbox).toEqual([100, 200, 800, 900]);
        expect(parseImageLayerPlan(text).layers[1]).not.toHaveProperty("bbox");
        expect(parseImageLayerPlan(text, { width: 1000, height: 500 }).layers[1]).not.toHaveProperty("bbox");
        value.layers[1].bbox = [0.1, 0.2, 0.8, 0.9];
        expect(parseImageLayerPlan(JSON.stringify({ ...value, coordinateSpace: "relative" })).layers[1].bbox).toEqual([100, 200, 800, 900]);
        expect(parseImageLayerPlan(JSON.stringify({ ...value, coordinateSpace: "unknown" })).layers[1]).not.toHaveProperty("bbox");
        for (const bbox of [
            [1, 2, 3],
            [0, 0, "50", 60],
            [null, 0, 1000, 1000],
        ]) {
            expect(parseImageLayerPlan(JSON.stringify({ ...value, layers: value.layers.map((layer, index) => (index === 1 ? { ...layer, bbox } : layer)) })).layers[1]).not.toHaveProperty("bbox");
        }
    });
    test("历史恢复跳过识图失败，只允许同画布同源图匹配资源", () => {
        const task = (id: string, metadata: Record<string, unknown>, text: string, extra: Partial<GenerationTask> = {}): GenerationTask => ({
            id,
            projectId: "project",
            type: "canvas_text",
            status: "succeeded",
            model: "vision",
            createdAt: id,
            updatedAt: id,
            prompt: "plan",
            attempts: 1,
            inputJson: JSON.stringify({ metadata }),
            resultJson: JSON.stringify({ text }),
            ...extra,
        });
        const metadata = { edit: "layer-planning", sourceNodeId: "source", sourceStorageKey: "image-key" };
        const tasks = [
            task("1", metadata, JSON.stringify(response())),
            task("2", metadata, '{"canPlan":false,"reason":"无法读图"}'),
            task("3", metadata, "broken"),
            task("4", metadata, JSON.stringify(response()), { projectId: "other" }),
            task("5", { ...metadata, sourceNodeId: "other" }, JSON.stringify(response())),
            task("6", { ...metadata, sourceStorageKey: "replaced-key" }, JSON.stringify(response())),
            task("7", metadata, JSON.stringify(response()), { type: "canvas_image" }),
            task("8", metadata, JSON.stringify(response()), { status: "running" }),
        ];
        expect(latestImageLayerPlan(tasks, "project", "source", "image-key")?.taskId).toBe("1");
        expect(latestImageLayerPlan(tasks, "none", "source", "image-key")).toBeUndefined();
        const legacy = latestImageLayerPlan([task("1", { edit: "layer-planning", sourceNodeId: "source" }, JSON.stringify(response()))], "project", "source", "image-key");
        expect(legacy?.warnings?.join(" ")).toContain("旧记录");
    });
    test("海报整张照片内部场景保留，坐标可省略且以实际参考图为准", () => {
        const prompt = imageLayerPlanningPrompt("自动拆分", { width: 1000, height: 1000 });
        expect(prompt).toContain("完整 scene 禁止重画或内部去背景");
        expect(prompt).toContain('coordinateSpace="pixels"');
        expect(prompt).toContain("1000×1000");
    });
    test("输出比例优先匹配源图配置合同，不把任意原像素尺寸发送给模型", () => {
        const profile = { ...image, image: { ...image.image!, size: { parameter: "size" as const, values: ["1:1", "16:9", "auto"], default: "1:1", allowCustom: false } } };
        const outputConfig = { ...config, channels: [{ ...channel, modelCosts: channel.modelCosts!.map((cost) => (cost.model === "editor" ? { ...cost, capabilityConfig: profile } : cost)) }] };
        expect(imageLayerOutputSize(outputConfig, "models::editor", { width: 731, height: 412 })).toBe("16:9");
        expect(imageLayerOutputSize(outputConfig, "models::editor", { width: 997, height: 700 })).toBe("auto");
        const fixed = {
            ...outputConfig,
            channels: [
                { ...outputConfig.channels[0], modelCosts: outputConfig.channels[0].modelCosts!.map((cost) => ({ ...cost, capabilityConfig: { ...profile, image: { ...profile.image, size: { ...profile.image.size, values: ["1:1", "16:9"] } } } })) },
            ],
        };
        expect(imageLayerOutputSize(fixed, "models::editor", { width: 997, height: 700 })).toBe("");
        expect(imageLayerOutputSize(outputConfig, "models::editor")).toBe("");
        const custom = {
            ...outputConfig,
            channels: [{ ...outputConfig.channels[0], modelCosts: outputConfig.channels[0].modelCosts!.map((cost) => ({ ...cost, capabilityConfig: { ...profile, image: { ...profile.image, size: { ...profile.image.size, allowCustom: true } } } })) }],
        };
        expect(imageLayerOutputSize(custom, "models::editor", { width: 731, height: 412 })).toBe("731:412");
        expect(imageLayerOutputSize(custom, "models::editor", { width: 600, height: 900 })).toBe("600:900");
        expect(imageLayerOutputSize(custom, "models::editor", { width: 0, height: 900 })).toBe("");
    });
});
