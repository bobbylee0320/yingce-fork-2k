import { validateImageLayerRegion, type ImageLayerRegion } from "./canvas-image-layer-strategy";

/** 仅在均匀外侧与对比明显的内侧一致时，建议附近的面板边界。 */
export function suggestImageLayerRegion(width: number, height: number, pixels: Uint8ClampedArray, region: ImageLayerRegion): ImageLayerRegion | undefined {
    validateImageLayerRegion(region);
    if (pixels.length !== width * height * 4 || width < 32 || height < 32 || region.shape === "ellipse") return;
    const box = region.bbox.map((n, i) => Math.round((n * (i % 2 ? height : width)) / 1000));
    const result = [...box];
    let found = 0;
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (let side = 0; side < 4; side++) {
        const horizontal = side % 2 === 1,
            length = horizontal ? height : width,
            other = horizontal ? width : height;
        const span = horizontal ? [box[0], box[2]] : [box[1], box[3]];
        const extent = horizontal ? box[3] - box[1] : box[2] - box[0];
        const distance = Math.min(Math.round(length * 0.08), Math.round(extent * 0.25));
        const sign = side < 2 ? -1 : 1;
        const positions: number[] = [];
        for (let p = Math.round(span[0] + (span[1] - span[0]) * 0.2); p < span[1] - (span[1] - span[0]) * 0.2; p += Math.max(1, Math.round((span[1] - span[0]) / 64))) positions.push(p);
        if (positions.length < 8) continue;
        const color = (edge: number, p: number) => {
            const offset = (horizontal ? edge * width + p : p * width + edge) * 4;
            return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
        };
        const difference = (a: number[], b: number[]) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
        let best: { edge: number; score: number } | undefined;
        for (let edge = Math.max(13, box[side] - distance); edge <= Math.min(length - 14, box[side] + distance); edge++) {
            const outside = [4, 8, 12].flatMap((offset) => positions.map((p) => color(edge + sign * offset, p)));
            if (outside.some((value) => value[3] !== 255)) continue;
            const average = [0, 1, 2].map((channel) => median(outside.map((value) => value[channel])));
            const variation = outside.reduce((sum, value) => sum + difference(value, average), 0) / outside.length;
            const contrast = median(positions.map((p) => difference(color(edge - sign * 8, p), average)));
            const matching = Math.max(...[Math.max(0, span[0] - 12), Math.min(other - 1, span[1] + 12)].map((p) => difference(color(edge + sign * 8, p), average)));
            if (variation >= 20 || contrast <= 18 || matching >= 26) continue;
            const score = (contrast / (3 + variation + matching)) * (1 - (0.25 * Math.abs(edge - box[side])) / Math.max(1, distance));
            if (!best || score > best.score) best = { edge, score };
        }
        if (!best || best.score < 1.2) continue;
        const edges: Array<{ edge: number; gradient: number }> = [];
        for (let edge = Math.max(1, best.edge - 10); edge <= Math.min(length - 1, best.edge + 10); edge++) {
            edges.push({ edge, gradient: median(positions.map((p) => difference(color(edge, p), color(edge - 1, p)))) });
        }
        const threshold = Math.max(12, Math.max(...edges.map((item) => item.gradient)) * 0.55);
        const strong = edges.filter((item) => item.gradient >= threshold);
        if (!strong.length) continue;
        result[side] = (side < 2 ? strong[0] : strong[strong.length - 1]).edge;
        found++;
    }
    if (found < 2 || result[2] <= result[0] || result[3] <= result[1]) return;
    const bbox = result.map((n, i) => Number(((n * 1000) / (i % 2 ? height : width)).toFixed(3))) as ImageLayerRegion["bbox"];
    if (bbox.every((n, i) => Math.abs(n - region.bbox[i]) < 0.5)) return;
    return validateImageLayerRegion({ ...region, bbox });
}

/** alpha 有效区域包含柔和边缘，不推断或移除不透明背景。 */
export function imageLayerAlphaBounds(width: number, height: number, pixels: Uint8ClampedArray) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) throw new Error("图层像素尺寸无效");
    let left = width,
        top = height,
        right = 0,
        bottom = 0;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            if (!pixels[(y * width + x) * 4 + 3]) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x + 1);
            bottom = Math.max(bottom, y + 1);
        }
    if (right <= left || bottom <= top) throw new Error("图层完全透明，无法制作独立素材");
    return { left, top, width: right - left, height: bottom - top };
}
