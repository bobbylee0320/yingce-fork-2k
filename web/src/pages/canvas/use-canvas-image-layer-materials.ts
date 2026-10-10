import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { findAvailableGenerationGroupPosition, imageGenerationChildPosition, imageGenerationGroupSize } from "@/lib/canvas/canvas-generation-layout";
import { fitImageMaterialNodeSize } from "@/lib/canvas/canvas-node-size";
import { cropImageLayerMaterial } from "@/services/canvas-image-layer-source";
import { uploadImage } from "@/services/image-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";

export function useCanvasImageLayerMaterials({
    projectId,
    domainProjectId,
    enabled,
    nodes,
    nodesRef,
    setNodes,
    setConnections,
}: {
    projectId: string;
    domainProjectId?: string;
    enabled: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
}) {
    const jobs = useRef(new Set<string>());
    const epoch = useRef(0);
    useEffect(() => {
        epoch.current++;
        jobs.current.clear();
        return () => {
            epoch.current++;
        };
    }, [projectId]);
    const extractLayerMaterials = useCallback(
        async (root: CanvasNodeData) => {
            if (!enabled || jobs.current.has(root.id)) return;
            const group = root.metadata?.imageLayerGroup;
            if (!group) return;
            const children = group.layers
                .map((layer) => nodesRef.current.find((node) => node.id === layer.nodeId))
                .filter((node): node is CanvasNodeData => Boolean(node?.metadata?.content && node.metadata.status === "success" && node.metadata.imageLayer?.kind !== "base"));
            if (!children.length) {
                setNodes((current) =>
                    current.map((node) => (node.id === root.id ? { ...node, metadata: { ...node.metadata, imageLayerMaterials: { ...node.metadata?.imageLayerMaterials, status: "error", error: "没有已验收的前景图层可制作独立素材" } } } : node)),
                );
                return;
            }
            const scope = epoch.current;
            jobs.current.add(root.id);
            setNodes((current) => current.map((node) => (node.id === root.id ? { ...node, metadata: { ...node.metadata, imageLayerMaterials: { ...node.metadata?.imageLayerMaterials, status: "loading", error: undefined } } } : node)));
            const active = () => scope === epoch.current && nodesRef.current.some((node) => node.id === root.id);
            try {
                const materials: CanvasNodeData[] = [];
                const groupId = nanoid();
                const errors: string[] = [];
                // 每次只解码一个完整图层，限制浏览器内存占用，不调用模型。
                for (const child of children) {
                    if (!active()) return;
                    try {
                        const cropped = await cropImageLayerMaterial({ dataUrl: child.metadata!.content!, storageKey: child.metadata?.storageKey });
                        const image = await uploadImage(cropped.dataUrl);
                        if (image.pendingRemoteUpload) throw new Error("素材尚未保存到服务端");
                        if (!active()) return;
                        const size = fitImageMaterialNodeSize(image.width, image.height);
                        const material: CanvasNodeData = {
                            id: nanoid(),
                            type: CanvasNodeType.Image,
                            title: `${child.title || "图层"} · 独立素材`,
                            position: { x: 0, y: 0 },
                            ...size,
                            metadata: { ...imageMetadata(image), batchRootId: groupId, imageLayerMaterial: { sourceLayerId: child.id, sourceGroupId: root.id, bounds: cropped.bounds } },
                        };
                        try {
                            const asset = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, node: material, source: "canvas-manual" });
                            material.metadata!.assetId = asset.assetId;
                        } catch (error) {
                            errors.push(`素材库写入失败：${error instanceof Error ? error.message : "未知错误"}`);
                        }
                        materials.push(material);
                    } catch (error) {
                        errors.push(`${child.title || "图层"}：${error instanceof Error ? error.message : "提取失败"}`);
                    }
                }
                if (!active()) return;
                if (!materials.length) throw new Error(errors.join("；") || "没有可用的独立素材");
                // 编辑或删除后的旧异步结果不能作为当前图层的素材显示。
                const live = nodesRef.current.find((node) => node.id === root.id);
                if (
                    children.some((child) => !nodesRef.current.some((node) => node.id === child.id && node.metadata?.content === child.metadata?.content && node.metadata?.storageKey === child.metadata?.storageKey)) ||
                    live?.metadata?.imageLayerGroup?.layers.map((layer) => layer.nodeId).join() !== group.layers.map((layer) => layer.nodeId).join()
                )
                    throw new Error("图层已变化，请重新提取独立素材");
                const cell = { width: Math.max(...materials.map((node) => node.width)), height: Math.max(...materials.map((node) => node.height)) };
                const position = findAvailableGenerationGroupPosition(nodesRef.current, { x: root.position.x + root.width + 96, y: root.position.y }, imageGenerationGroupSize(cell, cell, materials.length));
                materials.forEach((node, index) => {
                    node.position = imageGenerationChildPosition(position, cell.width, cell, index);
                });
                const materialRoot: CanvasNodeData = {
                    id: groupId,
                    type: CanvasNodeType.Image,
                    title: `独立素材 · ${materials.length} 张`,
                    position,
                    width: materials[0].width,
                    height: materials[0].height,
                    metadata: {
                        ...imageMetadata({
                            url: materials[0].metadata!.content!,
                            storageKey: materials[0].metadata!.storageKey!,
                            width: materials[0].metadata!.naturalWidth!,
                            height: materials[0].metadata!.naturalHeight!,
                            bytes: materials[0].metadata!.bytes!,
                            mimeType: "image/png",
                        }),
                        isBatchRoot: true,
                        imageBatchExpanded: false,
                        batchChildIds: materials.map((node) => node.id),
                        primaryImageId: materials[0].id,
                    },
                };
                setNodes((current) => [
                    ...current.map((node): CanvasNodeData =>
                        node.id === root.id ? { ...node, metadata: { ...node.metadata, imageLayerMaterials: { ...node.metadata?.imageLayerMaterials, status: "ready", groupId, ...(errors.length ? { error: errors.join("；") } : {}) } } } : node,
                    ),
                    materialRoot,
                    ...materials,
                ]);
                setConnections((current) => [...current, { id: nanoid(), fromNodeId: root.id, toNodeId: groupId }, ...materials.map((node) => ({ id: nanoid(), fromNodeId: groupId, toNodeId: node.id }))]);
            } catch (error) {
                if (active())
                    setNodes((current) =>
                        current.map((node) =>
                            node.id === root.id ? { ...node, metadata: { ...node.metadata, imageLayerMaterials: { ...node.metadata?.imageLayerMaterials, status: "error", error: error instanceof Error ? error.message : "独立素材提取失败" } } } : node,
                        ),
                    );
            } finally {
                if (scope === epoch.current) jobs.current.delete(root.id);
            }
        },
        [domainProjectId, enabled, nodesRef, projectId, setConnections, setNodes],
    );
    useEffect(() => {
        if (!enabled) return;
        for (const node of nodes)
            if (node.metadata?.imageLayerMaterials?.auto && !node.metadata.imageLayerMaterials.status && node.metadata.imageLayerGroup?.compositeStatus === "ready" && node.metadata.status !== "loading") void extractLayerMaterials(node);
    }, [enabled, extractLayerMaterials, nodes]);
    return extractLayerMaterials;
}
