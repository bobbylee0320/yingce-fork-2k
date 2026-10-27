import { useEffect, useMemo, useState } from "react";

import { canvasNodeBounds, type CanvasSpatialBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData } from "@/types/canvas";

const MOUNT_BATCH_SIZE = 12;
const MOUNT_FRAME_BUDGET_MS = 4;

/**
 * 屏内节点立即挂载；屏外缓冲节点按离视口距离分帧补齐。
 * 状态只存在于世界层，补齐进度不会重渲染画布页面和它的派生数据。
 */
export function useCanvasProgressiveNodeMount(candidateNodes: CanvasNodeData[], immediateNodeIds: ReadonlySet<string>, view: CanvasSpatialBounds) {
    const [mountedNodeIds, setMountedNodeIds] = useState<Set<string>>(() => new Set());
    useEffect(() => {
        const candidateIds = new Set(candidateNodes.map((node) => node.id));
        setMountedNodeIds((current) => {
            const next = new Set<string>();
            current.forEach((id) => {
                if (candidateIds.has(id)) next.add(id);
            });
            immediateNodeIds.forEach((id) => next.add(id));
            return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
        });
        const queue = candidateNodes
            .filter((node) => !immediateNodeIds.has(node.id))
            .map((node) => ({ id: node.id, distance: distanceToBounds(canvasNodeBounds(node), view) }))
            .sort((left, right) => left.distance - right.distance);
        let cursor = 0;
        let frameId = 0;
        const schedule = () => {
            frameId = requestAnimationFrame(() => {
                const startedAt = performance.now();
                const additions: string[] = [];
                while (cursor < queue.length && additions.length < MOUNT_BATCH_SIZE && performance.now() - startedAt < MOUNT_FRAME_BUDGET_MS) additions.push(queue[cursor++].id);
                if (additions.length) {
                    setMountedNodeIds((current) => {
                        if (additions.every((id) => current.has(id))) return current;
                        const next = new Set(current);
                        additions.forEach((id) => next.add(id));
                        return next;
                    });
                }
                if (cursor < queue.length) schedule();
            });
        };
        if (queue.length && typeof window !== "undefined") schedule();
        return () => cancelAnimationFrame(frameId);
    }, [candidateNodes, immediateNodeIds, view]);
    return useMemo(() => candidateNodes.filter((node) => immediateNodeIds.has(node.id) || mountedNodeIds.has(node.id)), [candidateNodes, immediateNodeIds, mountedNodeIds]);
}

function distanceToBounds(node: CanvasSpatialBounds, bounds: CanvasSpatialBounds) {
    const dx = node.right < bounds.left ? bounds.left - node.right : node.left > bounds.right ? node.left - bounds.right : 0;
    const dy = node.bottom < bounds.top ? bounds.top - node.bottom : node.top > bounds.bottom ? node.top - bounds.bottom : 0;
    return Math.hypot(dx, dy);
}
