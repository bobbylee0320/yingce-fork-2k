import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { buildCanvasSpatialIndex, type CanvasSpatialIndexEntry } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasIndexedConnection = { connection: CanvasConnection; fromId: string; toId: string };

/** Store endpoint IDs so text/task updates can use live nodes without rebuilding geometry. */
export function buildCanvasConnectionIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const entries: CanvasSpatialIndexEntry<CanvasIndexedConnection>[] = [];
    const connectionIdsByNodeId = new Map<string, Set<string>>();
    const collapsedBatchChild = (node: CanvasNodeData) => {
        const root = node.metadata?.batchRootId ? nodeById.get(node.metadata.batchRootId) : undefined;
        return root && !root.metadata?.imageBatchExpanded;
    };
    const endpoint = (node: CanvasNodeData) => {
        const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
        return parent && isFrameNode(parent) && parent.metadata?.frame?.collapsed ? parent : node;
    };
    for (const connection of connections) {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target || collapsedBatchChild(source) || collapsedBatchChild(target)) continue;
        const from = endpoint(source),
            to = endpoint(target);
        if (from.id === to.id) continue;
        const value = { connection, fromId: from.id, toId: to.id };
        entries.push({
            id: connection.id,
            bounds: {
                left: Math.min(from.position.x, to.position.x),
                top: Math.min(from.position.y, to.position.y),
                right: Math.max(from.position.x + from.width, to.position.x + to.width),
                bottom: Math.max(from.position.y + from.height, to.position.y + to.height),
            },
            value,
        });
        for (const nodeId of new Set([source.id, target.id, from.id, to.id])) {
            const ids = connectionIdsByNodeId.get(nodeId) || new Set<string>();
            ids.add(connection.id);
            connectionIdsByNodeId.set(nodeId, ids);
        }
    }
    return { index: buildCanvasSpatialIndex(entries), connectionIdsByNodeId, entriesById: new Map(entries.map((entry) => [entry.id, entry.value])) };
}
