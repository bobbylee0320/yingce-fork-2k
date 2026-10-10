import { inspectLayerAlpha, validateImageLayerRole, validateImageLayerOutput } from "@/lib/canvas/canvas-image-layers";
import { validateImageLayerRegion, type ImageLayerBackgroundPatch, type ImageLayerExtraction, type ImageLayerRegion } from "@/lib/canvas/canvas-image-layer-strategy";
import { decodeLayer, pngBlob, type LayerInput } from "@/services/canvas-image-layer-compositor";
import { imageLayerAlphaBounds, suggestImageLayerRegion } from "@/lib/canvas/canvas-image-layer-region";
import type { ImageLayerPlan } from "@/lib/canvas/canvas-image-layer-plan";

function regionPath(context: CanvasRenderingContext2D, region: ImageLayerRegion, width: number, height: number) {
    const { bbox, shape, radiusRatio } = validateImageLayerRegion(region);
    const [left, top, right, bottom] = bbox.map((n, i) => Math.round((n * (i % 2 ? height : width)) / 1000));
    const w = right - left,
        h = bottom - top;
    if (w < 1 || h < 1) throw new Error("原图提取区域小于一个像素");
    if (shape === "ellipse") {
        context.moveTo(right, top + h / 2);
        context.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        context.closePath();
    } else if (shape === "rounded-rect") context.roundRect(left, top, w, h, Math.min(w, h) * radiusRatio!);
    else context.rect(left, top, w, h);
}

async function encode(canvas: HTMLCanvasElement) {
    const blob = await pngBlob(canvas);
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("无法读取原图提取 PNG"));
        reader.readAsDataURL(blob);
    });
    return { dataUrl, width: canvas.width, height: canvas.height, bytes: blob.size, mimeType: "image/png" };
}

/** 生成独立设计素材，保持参与原位置合成的图层不变。 */
export async function cropImageLayerMaterial(source: LayerInput) {
    const decoded = await decodeLayer(source);
    const canvas = document.createElement("canvas");
    try {
        canvas.width = decoded.info.width;
        canvas.height = decoded.info.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器不支持独立素材提取");
        context.drawImage(decoded.bitmap, 0, 0);
        const bounds = imageLayerAlphaBounds(canvas.width, canvas.height, context.getImageData(0, 0, canvas.width, canvas.height).data);
        canvas.width = bounds.width;
        canvas.height = bounds.height;
        context.drawImage(decoded.bitmap, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
        return { ...(await encode(canvas)), bounds };
    } finally {
        decoded.bitmap.close();
        canvas.width = canvas.height = 0;
    }
}

export async function calibrateImageLayerRegions(source: LayerInput, regions: ImageLayerRegion[]) {
    const decoded = await decodeLayer(source);
    const canvas = document.createElement("canvas");
    try {
        const scale = Math.min(1, 1200 / Math.max(decoded.info.width, decoded.info.height));
        canvas.width = Math.round(decoded.info.width * scale);
        canvas.height = Math.round(decoded.info.height * scale);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器不支持区域边界校准");
        context.drawImage(decoded.bitmap, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return regions.map((region) => suggestImageLayerRegion(canvas.width, canvas.height, pixels, region));
    } finally {
        decoded.bitmap.close();
        canvas.width = canvas.height = 0;
    }
}

export async function calibrateImageLayerPlan(source: LayerInput, plan: ImageLayerPlan): Promise<ImageLayerPlan> {
    const indices = plan.layers.flatMap((layer, i) => (layer.extraction?.method === "source-region" && layer.extraction.region ? [i] : []));
    if (!indices.length) return plan;
    const regions = indices.map((i) => plan.layers[i].extraction!.region!);
    let proposals: Array<ImageLayerRegion | undefined>;
    try {
        proposals = await calibrateImageLayerRegions(source, regions);
    } catch {
        return { ...plan, warnings: [...(plan.warnings || []), "规则边界校准不可用，保留已有规划；请核对预览并框选。没有新增模型调用。"] };
    }
    const layers = plan.layers.map((layer) => ({ ...layer }));
    const warnings = [...(plan.warnings || [])];
    indices.forEach((index, n) => {
        const region = proposals[n];
        // 边界校准不能扩展到其他已规划的面板。
        const crossesPanel =
            region &&
            regions.some((original, j) => {
                const other = proposals[j] || original;
                return j !== n && Math.min(region.bbox[2], other.bbox[2]) - Math.max(region.bbox[0], other.bbox[0]) > 2 && Math.min(region.bbox[3], other.bbox[3]) - Math.max(region.bbox[1], other.bbox[1]) > 2;
            });
        if (region && !crossesPanel) {
            layers[index] = { ...layers[index], bbox: region.bbox, extraction: { method: "source-region", region } };
            warnings.push(`“${layers[index].name}”已按规则区域边缘校准，请核对完整场景预览；校准不是精确分割。`);
        } else warnings.push(`“${layers[index].name}”未找到可靠的规则边界，请核对预览并框选；没有新增模型调用。`);
    });
    return { ...plan, layers, warnings };
}

/** 按原坐标复制源图像素，不裁切或重新居中输出画布。 */
export async function extractImageLayerFromSource(source: LayerInput, extraction: ImageLayerExtraction, target?: { width: number; height: number }) {
    if (extraction.method === "generate" || (extraction.method === "source-region" && !extraction.region)) throw new Error("原图提取方式或区域缺失");
    if (extraction.region) validateImageLayerRegion(extraction.region);
    const decoded = await decodeLayer(source);
    const canvas = document.createElement("canvas");
    try {
        const { width, height } = decoded.info;
        if (target && (width !== target.width || height !== target.height)) throw new Error("原图资源尺寸已变化，请重新规划");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器不支持原图图层提取");
        if (extraction.method === "source-region") {
            context.beginPath();
            regionPath(context, extraction.region!, width, height);
            context.clip();
        }
        context.drawImage(decoded.bitmap, 0, 0);
        const info = inspectLayerAlpha(width, height, context.getImageData(0, 0, width, height).data);
        validateImageLayerOutput(info);
        return await encode(canvas);
    } finally {
        decoded.bitmap.close();
        canvas.width = canvas.height = 0;
    }
}

/** 选定区域外保留原图，仅在区域内使用生成的修补结果。 */
export async function patchImageLayerBackground(generated: LayerInput, patch: ImageLayerBackgroundPatch) {
    if (!patch.regions.length || patch.regions.length > 7) throw new Error("底图修补区域无效");
    patch.regions.forEach(validateImageLayerRegion);
    const source = await decodeLayer(patch.source);
    const canvas = document.createElement("canvas");
    try {
        validateImageLayerRole(source.info, 0);
        const result = await decodeLayer(generated);
        try {
            validateImageLayerOutput(result.info);
            const { width, height } = source.info;
            if (result.info.width !== width || result.info.height !== height) throw new Error("底图修补结果与原图尺寸不一致");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("浏览器不支持底图局部修补");
            context.drawImage(source.bitmap, 0, 0);
            context.beginPath();
            patch.regions.forEach((region) => regionPath(context, region, width, height));
            context.clip();
            context.drawImage(result.bitmap, 0, 0);
            return await encode(canvas);
        } finally {
            result.bitmap.close();
        }
    } finally {
        source.bitmap.close();
        canvas.width = canvas.height = 0;
    }
}
