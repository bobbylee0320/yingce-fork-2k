import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

const EMPTY_REFERENCES: CanvasResourceReference[] = [];

export function sameCanvasResourceReference(left: CanvasResourceReference, right: CanvasResourceReference) {
    if (left === right) return true;
    const leftKeys = Object.keys(left) as (keyof CanvasResourceReference)[];
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * 引用列表每次都会按画布重新生成；内容不变时沿用上一轮数组，
 * 节点 memo 才能只靠引用比较跳过渲染。
 */
export function reuseCanvasReferenceList(previous: CanvasResourceReference[] | undefined, next: CanvasResourceReference[]) {
    if (!next.length) return EMPTY_REFERENCES;
    if (previous && previous.length === next.length && next.every((reference, index) => sameCanvasResourceReference(previous[index], reference))) return previous;
    return next;
}

export function reuseCanvasReferenceListMap(previous: ReadonlyMap<string, CanvasResourceReference[]>, next: Map<string, CanvasResourceReference[]>) {
    next.forEach((references, nodeId) => next.set(nodeId, reuseCanvasReferenceList(previous.get(nodeId), references)));
    return next;
}

export function reuseCanvasReferenceMap(previous: ReadonlyMap<string, CanvasResourceReference>, next: Map<string, CanvasResourceReference>) {
    next.forEach((reference, nodeId) => {
        const current = previous.get(nodeId);
        if (current && sameCanvasResourceReference(current, reference)) next.set(nodeId, current);
    });
    return next;
}
