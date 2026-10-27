import { canonicalize } from "json-canonicalize";

import { getCanvasNodesBounds, type CanvasBounds, type CanvasViewportSize } from "@/lib/canvas/canvas-viewport";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, Position, ViewportTransform } from "@/types/canvas";

/** Agent 刚刚创建或操作过的节点，画布据此把镜头移过去。 */
export type AgentCanvasFocus = {
    nodes: CanvasNodeData[];
    /** 新建节点会被选中并完整框入；仅更新的节点只在离开视野时才移动镜头。 */
    created: boolean;
};

// 任务进度、阶段和计时每隔几秒都会刷新；把这些当成"操作"会让镜头追着进度条来回跳。
const volatileMetadataKeys: (keyof CanvasNodeMetadata)[] = ["taskProgress", "taskStage", "taskMediaStage", "taskUpdatedAt", "taskStartedAt", "taskDurationMs", "taskOfficialStatus", "taskReceiptRecorded", "taskProvider", "taskCanRecoverMedia"];

function focusSignature(node: CanvasNodeData) {
    const { updatedAt: _updatedAt, createdAt: _createdAt, metadata, ...rest } = node;
    if (!metadata) return canonicalize(rest);
    const stable = { ...metadata };
    for (const key of volatileMetadataKeys) delete stable[key];
    return canonicalize({ ...rest, metadata: stable });
}

function connectionKey(connection: CanvasConnection) {
    return connection.id || `${connection.fromNodeId}->${connection.toNodeId}`;
}

/**
 * 从 Agent 写入前后的画布里找出值得聚焦的节点：新建节点、实质内容/位置变化的节点、
 * 新连线两端的节点。删除的节点和只刷新进度的节点不算。
 */
export function agentCanvasFocusTargets(previous: { nodes: CanvasNodeData[]; connections?: CanvasConnection[] } | undefined, next: { nodes: CanvasNodeData[]; connections?: CanvasConnection[] }): AgentCanvasFocus | null {
    if (!previous) return null;
    const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
    const nextById = new Map(next.nodes.map((node) => [node.id, node]));
    const created: CanvasNodeData[] = [];
    const changed = new Map<string, CanvasNodeData>();
    for (const node of next.nodes) {
        const before = previousById.get(node.id);
        if (!before) {
            created.push(node);
            continue;
        }
        if (before !== node && focusSignature(before) !== focusSignature(node)) changed.set(node.id, node);
    }
    if (created.length) return { nodes: created, created: true };
    const previousConnections = new Set((previous.connections || []).map(connectionKey));
    for (const connection of next.connections || []) {
        if (previousConnections.has(connectionKey(connection))) continue;
        for (const id of [connection.fromNodeId, connection.toNodeId]) {
            const node = nextById.get(id);
            if (node) changed.set(id, node);
        }
    }
    return changed.size ? { nodes: [...changed.values()], created: false } : null;
}

/** 节点是否已完整落在可见区域（留出边距）内；已可见就不打扰用户。 */
export function canvasNodesVisibleInArea(nodes: CanvasNodeData[], viewport: ViewportTransform, area: CanvasBounds, margin = 24) {
    const bounds = getCanvasNodesBounds(nodes);
    if (!bounds) return true;
    const left = bounds.left * viewport.k + viewport.x;
    const top = bounds.top * viewport.k + viewport.y;
    const right = bounds.right * viewport.k + viewport.x;
    const bottom = bounds.bottom * viewport.k + viewport.y;
    return left >= area.left + margin && top >= area.top + margin && right <= area.right - margin && bottom <= area.bottom - margin;
}

/** 镜头飞行时长：短距离利落，跨越大半屏或明显缩放时更从容。 */
export function agentFocusDuration(from: ViewportTransform, to: ViewportTransform, size: CanvasViewportSize) {
    const diagonal = Math.max(1, Math.hypot(size.width, size.height));
    const travel = Math.hypot(to.x - from.x, to.y - from.y) / diagonal;
    const zoom = Math.abs(Math.log(Math.max(0.01, to.k) / Math.max(0.01, from.k)));
    return Math.round(Math.min(900, 420 + Math.min(1, travel) * 360 + Math.min(1, zoom) * 240));
}

function easeInOutCubic(progress: number) {
    return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/**
 * 以可见区域中心为锚点插值"镜头看向的世界坐标"，缩放按对数插值，并在长距离飞行时
 * 轻微拉远再推近。这样移动过程中画面不会斜着滑，也不会先猛缩再猛放。
 */
export function interpolateCameraViewport(from: ViewportTransform, to: ViewportTransform, progress: number, anchor: Position, size: CanvasViewportSize): ViewportTransform {
    const t = easeInOutCubic(Math.min(1, Math.max(0, progress)));
    if (t >= 1) return to;
    const fromCenter = { x: (anchor.x - from.x) / from.k, y: (anchor.y - from.y) / from.k };
    const toCenter = { x: (anchor.x - to.x) / to.k, y: (anchor.y - to.y) / to.k };
    const center = { x: fromCenter.x + (toCenter.x - fromCenter.x) * t, y: fromCenter.y + (toCenter.y - fromCenter.y) * t };
    const travel = Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, Math.hypot(size.width, size.height));
    const dip = Math.min(0.14, Math.max(0, travel - 0.35) * 0.2);
    const k = from.k * Math.pow(to.k / from.k, t) * (1 - dip * Math.sin(Math.PI * t));
    return { x: anchor.x - center.x * k, y: anchor.y - center.y * k, k };
}
