import type { CanvasNodeData } from "@/types/canvas";

/** Only for geometry/topology consumers; never use this snapshot as node content. */
export function retainCanvasLayoutNodes(previous: CanvasNodeData[], nodes: CanvasNodeData[]) {
    return previous === nodes || (previous.length === nodes.length && nodes.every((node, index) => sameLayout(node, previous[index]))) ? previous : nodes;
}

function sameLayout(a: CanvasNodeData, b: CanvasNodeData) {
    return (
        a === b ||
        (a.id === b.id &&
            a.type === b.type &&
            a.parentId === b.parentId &&
            a.position.x === b.position.x &&
            a.position.y === b.position.y &&
            a.width === b.width &&
            a.height === b.height &&
            a.metadata?.batchRootId === b.metadata?.batchRootId &&
            a.metadata?.imageBatchExpanded === b.metadata?.imageBatchExpanded &&
            a.metadata?.frame?.collapsed === b.metadata?.frame?.collapsed)
    );
}
