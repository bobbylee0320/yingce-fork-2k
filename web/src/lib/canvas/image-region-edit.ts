import type { PixelSize } from "@/lib/canvas/image-operation-plan";

/** 区域框使用原图像素坐标；index 创建后不再变化，删除区域不会重排已写进提示词的 @区域N。 */
export type ImageEditRegion = { index: number; x: number; y: number; width: number; height: number };
export type RegionPoint = { x: number; y: number };

/** 标注参考图与编辑器共用的框色：模型看到的颜色必须与界面一致，所以不跟随主题。 */
export const IMAGE_REGION_COLOR = "#2f7cf6";
const REGION_MENTION_PATTERN = /@区域(\d+)/g;

export function regionMentionLabel(index: number) {
    return `区域${index}`;
}

export function nextRegionIndex(regions: readonly ImageEditRegion[]) {
    return regions.reduce((max, region) => Math.max(max, region.index), 0) + 1;
}

/** 太小的框通常是误点；按原图短边 1% 设下限，至少 8px。 */
export function minRegionSide(size: PixelSize) {
    return Math.max(8, Math.round(Math.min(size.width, size.height) * 0.01));
}

export function clampRegionPoint(point: RegionPoint, size: PixelSize): RegionPoint {
    return { x: Math.min(Math.max(point.x, 0), size.width), y: Math.min(Math.max(point.y, 0), size.height) };
}

export function regionFromPoints(start: RegionPoint, end: RegionPoint, size: PixelSize) {
    const a = clampRegionPoint(start, size);
    const b = clampRegionPoint(end, size);
    const x = Math.round(Math.min(a.x, b.x));
    const y = Math.round(Math.min(a.y, b.y));
    return { x, y, width: Math.round(Math.max(a.x, b.x)) - x, height: Math.round(Math.max(a.y, b.y)) - y };
}

/** 平移后保持尺寸不变并留在图内。 */
export function moveRegion(region: ImageEditRegion, dx: number, dy: number, size: PixelSize): ImageEditRegion {
    const x = Math.round(Math.min(Math.max(region.x + dx, 0), size.width - region.width));
    const y = Math.round(Math.min(Math.max(region.y + dy, 0), size.height - region.height));
    return { ...region, x, y };
}

/** 去重排序后的被引用区域编号。 */
export function referencedRegionIndexes(prompt: string) {
    const indexes = new Set<number>();
    for (const match of prompt.matchAll(REGION_MENTION_PATTERN)) indexes.add(Number(match[1]));
    return [...indexes].sort((a, b) => a - b);
}

export function regionMentionToken(index: number) {
    return `@${regionMentionLabel(index)}`;
}

/**
 * 区域增删（含撤销/重做）后同步提示词：新区域追加一行 “@区域N ”；
 * 被删区域连同以它开头的整行一起移除，其他位置的引用只去掉令牌，避免残留失效引用。
 */
export function syncRegionPrompt(prompt: string, before: readonly ImageEditRegion[], after: readonly ImageEditRegion[]) {
    const kept = new Set(after.map((region) => region.index));
    const previous = new Set(before.map((region) => region.index));
    let next = prompt;
    for (const index of previous) {
        if (kept.has(index)) continue;
        const leading = new RegExp(`^\\s*@区域${index}(?!\\d)`);
        next = next
            .split("\n")
            .filter((line) => !leading.test(line))
            .join("\n")
            .replace(new RegExp(`@区域${index}(?!\\d) ?`, "g"), "");
    }
    const referenced = new Set(referencedRegionIndexes(next));
    for (const region of [...after].sort((a, b) => a.index - b.index)) {
        if (previous.has(region.index) || referenced.has(region.index)) continue;
        next = `${next}${next && !next.endsWith("\n") ? "\n" : ""}${regionMentionToken(region.index)} `;
    }
    return next;
}

export function missingRegionReferences(prompt: string, regions: readonly ImageEditRegion[]) {
    const known = new Set(regions.map((region) => region.index));
    return referencedRegionIndexes(prompt).filter((index) => !known.has(index));
}

function percent(value: number, total: number) {
    return `${Math.round((value / Math.max(1, total)) * 1000) / 10}%`;
}

export function describeRegionPosition(region: ImageEditRegion, size: PixelSize) {
    return `左 ${percent(region.x, size.width)}，上 ${percent(region.y, size.height)}，宽 ${percent(region.width, size.width)}，高 ${percent(region.height, size.height)}`;
}

/**
 * 把用户写的 @区域N 编译成模型可执行的区域编辑提示词。
 * 位置用相对百分比给出，标注参考图只是辅助；不支持多图的模型仍能按坐标定位。
 */
export function buildRegionEditPrompt(input: { prompt: string; regions: readonly ImageEditRegion[]; size: PixelSize; annotatedReference: boolean; mask: boolean }) {
    const regions = [...input.regions].sort((a, b) => a.index - b.index);
    const intro = input.annotatedReference ? "图片区域编辑。第一张参考图是原图；第二张参考图是在原图上画了蓝色编号矩形框的标注图，框线和编号只用于标示位置。" : "图片区域编辑。参考图是原图。";
    const lines = [
        intro,
        ...(input.mask ? ["蒙版透明部分与全部框选区域一致。"] : []),
        "区域位置（相对原图宽高的百分比，原点在左上角）：",
        ...regions.map((region) => `${regionMentionLabel(region.index)}：${describeRegionPosition(region, input.size)}`),
        "修改要求：",
        input.prompt.trim().replace(REGION_MENTION_PATTERN, (_match, index: string) => `【${regionMentionLabel(Number(index))}】`),
        "只修改上述区域内的内容，区域外的构图、主体、光影、色彩和细节保持原图不变；最终图片中不要出现任何框线、编号或标注痕迹。",
    ];
    return lines.join("\n");
}

function badgeRadius(size: PixelSize) {
    return Math.max(12, Math.round(Math.min(size.width, size.height) * 0.022));
}

/** 原图 + 编号框的标注参考图；用 JPEG 控制大图体积，模型只需要看清框和编号。 */
export function renderRegionAnnotatedImage(source: CanvasImageSource, size: PixelSize, regions: readonly ImageEditRegion[]) {
    const surface = document.createElement("canvas");
    Object.assign(surface, { width: size.width, height: size.height });
    const context = surface.getContext("2d");
    if (!context) throw new Error("无法创建标注画布");
    context.drawImage(source, 0, 0, size.width, size.height);
    const line = Math.max(2, Math.round(Math.min(size.width, size.height) * 0.004));
    const radius = badgeRadius(size);
    for (const region of regions) {
        context.lineWidth = line;
        context.strokeStyle = IMAGE_REGION_COLOR;
        context.strokeRect(region.x + line / 2, region.y + line / 2, Math.max(1, region.width - line), Math.max(1, region.height - line));
        const cx = Math.min(Math.max(region.x + radius, radius), size.width - radius);
        const cy = Math.min(Math.max(region.y + radius, radius), size.height - radius);
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fillStyle = IMAGE_REGION_COLOR;
        context.fill();
        context.fillStyle = "#ffffff";
        context.font = `600 ${Math.round(radius * 1.15)}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(region.index), cx, cy + radius * 0.05);
    }
    const dataUrl = surface.toDataURL("image/jpeg", 0.92);
    if (!dataUrl.startsWith("data:image/jpeg")) throw new Error("标注参考图导出失败");
    return dataUrl;
}

/** 与 exportEditMask 相同合同：透明像素表示可编辑，其余保持不透明。 */
export function exportRegionMask(size: PixelSize, regions: readonly ImageEditRegion[]) {
    if (!regions.length) throw new Error("请先框选需要修改的区域");
    const surface = document.createElement("canvas");
    Object.assign(surface, { width: size.width, height: size.height });
    const context = surface.getContext("2d");
    if (!context) throw new Error("无法创建遮罩画布");
    context.fillStyle = "black";
    context.fillRect(0, 0, size.width, size.height);
    for (const region of regions) context.clearRect(region.x, region.y, region.width, region.height);
    const png = surface.toDataURL("image/png");
    if (!png.startsWith("data:image/png")) throw new Error("遮罩导出失败");
    return png;
}

/** 区域缩略图，供列表和 @ 菜单识别。 */
export function renderRegionThumbnail(source: CanvasImageSource, region: ImageEditRegion, edge = 192) {
    const scale = edge / Math.max(region.width, region.height, 1);
    const surface = document.createElement("canvas");
    Object.assign(surface, { width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)) });
    const context = surface.getContext("2d");
    if (!context) return "";
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, surface.width, surface.height);
    return surface.toDataURL("image/jpeg", 0.8);
}
