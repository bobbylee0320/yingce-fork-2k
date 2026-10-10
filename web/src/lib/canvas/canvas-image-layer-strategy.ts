export type ImageLayerRegion = {
    bbox: [number, number, number, number];
    shape: "rect" | "rounded-rect" | "ellipse";
    /** 圆角半径相对于短边，与规划预览尺寸无关。 */
    radiusRatio?: number;
};

export type ImageLayerExtraction = {
    method: "generate" | "source" | "source-region";
    region?: ImageLayerRegion;
};

export type ImageLayerSource = { dataUrl: string; storageKey?: string; mimeType?: string };
export type ImageLayerBackgroundPatch = { source: ImageLayerSource; regions: ImageLayerRegion[] };

export function validateImageLayerRegion(value: ImageLayerRegion): ImageLayerRegion {
    const box = value?.bbox;
    if (!Array.isArray(box) || box.length !== 4 || box.some((n) => !Number.isFinite(n) || n < 0 || n > 1000) || box[2] - box[0] < 2 || box[3] - box[1] < 2) throw new Error("原图提取区域无效，请在原图框选或填写 0–1000 的左、上、右、下坐标");
    if (!["rect", "rounded-rect", "ellipse"].includes(value.shape)) throw new Error("原图提取区域形状无效");
    if (value.shape === "rounded-rect" && (typeof value.radiusRatio !== "number" || !Number.isFinite(value.radiusRatio) || value.radiusRatio < 0 || value.radiusRatio > 0.5)) throw new Error("圆角比例必须在 0–0.5 之间");
    return { bbox: [...box], shape: value.shape, ...(value.shape === "rounded-rect" ? { radiusRatio: value.radiusRatio } : {}) };
}

/** 未指定策略时沿用模型路径；无效的显式策略不能回退为付费调用。 */
export function resolveImageLayerExtractions(count: number, input?: ImageLayerExtraction[], removals?: boolean[]) {
    if (!Number.isInteger(count) || count < 2 || count > 8 || (input && input.length !== count) || (removals && removals.length !== count)) throw new Error("拆层方式与目标数量不一致");
    return Array.from({ length: count }, (_, index): ImageLayerExtraction => {
        const extraction: ImageLayerExtraction = input ? input[index] : { method: "generate" };
        if (!extraction || typeof extraction !== "object") throw new Error(`第 ${index + 1} 层提取方式缺失`);
        if (extraction.method === "generate") return { method: "generate" };
        if (extraction.method === "source" && index === 0) {
            if (removals?.some((remove, i) => i > 0 && remove)) throw new Error("保留原图底图时不能同时移除对象，请改用模型修补底图或取消移除");
            return { method: "source" };
        }
        if (extraction.method === "source-region" && index > 0 && extraction.region) return { method: "source-region", region: validateImageLayerRegion(extraction.region) };
        throw new Error(`第 ${index + 1} 层提取方式或区域无效，请核对后再开始拆分`);
    });
}

export function imageLayerExtractionTargets(targets: string[], extractions: ImageLayerExtraction[]) {
    return targets.map((target, index) =>
        extractions[index]?.method === "source-region" && extractions[index].region ? `${target.replace(/，?区域\s*<bbox>[^<]*<\/bbox>/g, "").trim()}，区域 <bbox>${extractions[index].region!.bbox.join(" ")}</bbox>` : target,
    );
}

/** 只有所有待移除对象均有明确几何区域时，才限制生成底图的改动范围。 */
export function imageLayerBackgroundPatch(source: ImageLayerSource, extractions: ImageLayerExtraction[], removals: boolean[]): ImageLayerBackgroundPatch | undefined {
    if (extractions[0]?.method !== "generate") return;
    const indices = removals.flatMap((remove, i) => (i > 0 && remove ? [i] : []));
    if (!indices.length || indices.some((i) => extractions[i]?.method !== "source-region" || !extractions[i].region)) return;
    return { source, regions: indices.map((i) => validateImageLayerRegion(extractions[i].region!)) };
}

export function imageLayerModelCalls(extractions: ImageLayerExtraction[], removal: boolean) {
    return extractions.reduce((sum, extraction, i) => sum + (extraction.method === "generate" ? 1 + (i > 0 && removal ? 1 : 0) : 0), 0);
}
