import { nanoid } from "nanoid";

import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";
import { CanvasNodeType, type CanvasMediaVersion, type CanvasMediaVersionGeneration, type CanvasMediaVersionMedia, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/** 每个节点保留最近的版本数；超出时丢弃最早的非当前版本，资源回收仍由引用检查兜底。 */
export const MEDIA_VERSION_LIMIT = 30;

const MEDIA_KEYS = [
    "content",
    "storageKey",
    "previewContent",
    "mimeType",
    "bytes",
    "durationMs",
    "hasAudio",
    "waveform",
    "waveformVersion",
    "naturalWidth",
    "naturalHeight",
    "videoPreview",
    "imageRotation",
    "assetId",
] as const satisfies readonly (keyof CanvasMediaVersionMedia)[];

const GENERATION_KEYS = ["prompt", "model", "producedModel", "size", "quality", "seconds", "references", "taskId", "taskDurationMs"] as const satisfies readonly (keyof CanvasMediaVersionGeneration)[];

// 已有资源标识时不在历史里重复保存大段 data URL，展示时通过 storageKey 解析。
const INLINE_DATA_URL_LIMIT = 2048;

type MediaVersionSource = CanvasMediaVersion["source"];

export function isMediaVersionNode(node: CanvasNodeData | null | undefined): node is CanvasNodeData {
    if (!node) return false;
    if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) return false;
    const metadata = node.metadata;
    return !metadata?.isBatchRoot && !metadata?.batchRootId && !metadata?.imageLayerGroup && !metadata?.imageLayer && !metadata?.layerExtraction;
}

function hasMedia(media: Pick<CanvasNodeMetadata, "content" | "storageKey"> | undefined) {
    return Boolean(media?.storageKey || media?.content);
}

function mediaIdentity(media: Pick<CanvasNodeMetadata, "content" | "storageKey"> | undefined) {
    return media?.storageKey || media?.content || "";
}

function snapshotMedia(metadata: CanvasNodeMetadata | undefined): CanvasMediaVersionMedia {
    const media: CanvasMediaVersionMedia = {};
    for (const key of MEDIA_KEYS) {
        const value = metadata?.[key];
        if (value !== undefined && value !== null && value !== "") Object.assign(media, { [key]: value });
    }
    if (media.storageKey && media.content?.startsWith("data:") && media.content.length > INLINE_DATA_URL_LIMIT) delete media.content;
    if (media.storageKey && media.previewContent?.startsWith("data:") && media.previewContent.length > INLINE_DATA_URL_LIMIT) delete media.previewContent;
    return media;
}

function snapshotGeneration(metadata: CanvasNodeMetadata | undefined): CanvasMediaVersionGeneration | undefined {
    const generation: CanvasMediaVersionGeneration = {};
    for (const key of GENERATION_KEYS) {
        const value = metadata?.[key];
        if (value !== undefined && value !== null && value !== "") Object.assign(generation, { [key]: value });
    }
    return Object.keys(generation).length ? generation : undefined;
}

function inferSource(metadata: CanvasNodeMetadata | undefined): MediaVersionSource {
    return metadata?.taskId || metadata?.generationType || metadata?.producedModel || metadata?.taskDurationMs ? "generate" : "upload";
}

export function listMediaVersions(node: CanvasNodeData | null | undefined): CanvasMediaVersion[] {
    return [...(node?.metadata?.mediaVersions || [])].sort((left, right) => left.number - right.number);
}

/** 当前显示的媒体对应的版本；节点媒体被其他路径改写后不再认定旧指针。 */
export function currentMediaVersion(node: CanvasNodeData | null | undefined): CanvasMediaVersion | undefined {
    const identity = mediaIdentity(node?.metadata);
    if (!identity) return undefined;
    const versions = node?.metadata?.mediaVersions || [];
    const pointed = versions.find((version) => version.id === node?.metadata?.currentMediaVersionId);
    if (pointed && mediaIdentity(pointed.media) === identity) return pointed;
    return versions.find((version) => mediaIdentity(version.media) === identity);
}

/** 存在可回看的版本（不只是当前显示的那一个）时才提供版本入口。 */
export function hasMediaVersionHistory(node: CanvasNodeData | null | undefined) {
    if (!isMediaVersionNode(node)) return false;
    const current = currentMediaVersion(node);
    return (node.metadata?.mediaVersions || []).some((version) => version.id !== current?.id);
}

function trimVersions(versions: CanvasMediaVersion[], keepId: string) {
    if (versions.length <= MEDIA_VERSION_LIMIT) return versions;
    const sorted = [...versions].sort((left, right) => left.number - right.number);
    const removable = sorted.filter((version) => version.id !== keepId).slice(0, versions.length - MEDIA_VERSION_LIMIT);
    const removed = new Set(removable.map((version) => version.id));
    return versions.filter((version) => !removed.has(version.id));
}

/** 把节点当前媒体登记为版本并设为当前；同一资源只登记一次。 */
export function ensureCurrentMediaVersion(node: CanvasNodeData, options: { source?: MediaVersionSource; now?: string } = {}): CanvasNodeData {
    if (!isMediaVersionNode(node) || !hasMedia(node.metadata)) return node;
    const existing = currentMediaVersion(node);
    if (existing) {
        return existing.id === node.metadata?.currentMediaVersionId ? node : { ...node, metadata: { ...node.metadata, currentMediaVersionId: existing.id } };
    }
    const versions = node.metadata?.mediaVersions || [];
    const version: CanvasMediaVersion = {
        id: nanoid(),
        number: versions.reduce((max, item) => Math.max(max, item.number), 0) + 1,
        createdAt: options.now || node.metadata?.taskCompletedAt || new Date().toISOString(),
        source: options.source || inferSource(node.metadata),
        media: snapshotMedia(node.metadata),
        generation: snapshotGeneration(node.metadata),
    };
    return {
        ...node,
        metadata: {
            ...node.metadata,
            mediaVersions: trimVersions([...versions, version], version.id),
            currentMediaVersionId: version.id,
        },
    };
}

/** 原位替换媒体前调用：保证旧媒体已经进入历史，返回需要带入新状态的版本字段。 */
export function mediaVersionFieldsBeforeReplace(node: CanvasNodeData | null | undefined): Pick<CanvasNodeMetadata, "mediaVersions" | "currentMediaVersionId"> {
    if (!node || !isMediaVersionNode(node)) return {};
    const recorded = ensureCurrentMediaVersion(node);
    return { mediaVersions: recorded.metadata?.mediaVersions, currentMediaVersionId: recorded.metadata?.currentMediaVersionId };
}

/** 生成结果原位提交后登记为当前版本；失败、生成中和批次节点不登记。 */
export function recordCommittedMediaVersion(node: CanvasNodeData): CanvasNodeData {
    const status = node.metadata?.status;
    if (status === "loading" || status === "error") return node;
    return ensureCurrentMediaVersion(node, { source: "generate" });
}

/** 上传替换：旧媒体先入历史，新媒体作为当前版本；媒体类型变化时历史不再有意义。 */
export function recordReplacedMediaVersion(previous: CanvasNodeData | undefined, next: CanvasNodeData, source: MediaVersionSource): CanvasNodeData {
    if (!previous || previous.type !== next.type) {
        const cleared = { ...next, metadata: { ...next.metadata, mediaVersions: undefined, currentMediaVersionId: undefined } };
        return ensureCurrentMediaVersion(cleared, { source });
    }
    const carried = { ...next, metadata: { ...next.metadata, ...mediaVersionFieldsBeforeReplace(previous) } };
    return ensureCurrentMediaVersion(carried, { source });
}

export type MediaVersionAdoptBlock = "locked" | "loading" | "missing";

export function mediaVersionAdoptBlock(node: CanvasNodeData | null | undefined): MediaVersionAdoptBlock | null {
    if (!node) return "missing";
    if (node.metadata?.locked) return "locked";
    if (node.metadata?.status === "loading" || node.metadata?.fileUpload === "uploading") return "loading";
    return null;
}

function adoptedGeometry(node: CanvasNodeData, media: CanvasMediaVersionMedia) {
    const keepSize = node.type === CanvasNodeType.Audio || node.metadata?.manualSize || node.metadata?.locked || node.metadata?.freeResize;
    const width = media.naturalWidth;
    const height = media.naturalHeight;
    if (keepSize || !width || !height) return { width: node.width, height: node.height };
    // 保持节点最长边不变，按新版本比例换算，避免横竖图切换后节点突然变得过长。
    const longest = Math.max(node.width, node.height);
    return width >= height ? { width: longest, height: Math.round((longest * height) / width) } : { width: Math.round((longest * width) / height), height: longest };
}

/** 切换到指定版本：只替换媒体与来源信息，提示词和下一次生成参数保持不变。 */
export function adoptMediaVersion(node: CanvasNodeData, versionId: string): CanvasNodeData | null {
    const version = node.metadata?.mediaVersions?.find((item) => item.id === versionId);
    if (!version || !hasMedia(version.media)) return null;
    // 旧任务绑定会让任务同步把节点重新标成失败或生成中，切换后解除绑定。
    const metadata: CanvasNodeMetadata = resetGenerationTaskMetadata(ensureCurrentMediaVersion(node).metadata, "success");
    for (const key of MEDIA_KEYS) Object.assign(metadata, { [key]: version.media[key] });
    metadata.producedModel = version.generation?.producedModel;
    metadata.taskDurationMs = version.generation?.taskDurationMs;
    metadata.currentMediaVersionId = version.id;
    return { ...node, ...adoptedGeometry(node, version.media), metadata };
}

/** 删除非当前版本；当前版本不能删除。 */
export function removeMediaVersion(node: CanvasNodeData, versionId: string): CanvasNodeData | null {
    const versions = node.metadata?.mediaVersions || [];
    if (!versions.some((version) => version.id === versionId) || currentMediaVersion(node)?.id === versionId) return null;
    return { ...node, metadata: { ...node.metadata, mediaVersions: versions.filter((version) => version.id !== versionId) } };
}

/** 版本预览用的临时节点：复用现有媒体组件，不写回画布。 */
export function mediaVersionPreviewNode(node: CanvasNodeData, version: CanvasMediaVersion): CanvasNodeData {
    const metadata: CanvasNodeMetadata = { ...node.metadata };
    for (const key of MEDIA_KEYS) Object.assign(metadata, { [key]: version.media[key] });
    return { ...node, id: `${node.id}:version:${version.id}`, metadata };
}

/** 把某个版本取出为独立节点，放在原节点右侧，不携带版本历史和任务绑定。 */
export function createNodeFromMediaVersion(node: CanvasNodeData, versionId: string, id = nanoid()): CanvasNodeData | null {
    const version = node.metadata?.mediaVersions?.find((item) => item.id === versionId);
    if (!version || !hasMedia(version.media)) return null;
    const metadata: CanvasNodeMetadata = resetGenerationTaskMetadata(node.metadata, "success");
    for (const key of MEDIA_KEYS) Object.assign(metadata, { [key]: version.media[key] });
    delete metadata.mediaVersions;
    delete metadata.currentMediaVersionId;
    delete metadata.versionOfNodeId;
    delete metadata.versionLabel;
    delete metadata.versionPrimary;
    delete metadata.locked;
    // 版本历史资源可能被多个节点引用，取出的节点需要重新登记自己的项目资产。
    delete metadata.assetId;
    metadata.prompt = version.generation?.prompt ?? metadata.prompt;
    metadata.composerContent = version.generation?.prompt ?? metadata.composerContent;
    metadata.producedModel = version.generation?.producedModel;
    metadata.taskDurationMs = version.generation?.taskDurationMs;
    metadata.copiedFromNodeId = node.id;
    metadata.generationResultPlacement = "replace-node";
    const geometry = adoptedGeometry({ ...node, metadata: { ...node.metadata, manualSize: false, locked: false, freeResize: false } }, version.media);
    return {
        ...node,
        id,
        parentId: undefined,
        title: `${node.title.replace(/ · V\d+$/, "")} · V${version.number}`,
        position: { x: node.position.x + node.width + 48, y: node.position.y },
        ...geometry,
        metadata,
    };
}
