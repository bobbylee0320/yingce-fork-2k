import { Button, Input, Modal } from "antd";
import { Check, Library, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { AssetThumbnail, STORYBOARD_ASSET_ROLE_LABELS } from "@/components/canvas/storyboard-assets-cell";
import { Select } from "@/components/ui/base/select";
import { bindingForConnectedNode, isStoryboardPreviewAsset } from "@/lib/canvas/canvas-storyboard-materializer";
import { normalizeStoryboardAssetBindings } from "@/lib/canvas/canvas-storyboard-assets";
import type { ProjectDetail } from "@/services/api/projects";
import type { CanvasNodeData, StoryboardAssetBinding } from "@/types/canvas";

export function StoryboardAssetPickerModal({
    nodes,
    bindings,
    shotNumber,
    detail,
    onClose,
    onSave,
    onImport,
}: {
    nodes: CanvasNodeData[];
    bindings: StoryboardAssetBinding[];
    shotNumber: number;
    detail?: ProjectDetail;
    onClose: () => void;
    onSave: (bindings: StoryboardAssetBinding[]) => void;
    onImport: (payloads: InsertAssetPayload[]) => Promise<CanvasNodeData[]>;
}) {
    const [draft, setDraft] = useState(() => normalizeStoryboardAssetBindings(bindings));
    const [query, setQuery] = useState("");
    const [role, setRole] = useState("all");
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [error, setError] = useState("");
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const selectedIds = new Set(draft.map((binding) => binding.nodeId));
    const candidates = nodes.filter((node) => {
        if (!isStoryboardPreviewAsset(node)) return false;
        if (selectedIds.has(node.id)) return true;
        if (["shot", "action_board", "final"].includes(node.metadata?.workflowKind || "")) return false;
        return Boolean(node.metadata?.content || node.metadata?.storageKey || node.metadata?.drawingPreviewUrl || (node.metadata?.characterAssetId && node.metadata?.characterVersionId));
    });
    const keyword = query.trim().toLowerCase();
    const filtered = candidates.filter((node) => (role === "all" || bindingForConnectedNode(node)?.role === role) && (!keyword || [node.title, node.metadata?.prompt, ...(node.metadata?.assetTags || [])].join(" ").toLowerCase().includes(keyword)));
    const toggle = (node: CanvasNodeData) =>
        setDraft((current) => {
            if (current.some((binding) => binding.nodeId === node.id)) return current.filter((binding) => binding.nodeId !== node.id);
            const binding = bindingForConnectedNode(node);
            return binding ? [...current, binding] : current;
        });
    return (
        <>
            <Modal open title={`镜头 ${shotNumber} · 关联资产`} width={760} centered onCancel={onClose} footer={null}>
                <div data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                    <p className="mb-4 text-sm text-foreground/55">选择当前镜头使用的角色、场景、道具或参考媒体。尚未引入的资产可从项目资产中选择。</p>
                    <div className="mb-4 flex flex-wrap gap-2">
                        <Input className="min-w-40 flex-1" prefix={<Search className="size-4 text-foreground/40" />} allowClear placeholder="搜索资产名称或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
                        <Select className="w-32" aria-label="筛选资产类型" value={role} onChange={setRole} options={[{ value: "all", label: "全部类型" }, ...Object.entries(STORYBOARD_ASSET_ROLE_LABELS).map(([value, label]) => ({ value, label }))]} />
                        <Button icon={<Library className="size-4" />} onClick={() => setLibraryOpen(true)}>
                            引用项目资产
                        </Button>
                    </div>
                    <div className="grid max-h-[38vh] min-h-40 auto-rows-max grid-cols-2 content-start gap-2 overflow-y-auto p-1 sm:grid-cols-3" aria-label="可选资产">
                        {filtered.map((node) => (
                            <button
                                key={node.id}
                                type="button"
                                aria-pressed={selectedIds.has(node.id)}
                                aria-label={`选择资产：${node.title}`}
                                onClick={() => toggle(node)}
                                className={`relative flex items-center gap-2 rounded-lg border p-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${selectedIds.has(node.id) ? "border-foreground/50 bg-foreground/[0.08]" : "border-foreground/10 hover:bg-foreground/[0.04]"}`}
                            >
                                <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-foreground/[0.04]">
                                    <AssetThumbnail node={node} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm" title={node.title}>
                                        {node.title}
                                    </span>
                                    <span className="text-xs text-foreground/45">{STORYBOARD_ASSET_ROLE_LABELS[bindingForConnectedNode(node)!.role]}</span>
                                </span>
                                {selectedIds.has(node.id) ? <Check className="size-4 shrink-0" /> : null}
                            </button>
                        ))}
                        {!filtered.length ? (
                            <div className="col-span-full grid place-items-center px-4 py-8 text-center text-sm text-foreground/45">{keyword || role !== "all" ? "没有匹配的资产，试试其他搜索条件" : "当前画布还没有可选资产，点击“引用项目资产”添加"}</div>
                        ) : null}
                    </div>
                    <div className="mt-4 border-t border-foreground/10 pt-3">
                        <div className="mb-2 flex items-center justify-between text-xs text-foreground/55">
                            <span>已选 {draft.length} 项</span>
                            <Button type="text" size="small" disabled={!draft.length} onClick={() => setDraft([])}>
                                清空选择
                            </Button>
                        </div>
                        <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto" aria-label="已选资产">
                            {draft.map((binding) => (
                                <span key={binding.nodeId} className="inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/[0.06] px-2 py-1 text-xs">
                                    <span className="max-w-40 truncate">{nodeById.get(binding.nodeId)?.title || "资产已失效"}</span>
                                    <Select
                                        size="small"
                                        className="w-20"
                                        aria-label={`${nodeById.get(binding.nodeId)?.title || "失效资产"}的用途`}
                                        value={binding.role}
                                        options={Object.entries(STORYBOARD_ASSET_ROLE_LABELS).map(([value, label]) => ({ value, label }))}
                                        onChange={(value) => setDraft((current) => current.map((item) => (item.nodeId === binding.nodeId ? { ...item, role: value as StoryboardAssetBinding["role"] } : item)))}
                                    />
                                    <button
                                        type="button"
                                        aria-label={`移除资产：${nodeById.get(binding.nodeId)?.title || "失效资产"}`}
                                        className="rounded p-1 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                                        onClick={() => setDraft((current) => current.filter((item) => item.nodeId !== binding.nodeId))}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    </div>
                    {error ? (
                        <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
                            {error}
                        </p>
                    ) : null}
                    <div className="mt-4 flex justify-end gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button
                            type="primary"
                            onClick={() => {
                                try {
                                    onSave(draft);
                                } catch (cause) {
                                    setError(cause instanceof Error ? cause.message : "关联资产保存失败");
                                }
                            }}
                        >
                            保存关联
                        </Button>
                    </div>
                </div>
            </Modal>
            {libraryOpen ? (
                <CanvasProjectAssetModal
                    open
                    detail={detail}
                    onClose={() => setLibraryOpen(false)}
                    onInsert={async (payloads) => {
                        if (payloads.some((payload) => payload.kind === "text")) throw new Error("镜头关联请选择角色、图片、视频或音频；文本请连接到分镜设定入口");
                        const imported = await onImport(payloads);
                        const additions = imported.flatMap((node) => {
                            const binding = bindingForConnectedNode(node);
                            return binding ? [binding] : [];
                        });
                        setDraft((current) => normalizeStoryboardAssetBindings([...current, ...additions]));
                    }}
                />
            ) : null}
        </>
    );
}
