import { describe, expect, test } from "bun:test";
import {
    inspectLayerAlpha,
    validateLayerRasters,
    imageLayerCompositeSignature,
    copyImageLayerSources,
    supportsLayerDecomposition,
    supportsExperimentalLayerExtraction,
    parseExperimentalLayerTargets,
    experimentalLayerPrompt,
    experimentalLayerSignature,
    layerDecompositionConfig,
    imageLayerProviderMetadata,
    validateImageLayerRole,
    validateImageLayerOutput,
    hasUsableLayerTransparency,
    MAX_IMAGE_LAYERS,
    MAX_LAYER_PIXELS,
} from "@/lib/canvas/canvas-image-layers";
import { isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";
import { applyBatchPrimaryImage, removeCanvasNodes, isHiddenBatchChild } from "@/lib/canvas/canvas-project-domain";
import { failedImageBatchChildren, reconcileImageBatchRoot } from "@/lib/canvas/canvas-image-batch-retry";
import { buildImageLayerTaskResult } from "@/lib/canvas/canvas-generation-task-sync";
import { canvasNodeToAsset, findCanvasNodeAsset } from "@/lib/canvas/canvas-node-asset";
import type { Asset } from "@/stores/use-asset-store";
import { defaultConfig, createModelChannel } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const opaque = inspectLayerAlpha(2, 1, new Uint8ClampedArray([20, 30, 40, 255, 20, 30, 40, 255]));
const transparent = inspectLayerAlpha(2, 1, new Uint8ClampedArray([200, 0, 0, 128, 0, 0, 0, 0]));
function sample() {
    const children: CanvasNodeData[] = [0, 1].map((index) => ({
        id: `layer-${index}`,
        type: CanvasNodeType.Image,
        title: `图层 ${index}`,
        position: { x: 600, y: 240 * index },
        width: 320,
        height: 200,
        metadata: { storageKey: `resource:layer-${index}`, content: `/layer-${index}.png`, naturalWidth: 2, naturalHeight: 1, imageLayer: { groupId: "root", outputIndex: index }, batchRootId: "root" },
    }));
    const root: CanvasNodeData = {
        id: "root",
        type: CanvasNodeType.Image,
        title: "合成图",
        position: { x: 0, y: 0 },
        width: 320,
        height: 200,
        metadata: {
            content: "/composite.png",
            storageKey: "resource:composite",
            status: "success",
            taskId: "task",
            generationOutputCount: 2,
            isBatchRoot: true,
            batchChildIds: children.map((child) => child.id),
            imageLayerGroup: { width: 2, height: 1, compositeStatus: "ready", layers: children.map((child) => ({ nodeId: child.id, x: 0, y: 0, visible: true })) },
        },
    };
    return { root, children, nodes: [root, ...children] };
}

describe("独立透明图层验收", () => {
    test("原图底板输入仍要求不透明，去背景触发仍不能用单个透明像素冒充", () => {
        expect(() => validateImageLayerRole(opaque, 0)).not.toThrow();
        expect(() => validateImageLayerRole(transparent, 0)).toThrow("背景底图");
        const rgba = new Uint8ClampedArray(100 * 100 * 4).fill(255);
        rgba[3] = 254;
        expect(() => validateImageLayerRole(inspectLayerAlpha(100, 100, rgba), 0)).toThrow("半透明");
        rgba[3] = 0;
        const puncture = inspectLayerAlpha(100, 100, rgba);
        expect(puncture.transparent).toBe(true);
        expect(hasUsableLayerTransparency(puncture)).toBe(false);
        expect(() => validateImageLayerRole(puncture, 1)).toThrow("零散");
        expect(() => validateImageLayerRole(transparent, 1)).not.toThrow();
    });
    test("最终显示接受半透明背景与不透明前景，仍拒绝完全透明空图", () => {
        for (const info of [opaque, transparent, { ...opaque, opaque: false }]) {
            expect(() => validateImageLayerOutput(info)).not.toThrow();
        }
        expect(() => validateImageLayerOutput({ ...transparent, nonempty: false })).toThrow("空图层");
        expect(hasUsableLayerTransparency(opaque)).toBe(false);
    });
    test("完整场景只移除勾选对象，细节允许重复；单层提示不混入其他层排除指令", () => {
        const targets = ["房间：保留窗户、书架、地毯", "猫：保留轮廓", "毛线球：保留纹理"];
        const background = experimentalLayerPrompt({ prompt: "移除猫并补全遮挡；保留窗户、书架、地毯与毛线球", background: "opaque" });
        expect(background).toContain("移除猫并补全遮挡");
        expect(background).toContain("保留窗户、书架、地毯与毛线球");
        expect(background).toContain("alpha=255");
        expect(background).toContain("0–1000 相对坐标，不是像素");
        expect(background).toContain("补全为原有底色或环境");
        expect(background).not.toContain("不要清空底图");
        const foreground = experimentalLayerPrompt({ prompt: targets[1], background: "transparent" });
        expect(foreground).not.toContain("房间：保留");
        expect(foreground).not.toContain("毛线球：保留");
        expect(foreground).toContain("不做面板内部主体抠图");
        expect(background).not.toContain("保留自然边缘与接地阴影");
        const model = "gpt-image-2.5-flare";
        const channel = createModelChannel({ id: "backup", models: [model], interfaceType: "openai-image" });
        const config = { ...defaultConfig, model: `backup::${model}`, channels: [channel] };
        expect(imageLayerProviderMetadata(config, 0)).toEqual({ providerOptions: { "openai-image": { background: "opaque" } } });
        expect(imageLayerProviderMetadata(config, 1)).toEqual({ providerOptions: { "openai-image": { background: "transparent" } } });
    });
    test("实验提取明确协议、每层目标和透明背景；限制调用层数", () => {
        const model = "gpt-image-2.5-flare";
        const channel = createModelChannel({ id: "backup", models: [model], interfaceType: "openai-image" });
        expect(supportsExperimentalLayerExtraction({ ...defaultConfig, channels: [channel] }, `backup::${model}`)).toBe(true);
        expect(supportsLayerDecomposition({ ...defaultConfig, channels: [channel] }, `backup::${model}`)).toBe(false);
        const targets = parseExperimentalLayerTargets("背景\n汽车\n前景");
        expect(targets).toEqual(["背景", "汽车", "前景"]);
        expect(experimentalLayerPrompt({ prompt: "补全被遮挡背景", background: "opaque" })).toContain("补全被遮挡背景");
        expect(experimentalLayerPrompt({ prompt: "目标：汽车", background: "transparent" })).toContain("alpha=0");
        expect(experimentalLayerPrompt({ prompt: "目标：汽车", background: "transparent" })).toContain("目标：汽车");
        expect(() => parseExperimentalLayerTargets("汽车")).toThrow("2–8");
        expect(() => parseExperimentalLayerTargets("汽车\n汽车")).toThrow("重复");
        expect(() => parseExperimentalLayerTargets(Array.from({ length: 9 }, (_, i) => String(i)).join("\n"))).toThrow("2–8");
    });
    test("未完成实验组删除清理逐层节点，复制不继承付费提取计划", () => {
        const { root, children, nodes } = sample();
        const staged = { ...root, metadata: { experimentalLayerPlan: { sourceNodeId: "source", requests: children.map((child) => ({ nodeId: child.id, target: child.id })) } } };
        expect(removeCanvasNodes([staged, ...children], new Set([root.id])).nodes).toHaveLength(0);
        expect(isolateCopiedNodeMetadata(staged, new Map([[root.id, "copy"]])).experimentalLayerPlan).toBeUndefined();
        expect(experimentalLayerSignature(staged, nodes)).not.toBe(experimentalLayerSignature(staged, [root, ...children.map((child) => ({ ...child, metadata: { ...child.metadata, storageKey: "edited" } }))]));
    });
    test("读取真实 alpha，保留半透明边缘和重叠；唯一底图置底", () => {
        expect(opaque).toMatchObject({ transparent: false, nonempty: true });
        expect(transparent).toMatchObject({ transparent: true, nonempty: true });
        expect(validateLayerRasters([transparent, opaque, transparent])).toEqual([1, 0, 2]);
        expect(validateLayerRasters([transparent, transparent])).toEqual([0, 1]);
    });
    test("多张不透明图保留返回顺序；仍拒绝单张拼版、空图层、不同尺寸及超限输出", () => {
        expect(() => validateLayerRasters([opaque])).toThrow("至少需要两张");
        expect(validateLayerRasters([opaque, opaque])).toEqual([0, 1]);
        expect(validateLayerRasters([transparent, opaque, opaque])).toEqual([0, 1, 2]);
        expect(() => validateLayerRasters([opaque, { ...transparent, nonempty: false }])).toThrow("空图层");
        expect(() => validateLayerRasters([opaque, { ...transparent, width: 3 }])).toThrow("尺寸不一致");
        expect(() => validateLayerRasters(Array(MAX_IMAGE_LAYERS + 1).fill(transparent))).toThrow("数量");
        expect(() => inspectLayerAlpha(MAX_LAYER_PIXELS + 1, 1, new Uint8ClampedArray())).toThrow("尺寸");
        expect(() => inspectLayerAlpha(2, 1, new Uint8ClampedArray(4))).toThrow("尺寸");
    });
    test("模型名不能代替专用协议能力", () => {
        const model = "bytedance/seedream-v5.0-pro/layer-decomposition";
        const channel = createModelChannel({ id: "test", models: [model], interfaceType: "image-tools-layer-decomposition" });
        expect(supportsLayerDecomposition({ ...defaultConfig, channels: [channel] }, `test::${model}`)).toBe(true);
        expect(supportsLayerDecomposition({ ...defaultConfig, channels: [{ ...channel, interfaceType: undefined }] }, `test::${model}`)).toBe(false);
    });
    test("来源工作流和多图数量不能把拆层改路由或提交多次任务", () => {
        const config = layerDecompositionConfig({ ...defaultConfig, taskWorkflowProvider: "runninghub", count: "4" }, "dedicated", { quality: "1k" });
        expect(config).toMatchObject({ model: "dedicated", imageModel: "dedicated", count: "1", taskWorkflowProvider: "model", quality: "1k" });
    });
});

describe("图层组状态与画布操作", () => {
    test("进行中或失败的拆层计划也收纳在组内，不把底图设为成功主图或批量收费重试", () => {
        const { root, children, nodes } = sample();
        const pending = {
            ...root,
            metadata: {
                isBatchRoot: true,
                batchChildIds: children.map((child) => child.id),
                imageBatchExpanded: false,
                status: "error" as const,
                experimentalLayerPlan: { sourceNodeId: "source", requests: children.map((child) => ({ nodeId: child.id, target: child.title })) },
            },
        };
        expect(isHiddenBatchChild(children[0], [pending, ...children])).toBe(true);
        expect(applyBatchPrimaryImage(pending, children[0])).toBe(pending);
        expect(reconcileImageBatchRoot(pending, nodes)).toBe(pending);
        expect(
            failedImageBatchChildren(
                pending,
                children.map((child) => ({ ...child, metadata: { ...child.metadata, status: "error" as const } })),
            ),
        ).toHaveLength(0);
    });
    test("合成资源更新后不沿用同一原任务的旧素材绑定", () => {
        const { root } = sample();
        const old = { ...canvasNodeToAsset(root, { canvasId: "canvas", source: "canvas-generation", taskId: "task" }), id: "old", createdAt: "", updatedAt: "" } as Asset;
        const updated = { ...root, metadata: { ...root.metadata, storageKey: "resource:new-composite", content: "/new.png" } };
        expect(findCanvasNodeAsset([old], root, "canvas", "task")?.id).toBe("old");
        expect(findCanvasNodeAsset([old], updated, "canvas", "task")).toBeUndefined();
    });
    test("画布移动、节点名称、展开与收起不影响合成；顺序/可见性/资源改变会更新", () => {
        const { root, children, nodes } = sample();
        const group = root.metadata!.imageLayerGroup!;
        const signature = imageLayerCompositeSignature(group, nodes);
        expect(
            imageLayerCompositeSignature(
                group,
                nodes.map((node) => ({ ...node, title: "改名", position: { x: 5000, y: 5000 }, metadata: { ...node.metadata, imageBatchExpanded: true } })),
            ),
        ).toBe(signature);
        expect(imageLayerCompositeSignature({ ...group, layers: [...group.layers].reverse() }, nodes)).not.toBe(signature);
        expect(imageLayerCompositeSignature({ ...group, layers: group.layers.map((layer) => ({ ...layer, visible: false })) }, nodes)).not.toBe(signature);
        expect(imageLayerCompositeSignature(group, [root, { ...children[0], metadata: { ...children[0].metadata, storageKey: "new" } }, children[1]])).not.toBe(signature);
        expect(isHiddenBatchChild(children[0], [root])).toBe(true);
        expect(isHiddenBatchChild(children[0], [{ ...root, metadata: { ...root.metadata, imageBatchExpanded: true } }])).toBe(false);
    });
    test("删除子层不替换合成图，删除组清理全部子层，MJ 主图逻辑不介入", () => {
        const { root, children, nodes } = sample();
        expect(applyBatchPrimaryImage(root, children[0])).toBe(root);
        expect(reconcileImageBatchRoot(root, nodes)).toBe(root);
        const next = removeCanvasNodes(nodes, new Set([children[0].id])).nodes;
        expect(next[0].metadata?.content).toBe("/composite.png");
        expect(next[0].metadata?.imageLayerGroup?.layers.map((layer) => layer.nodeId)).toEqual([children[1].id]);
        expect(next[0].metadata?.imageLayerGroup?.compositeStatus).toBe("updating");
        expect(removeCanvasNodes(nodes, new Set([root.id])).nodes).toHaveLength(0);
    });
    test("复制整组重映射内部身份，单独复制子层脱离原组和任务", () => {
        const { root, children, nodes } = sample();
        expect(copyImageLayerSources(root, nodes)).toEqual(nodes);
        const mapping = new Map(nodes.map((node) => [node.id, `copy-${node.id}`]));
        const copy = isolateCopiedNodeMetadata(root, mapping);
        expect(copy.taskId).toBeUndefined();
        expect(copy.batchChildIds).toEqual(["copy-layer-0", "copy-layer-1"]);
        expect(copy.imageLayerGroup?.layers[0].nodeId).toBe("copy-layer-0");
        expect(isolateCopiedNodeMetadata(children[0], mapping).imageLayer?.groupId).toBe("copy-root");
        const detached = isolateCopiedNodeMetadata(children[0], new Map([[children[0].id, "single"]]));
        expect(detached.imageLayer).toBeUndefined();
        expect(detached.batchRootId).toBeUndefined();
    });
    test("已消费任务重放不重建图层、不复活已删除子层、不覆盖编辑", async () => {
        const { root, nodes } = sample();
        const task = { id: "task", type: "canvas_image", status: "succeeded" as const, prompt: "", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ images: [{ dataUrl: "/a.png" }, { dataUrl: "/b.png" }] }) };
        const result = await buildImageLayerTaskResult(root, task, nodes.slice(0, 2));
        expect(result.node).toBe(root);
        expect(result.additionalNodes).toHaveLength(0);
        const restored = await buildImageLayerTaskResult({ ...root, metadata: { ...root.metadata, status: "error" } }, task, nodes.slice(0, 2));
        expect(restored.node.metadata?.status).toBe("success");
        expect(restored.additionalNodes).toHaveLength(0);
    });
});
