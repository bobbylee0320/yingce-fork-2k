import { useLayoutEffect, useRef, type RefObject } from "react";
import { activeConnectionPath, CanvasConnectionBeam } from "./canvas-connections";
import { CANVAS_CONNECTION_STROKE_WIDTH, type CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import type { BatchScroll } from "@/lib/canvas/canvas-batch-references";
import { subscribeCanvasGraphicsViewportPreview } from "@/lib/canvas/canvas-live-viewport";
import type { CanvasNodeData, ConnectionHandle, Position, ViewportTransform } from "@/types/canvas";

type CanvasConnectionDraftsProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    connectingParams: ConnectionHandle | null;
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    mouseWorld: Position;
    nodeById: Map<string, CanvasNodeData>;
    scriptScrollTopById: Record<string, number>;
    batchScrollById?: Record<string, BatchScroll>;
};

export function CanvasConnectionDrafts(props: CanvasConnectionDraftsProps) {
    const worldRef = useRef<HTMLDivElement>(null);
    const batch = props.batchConnectionPreview;
    const handles: ConnectionHandle[] = batch ? batch.sourceNodeIds.map((nodeId) => ({ nodeId, handleType: "source" })) : props.connectingParams ? [props.connectingParams] : [];
    const active = handles.length > 0;
    useLayoutEffect(() => {
        const world = worldRef.current;
        const container = props.containerRef.current || world?.parentElement?.parentElement;
        if (!world || !container) return;
        const sync = (viewport: ViewportTransform) => {
            const scale = Number(container.style.getPropertyValue("--canvas-committed-scale")) || props.viewport.k;
            world.style.transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k / scale})`;
        };
        sync(props.viewport);
        return subscribeCanvasGraphicsViewportPreview(container as HTMLDivElement, sync);
    }, [active, props.containerRef, props.viewport]);
    if (!active) return null;
    const stroke = batch?.status === "invalid" ? props.theme.accent.danger : batch?.status === "partial" ? props.theme.node.activeStroke : props.theme.connection.stroke;
    // 与节点世界层分开，整条草稿（底线和流光）都覆盖卡片；复用实时视口变换。
    return (
        <div data-canvas-connection-drafts aria-hidden className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden">
            <div ref={worldRef} className="canvas-world-layer absolute origin-top-left">
                <div className="canvas-world-raster-layer absolute origin-top-left">
                    <svg width={1} height={1} className="absolute overflow-visible">
                        {handles.map((handle) => {
                            const pathD = activeConnectionPath(props.nodeById.get(handle.nodeId), handle, batch?.mouseWorld || props.mouseWorld, props.scriptScrollTopById[handle.nodeId] || 0, props.batchScrollById?.[handle.nodeId]);
                            return pathD ? (
                                <g key={handle.nodeId}>
                                    <path d={pathD} fill="none" stroke={stroke} strokeWidth={CANVAS_CONNECTION_STROKE_WIDTH} strokeOpacity={0.72} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                                    <CanvasConnectionBeam pathD={pathD} color={props.theme.connection.beam} />
                                </g>
                            ) : null;
                        })}
                    </svg>
                </div>
            </div>
        </div>
    );
}
