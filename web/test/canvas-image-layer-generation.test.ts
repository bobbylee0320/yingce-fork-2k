import { expect, test } from "bun:test";
import { experimentalLayerPrompt, imageLayerGenerationConfig } from "@/lib/canvas/canvas-image-layers";
import { imageLayerPlanningPrompt, parseImageLayerPlan } from "@/lib/canvas/canvas-image-layer-plan";
import { defaultConfig } from "@/stores/use-config-store";

const plan = {
    canPlan: true,
    layers: [
        { name: "背景", description: "背景场景描述标记", kind: "background", generation: { prompt: "移除蓝色绒毯，补全其后地毯与沙发；保留书架和窗户", background: "opaque" } },
        { name: "绒毯", description: "保留完整主体与透明背景的前景描述标记", kind: "object", generation: { prompt: "仅保留蓝色花朵绒毯，保持轮廓、纹理和原始位置", background: "transparent" }, bbox: [169, 38, 969, 955] },
    ],
};

test("背景只收到本层规划，不混入对象描述或前景生成指令", () => {
    const parsed = parseImageLayerPlan(JSON.stringify(plan));
    const background = experimentalLayerPrompt(parsed.layers[0].generation);
    const foreground = experimentalLayerPrompt(parsed.layers[1].generation, parsed.layers[1].bbox);
    expect(background).toContain("移除蓝色绒毯");
    expect(background).toContain("alpha=255");
    expect(background).not.toContain(plan.layers[1].description);
    expect(background).not.toContain(plan.layers[1].generation.prompt);
    expect(background).not.toContain("alpha=0");
    expect(foreground).toContain("仅保留蓝色花朵绒毯");
    expect(foreground).toContain("<bbox>169 38 969 955</bbox>");
    expect(foreground).toContain("alpha=0");
    expect(foreground).not.toContain(plan.layers[0].generation.prompt);
});

test("按规划的本层透明度生成，保持模型、源图尺寸及默认质量", () => {
    const parsed = parseImageLayerPlan(JSON.stringify(plan));
    const config = { ...defaultConfig, model: "chosen", size: "1672x941", quality: "medium", count: "4" };
    expect(imageLayerGenerationConfig(config, parsed.layers[0].generation, 0)).toMatchObject({ model: "chosen", size: "1672x941", quality: "medium", count: "1", transparentBackground: "false" });
    expect(imageLayerGenerationConfig(config, parsed.layers[1].generation, 1).transparentBackground).toBe("true");
    expect(config.count).toBe("4");
});

test("缺失、空白、过长、角色冲突或额外参数的规划在图像调用前停止", () => {
    for (const generation of [
        undefined,
        {},
        { prompt: " ", background: "opaque" },
        { prompt: "x".repeat(2401), background: "opaque" },
        { prompt: "错误背景", background: "transparent" },
        { prompt: "合法提示", background: "opaque", model: "other" },
        { prompt: "合法提示", background: "opaque", size: "1:1" },
    ]) {
        const value = { ...plan, layers: [{ ...plan.layers[0], generation }, plan.layers[1]] };
        expect(() => parseImageLayerPlan(JSON.stringify(value))).toThrow("未提交拆图任务");
    }
    expect(() => parseImageLayerPlan(JSON.stringify({ ...plan, layers: [plan.layers[0], { ...plan.layers[1], generation: { prompt: "对象", background: "opaque" } }] }))).toThrow("图层角色冲突");
});

test("规划合同要求每张图有独立参数且不粘贴跨层指令", () => {
    const prompt = imageLayerPlanningPrompt("拆分背景和主体");
    expect(prompt).toContain("每层 generation 必填");
    expect(prompt).toContain("不会收到其他层描述或用户总体要求");
    expect(prompt).toContain("不能粘贴前景");
});
