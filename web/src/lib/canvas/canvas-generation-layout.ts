import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

type Size = {
    width: number;
    height: number;
};

const BATCH_CHILD_OFFSET_X = 120;
const BATCH_CHILD_GAP = 36;
const NODE_CLEARANCE = 36;

export function canGenerateImageInPlace(sourceNode: CanvasNodeData | undefined, outputCount = 1) {
    return canGenerateMediaInPlace(sourceNode, CanvasNodeType.Image, outputCount);
}

export function canGenerateMediaInPlace(sourceNode: CanvasNodeData | undefined, mediaType: typeof CanvasNodeType.Image | typeof CanvasNodeType.Video | typeof CanvasNodeType.Audio, outputCount = 1) {
    if (sourceNode?.type !== mediaType) return false;
    if (sourceNode.metadata?.generationResultPlacement) return sourceNode.metadata.generationResultPlacement === "replace-node";
    if (!sourceNode.metadata?.content && !sourceNode.metadata?.storageKey) return true;
    // 兼容显式落点字段引入前创建的复制节点和版本节点。
    if (sourceNode.metadata?.copiedFromNodeId || sourceNode.metadata?.versionOfNodeId) return true;
    // 单张重新生成已有生成结果时原位产出新版本，旧结果进入节点版本历史；多张输出仍新建结果组。
    return outputCount <= 1 && isGeneratedMediaResult(sourceNode);
}

function isGeneratedMediaResult(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (metadata?.fileUpload || metadata?.isBatchRoot || metadata?.batchRootId || metadata?.imageLayerGroup || metadata?.imageLayer) return false;
    return Boolean(metadata?.taskId || metadata?.generationType || metadata?.producedModel || metadata?.mediaVersions?.some((version) => version.source === "generate"));
}

export function imageGenerationGroupSize(rootSize: Size, imageSize: Size, childCount: number): Size {
    if (childCount <= 0) return rootSize;
    const columns = Math.min(childCount, 2);
    const rows = Math.ceil(childCount / 2);
    return {
        width: rootSize.width + BATCH_CHILD_OFFSET_X + columns * imageSize.width + (columns - 1) * BATCH_CHILD_GAP,
        height: Math.max(rootSize.height, rows * imageSize.height + (rows - 1) * BATCH_CHILD_GAP),
    };
}

export function imageGenerationChildPosition(rootPosition: Position, rootWidth: number, imageSize: Size, index: number): Position {
    return {
        x: rootPosition.x + rootWidth + BATCH_CHILD_OFFSET_X + (index % 2) * (imageSize.width + BATCH_CHILD_GAP),
        y: rootPosition.y + Math.floor(index / 2) * (imageSize.height + BATCH_CHILD_GAP),
    };
}

export function findAvailableGenerationGroupPosition(nodes: CanvasNodeData[], preferred: Position, groupSize: Size): Position {
    const down = resolveCollisions(nodes, preferred, groupSize, "down");
    const right = resolveCollisions(nodes, preferred, groupSize, "right");
    const downDistance = down.y - preferred.y;
    const rightDistance = right.x - preferred.x;
    return downDistance <= rightDistance ? down : right;
}

// 分别沿下方和右侧求出最近空位，再选择移动距离更短的方向，避免生成组覆盖已有节点。
function resolveCollisions(nodes: CanvasNodeData[], preferred: Position, groupSize: Size, direction: "down" | "right"): Position {
    const candidate = { ...preferred };
    for (let attempt = 0; attempt <= nodes.length; attempt += 1) {
        const collisions = nodes.filter((node) => rectanglesOverlap(candidate, groupSize, node.position, node));
        if (!collisions.length) return candidate;
        if (direction === "down") candidate.y = Math.max(...collisions.map((node) => node.position.y + node.height + NODE_CLEARANCE));
        else candidate.x = Math.max(...collisions.map((node) => node.position.x + node.width + NODE_CLEARANCE));
    }
    return candidate;
}

function rectanglesOverlap(firstPosition: Position, firstSize: Size, secondPosition: Position, secondSize: Size) {
    return !(
        firstPosition.x + firstSize.width + NODE_CLEARANCE <= secondPosition.x ||
        firstPosition.x >= secondPosition.x + secondSize.width + NODE_CLEARANCE ||
        firstPosition.y + firstSize.height + NODE_CLEARANCE <= secondPosition.y ||
        firstPosition.y >= secondPosition.y + secondSize.height + NODE_CLEARANCE
    );
}
