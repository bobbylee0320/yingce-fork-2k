import { inspectLayerAlpha, MAX_GROUP_PIXELS, MAX_IMAGE_LAYERS, MAX_LAYER_PIXELS, validateLayerRasters, validateImageLayerOutput, type LayerRasterInfo } from "@/lib/canvas/canvas-image-layers";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type LayerInput = { dataUrl: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string };
type DecodedLayer = { bitmap: ImageBitmap; blob: Blob; info: LayerRasterInfo };

export async function decodeLayer(input: LayerInput): Promise<DecodedLayer> {
    let blob = input.storageKey ? await getImageBlob(input.storageKey) : null;
    if (!blob) {
        const response = await fetch(input.dataUrl);
        if (!response.ok) throw new Error("无法读取完整图层资源");
        blob = await response.blob();
    }
    const bitmap = await createImageBitmap(blob);
    try {
        if (bitmap.width * bitmap.height > MAX_LAYER_PIXELS) throw new Error("图层尺寸超过处理上限");
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("浏览器不支持图层合成");
        context.drawImage(bitmap, 0, 0);
        const info = inspectLayerAlpha(bitmap.width, bitmap.height, context.getImageData(0, 0, bitmap.width, bitmap.height).data);
        canvas.width = canvas.height = 0;
        return { bitmap, blob, info };
    } catch (error) {
        bitmap.close();
        throw error;
    }
}

export function pngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图层合成 PNG 失败"))), "image/png"));
}

export async function inspectImageLayer(input: LayerInput) {
    const decoded = await decodeLayer(input);
    try {
        return decoded.info;
    } finally {
        decoded.bitmap.close();
    }
}

/** 模型尺寸取整最多允许 1% 比例差，保存时统一为源图画布；明显改构图的结果拒绝。 */
export async function normalizeImageLayerCanvas(input: LayerInput, target?: { width: number; height: number }) {
    const decoded = await decodeLayer(input);
    try {
        const { info } = decoded;
        if (!target) return { image: { ...input, width: info.width, height: info.height }, info };
        if (!Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height) || target.width <= 0 || target.height <= 0 || target.width * target.height > MAX_LAYER_PIXELS) throw new Error("源图画布尺寸无效或超过处理上限");
        if (Math.abs(info.width / info.height / (target.width / target.height) - 1) > 0.01)
            throw new Error(`模型结果比例与原图不一致（原图 ${target.width}×${target.height}，实际 ${info.width}×${info.height}），已拒绝该图层；不会拉伸或裁切来掩盖构图变化`);
        if (info.width === target.width && info.height === target.height) return { image: { ...input, width: info.width, height: info.height }, info };
        const canvas = document.createElement("canvas");
        canvas.width = target.width;
        canvas.height = target.height;
        try {
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("浏览器不支持图层画布归一化");
            context.drawImage(decoded.bitmap, 0, 0, target.width, target.height);
            const normalized = inspectLayerAlpha(target.width, target.height, context.getImageData(0, 0, target.width, target.height).data);
            const blob = await pngBlob(canvas);
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error("无法读取归一化 PNG 图层"));
                reader.readAsDataURL(blob);
            });
            return { image: { dataUrl, width: target.width, height: target.height, bytes: blob.size, mimeType: "image/png" }, info: normalized };
        } finally {
            canvas.width = canvas.height = 0;
        }
    } finally {
        decoded.bitmap.close();
    }
}

/** 验收所有输出后一次提交；失败时不留下部分画布图层。 */
export async function decodeAndComposeImageLayers(inputs: LayerInput[], roles?: number[]) {
    if (roles && (roles.length !== inputs.length || !inputs.length || inputs.length > MAX_IMAGE_LAYERS)) throw new Error("拆层合成角色或数量无效");
    if (!roles && (inputs.length < 2 || inputs.length > MAX_IMAGE_LAYERS)) validateLayerRasters(inputs.map(() => ({ width: 1, height: 1, transparent: true, nonempty: true })));
    if (inputs.some((input) => !input || (!input.dataUrl && !input.storageKey))) throw new Error("拆层结果包含缺失的图层资源");
    const decoded: DecodedLayer[] = [];
    try {
        let pixels = 0;
        for (const input of inputs) {
            const layer = await decodeLayer(input);
            decoded.push(layer);
            pixels += layer.info.width * layer.info.height;
            if (pixels > MAX_GROUP_PIXELS) throw new Error("图层总像素量超过处理上限");
        }
        const order = roles
            ? decoded.map((layer, index) => {
                  validateImageLayerOutput(layer.info);
                  if (layer.info.width !== decoded[0].info.width || layer.info.height !== decoded[0].info.height) throw new Error("图层尺寸不一致，无法确定合成坐标");
                  return index;
              })
            : validateLayerRasters(decoded.map((layer) => layer.info));
        const { width, height } = decoded[0].info;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器不支持图层合成");
        for (const index of order) context.drawImage(decoded[index].bitmap, 0, 0);
        const composite = await pngBlob(canvas);
        canvas.width = canvas.height = 0;
        return { width, height, order, composite, layers: decoded.map(({ blob, info }) => ({ blob, ...info })) };
    } finally {
        decoded.forEach((layer) => layer.bitmap.close());
    }
}

/** 编辑、删除、调整顺序后用同一组坐标重建合成图，画布展开位置不参与。 */
export async function composeCanvasImageLayerGroup(group: NonNullable<CanvasNodeMetadata["imageLayerGroup"]>, nodes: CanvasNodeData[]) {
    if (!Number.isSafeInteger(group.width) || !Number.isSafeInteger(group.height) || group.width <= 0 || group.height <= 0 || group.width * group.height > MAX_LAYER_PIXELS) throw new Error("图层组合成尺寸无效");
    if (group.layers.length > MAX_IMAGE_LAYERS || group.width * group.height * group.layers.length > MAX_GROUP_PIXELS || group.layers.some((layer) => !Number.isFinite(layer.x) || !Number.isFinite(layer.y)))
        throw new Error("图层组合成参数无效或超过处理上限");
    const canvas = document.createElement("canvas");
    canvas.width = group.width;
    canvas.height = group.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图层合成");
    for (const layer of group.layers) {
        if (!layer.visible) continue;
        const node = nodes.find((item) => item.id === layer.nodeId);
        if (!node?.metadata?.content) throw new Error("图层资源缺失，无法更新合成图");
        const decoded = await decodeLayer({ dataUrl: node.metadata.content, storageKey: node.metadata.storageKey });
        try {
            if (decoded.info.width !== group.width || decoded.info.height !== group.height) throw new Error("编辑后的图层尺寸与图层组不一致，无法合成");
            if (node.metadata.imageLayer?.kind) validateImageLayerOutput(decoded.info);
            context.drawImage(decoded.bitmap, layer.x, layer.y);
        } finally {
            decoded.bitmap.close();
        }
    }
    const blob = await pngBlob(canvas);
    canvas.width = canvas.height = 0;
    return blob;
}
