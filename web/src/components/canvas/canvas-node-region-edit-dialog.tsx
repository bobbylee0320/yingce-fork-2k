import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Button } from "antd";
import { ArrowUp, Redo2, RotateCcw, SquareDashed, Undo2, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import { Tooltip } from "@/components/ui/base/tooltip";
import { ModelPicker } from "@/components/model-picker";
import { defaultImageParamsForModel } from "@/lib/model-selection";
import { loadRasterImage } from "@/lib/image-raster";
import type { PixelSize } from "@/lib/canvas/image-operation-plan";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import {
    IMAGE_REGION_COLOR,
    exportRegionMask,
    minRegionSide,
    missingRegionReferences,
    moveRegion,
    nextRegionIndex,
    regionFromPoints,
    regionMentionLabel,
    regionMentionToken,
    renderRegionAnnotatedImage,
    renderRegionThumbnail,
    syncRegionPrompt,
    type ImageEditRegion,
    type RegionPoint,
} from "@/lib/canvas/image-region-edit";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import "./canvas-node-region-edit-dialog.css";

export type CanvasImageRegionEditPayload = {
    /** 用户原文，保留 @区域N，由调用方编译为模型提示词。 */
    prompt: string;
    regions: ImageEditRegion[];
    size: PixelSize;
    /** 原图叠加编号框，供支持多参考图的模型定位。 */
    annotatedDataUrl: string;
    /** 透明像素为可编辑区域；仅在模型支持蒙版时提交。 */
    maskDataUrl: string;
    generationConfig?: Partial<Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "transparentBackground">>;
};

type RegionEditorProps = {
    image: { url: string; storageKey?: string };
    open: boolean;
    config: AiConfig;
    onClose: () => void;
    onConfirm: (payload: CanvasImageRegionEditPayload) => void;
};

type DragState = { kind: "create"; pointerId: number; start: RegionPoint } | { kind: "move"; pointerId: number; index: number; origin: RegionPoint; initial: ImageEditRegion } | { kind: "resize"; pointerId: number; index: number; anchor: RegionPoint };

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const MENTION_MENU_LABELS = { connected: "图片区域", search: "搜索区域" };

export function CanvasNodeRegionEditDialog(props: RegionEditorProps) {
    return props.open && props.image.url ? <RegionEditor key={`${props.image.storageKey || ""}:${props.image.url}`} {...props} /> : null;
}

/** 富文本编辑器在有引用时是 contentEditable，否则是 textarea；两种都把光标放到末尾。 */
function focusEditorEnd(container: HTMLElement | null) {
    const editable = container?.querySelector<HTMLElement>('[contenteditable="true"], textarea');
    if (!editable) return;
    editable.focus({ preventScroll: true });
    if (editable instanceof HTMLTextAreaElement) {
        editable.setSelectionRange(editable.value.length, editable.value.length);
    } else {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }
    editable.scrollTop = editable.scrollHeight;
}

function RegionEditor({ image, config, onClose, onConfirm }: RegionEditorProps) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const dragBeforeRef = useRef<ImageEditRegion[] | null>(null);
    const thumbnailCache = useRef(new Map<string, string>());
    const [source, setSource] = useState<{ url: string; element: HTMLImageElement; size: PixelSize } | null>(null);
    const [loadError, setLoadError] = useState("");
    const [regions, setRegions] = useState<ImageEditRegion[]>([]);
    const [past, setPast] = useState<ImageEditRegion[][]>([]);
    const [future, setFuture] = useState<ImageEditRegion[][]>([]);
    const [selected, setSelected] = useState<number | null>(null);
    const [focusRequest, setFocusRequest] = useState(0);
    const [draft, setDraft] = useState<Omit<ImageEditRegion, "index"> | null>(null);
    const [dragging, setDragging] = useState(false);
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState("");
    const [settings, setSettings] = useState(() => {
        const model = config.imageModel || config.model;
        return { ...config, model, imageModel: model };
    });
    const size = source?.size || null;

    useEffect(() => {
        const request = new AbortController();
        void imageToDataUrl({ url: image.url, storageKey: image.storageKey })
            .then((dataUrl) => {
                if (!dataUrl) throw new Error("图片读取失败");
                return loadRasterImage(dataUrl, request.signal).then((element) => ({ url: dataUrl, element }));
            })
            .then(({ url, element }) => {
                if (!request.signal.aborted) setSource({ url, element, size: { width: element.naturalWidth, height: element.naturalHeight } });
            })
            .catch((failure: unknown) => {
                if (!request.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "图片读取失败");
            });
        return () => request.abort();
    }, [image.storageKey, image.url]);

    // 新框画完后光标落到它那一行末尾，连续“画框 → 写要求”。等编辑器渲染出新胶囊后再定位。
    useEffect(() => {
        if (!focusRequest) return;
        const frame = requestAnimationFrame(() => focusEditorEnd(editorRef.current));
        return () => cancelAnimationFrame(frame);
    }, [focusRequest]);

    // 拖拽过程中不重绘缩略图，松手后按最终框位生成并缓存。
    const thumbnails = useMemo(() => {
        const result = new Map<number, string>();
        if (!source) return result;
        for (const region of regions) {
            const key = `${region.x},${region.y},${region.width},${region.height}`;
            let url = thumbnailCache.current.get(key);
            if (!url && !dragging) {
                url = renderRegionThumbnail(source.element, region);
                thumbnailCache.current.set(key, url);
            }
            if (url) result.set(region.index, url);
        }
        return result;
    }, [dragging, regions, source]);

    const orderedRegions = useMemo(() => [...regions].sort((a, b) => a.index - b.index), [regions]);
    // 区域以画布引用的形式交给 @ 编辑器，提示词里显示成带缩略图的胶囊。
    const mentionReferences = useMemo<CanvasResourceReference[]>(
        () =>
            orderedRegions.map((region) => ({
                id: `region-${region.index}`,
                nodeId: "",
                kind: "image",
                label: regionMentionLabel(region.index),
                title: `${regionMentionLabel(region.index)} · ${region.width}×${region.height}`,
                previewUrl: thumbnails.get(region.index),
                mentionToken: regionMentionToken(region.index),
                active: true,
            })),
        [orderedRegions, thumbnails],
    );
    const trimmedPrompt = prompt.trim();
    const canSubmit = Boolean(size && regions.length && trimmedPrompt);

    const applyRegions = (next: ImageEditRegion[], previous: ImageEditRegion[]) => {
        setRegions(next);
        setPrompt((current) => syncRegionPrompt(current, previous, next));
        setError("");
    };
    const commit = (next: ImageEditRegion[], before = regions) => {
        setPast((items) => [...items, before]);
        setFuture([]);
        applyRegions(next, before);
    };
    const undo = () => {
        const previous = past.at(-1);
        if (!previous) return;
        setPast((items) => items.slice(0, -1));
        setFuture((items) => [...items, regions]);
        applyRegions(previous, regions);
        setSelected(null);
    };
    const redo = () => {
        const next = future.at(-1);
        if (!next) return;
        setFuture((items) => items.slice(0, -1));
        setPast((items) => [...items, regions]);
        applyRegions(next, regions);
        setSelected(null);
    };
    const removeRegion = (index: number) => {
        commit(regions.filter((region) => region.index !== index));
        if (selected === index) setSelected(null);
    };

    const pointAt = (clientX: number, clientY: number): RegionPoint => {
        const rect = surfaceRef.current!.getBoundingClientRect();
        return {
            x: ((clientX - rect.left) / Math.max(1, rect.width)) * size!.width,
            y: ((clientY - rect.top) / Math.max(1, rect.height)) * size!.height,
        };
    };
    const beginDrag = (event: PointerEvent<HTMLElement>, state: DragState) => {
        if (event.button !== 0 || dragRef.current || !size) return;
        event.preventDefault();
        event.stopPropagation();
        surfaceRef.current?.setPointerCapture(event.pointerId);
        surfaceRef.current?.focus({ preventScroll: true });
        dragRef.current = state;
        dragBeforeRef.current = regions;
        setDragging(true);
    };
    const onSurfacePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !size) return;
        event.preventDefault();
        const point = pointAt(event.clientX, event.clientY);
        if (drag.kind === "create") {
            setDraft(regionFromPoints(drag.start, point, size));
        } else if (drag.kind === "move") {
            const next = moveRegion(drag.initial, point.x - drag.origin.x, point.y - drag.origin.y, size);
            setRegions((current) => current.map((region) => (region.index === drag.index ? next : region)));
        } else {
            const rect = regionFromPoints(drag.anchor, point, size);
            const min = minRegionSide(size);
            if (rect.width < min || rect.height < min) return;
            setRegions((current) => current.map((region) => (region.index === drag.index ? { ...region, ...rect } : region)));
        }
    };
    const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !size) return;
        dragRef.current = null;
        if (surfaceRef.current?.hasPointerCapture(event.pointerId)) surfaceRef.current.releasePointerCapture(event.pointerId);
        const before = dragBeforeRef.current || regions;
        dragBeforeRef.current = null;
        setDragging(false);
        if (drag.kind === "create") {
            const rect = regionFromPoints(drag.start, pointAt(event.clientX, event.clientY), size);
            setDraft(null);
            const min = minRegionSide(size);
            // 小于下限视为单击空白处：取消选中，不新增区域。
            if (rect.width < min || rect.height < min) {
                setSelected(null);
                return;
            }
            const index = nextRegionIndex(regions);
            commit([...regions, { index, ...rect }], before);
            setSelected(index);
            setFocusRequest((value) => value + 1);
            return;
        }
        // 移动和缩放不改变区域集合，只记历史，不动提示词。
        if (before.some((region, position) => region !== regions[position])) {
            setPast((items) => [...items, before]);
            setFuture([]);
        }
    };
    const onSurfaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const mod = event.metaKey || event.ctrlKey;
        if ((event.key === "Delete" || event.key === "Backspace") && selected !== null) {
            event.preventDefault();
            removeRegion(selected);
        } else if (mod && event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
        } else if (event.key === "Escape" && selected !== null) {
            event.preventDefault();
            event.stopPropagation();
            setSelected(null);
        }
    };

    const submit = () => {
        if (!source || !size) return;
        if (!regions.length) return setError("请先在图片上框选至少一个区域");
        if (!trimmedPrompt) return setError("请写下修改要求，可用 @区域1 指定区域");
        const missing = missingRegionReferences(trimmedPrompt, regions);
        if (missing.length) return setError(`提示词引用了不存在的 ${missing.map((index) => regionMentionToken(index)).join("、")}`);
        let annotatedDataUrl: string;
        let maskDataUrl: string;
        try {
            annotatedDataUrl = renderRegionAnnotatedImage(source.element, size, orderedRegions);
            maskDataUrl = exportRegionMask(size, orderedRegions);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "区域标注导出失败");
            return;
        }
        const { model, quality, count, transparentBackground } = settings;
        onConfirm({ prompt: trimmedPrompt, regions: orderedRegions, size, annotatedDataUrl, maskDataUrl, generationConfig: { model, imageModel: model, size: settings.size, quality, count, transparentBackground } });
    };

    const percentStyle = (rect: Omit<ImageEditRegion, "index">): CSSProperties =>
        size
            ? {
                  left: `${(rect.x / size.width) * 100}%`,
                  top: `${(rect.y / size.height) * 100}%`,
                  width: `${(rect.width / size.width) * 100}%`,
                  height: `${(rect.height / size.height) * 100}%`,
              }
            : {};

    return (
        <AppModal open centered flush closable={false} footer={null} width="min(1360px, calc(100vw - 48px))" onCancel={onClose} aria-label="区域标注">
            <div className="rgn" style={{ "--rgn-color": IMAGE_REGION_COLOR } as CSSProperties}>
                <section className="rgn-stage" aria-label="标注画面">
                    <div className="rgn-stage-hint">
                        <SquareDashed className="size-3.5" aria-hidden />
                        拖拽框选要修改的地方，可框选多个 · <kbd>Delete</kbd> 删除
                    </div>
                    <div className="rgn-canvas">
                        {source && size ? (
                            <div className="rgn-frame">
                                <img src={source.url} alt="待标注图片" draggable={false} />
                                <div
                                    ref={surfaceRef}
                                    role="application"
                                    tabIndex={0}
                                    aria-label="在图片上拖拽框选需要修改的区域，可框选多个"
                                    className="rgn-surface"
                                    onPointerDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        setSelected(null);
                                        beginDrag(event, { kind: "create", pointerId: event.pointerId, start: pointAt(event.clientX, event.clientY) });
                                    }}
                                    onPointerMove={onSurfacePointerMove}
                                    onPointerUp={finishDrag}
                                    onPointerCancel={finishDrag}
                                    onKeyDown={onSurfaceKeyDown}
                                >
                                    {regions.map((region) => {
                                        const active = region.index === selected;
                                        return (
                                            <div
                                                key={region.index}
                                                className={`rgn-box${active ? " is-active" : ""}`}
                                                style={percentStyle(region)}
                                                onPointerDown={(event) => {
                                                    setSelected(region.index);
                                                    beginDrag(event, { kind: "move", pointerId: event.pointerId, index: region.index, origin: pointAt(event.clientX, event.clientY), initial: region });
                                                }}
                                            >
                                                <span className="rgn-badge">{region.index}</span>
                                                {active ? (
                                                    <>
                                                        <button type="button" aria-label={`删除${regionMentionLabel(region.index)}`} className="rgn-box-delete" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeRegion(region.index)}>
                                                            <X className="size-3.5" strokeWidth={2.4} />
                                                        </button>
                                                        {CORNERS.map((corner) => (
                                                            <span
                                                                key={corner}
                                                                aria-hidden
                                                                data-corner={corner}
                                                                className="rgn-handle"
                                                                onPointerDown={(event) => {
                                                                    const anchor = {
                                                                        x: corner === "nw" || corner === "sw" ? region.x + region.width : region.x,
                                                                        y: corner === "nw" || corner === "ne" ? region.y + region.height : region.y,
                                                                    };
                                                                    beginDrag(event, { kind: "resize", pointerId: event.pointerId, index: region.index, anchor });
                                                                }}
                                                            />
                                                        ))}
                                                    </>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                    {draft ? <div className="rgn-box is-draft" style={percentStyle(draft)} /> : null}
                                </div>
                            </div>
                        ) : (
                            <p className="rgn-loading">{loadError || "正在读取图片…"}</p>
                        )}
                    </div>
                    <div className="rgn-dock" role="toolbar" aria-label="区域标注工具">
                        <span className="rgn-dock-mode">
                            <SquareDashed className="size-4" aria-hidden />
                            框选
                        </span>
                        <span aria-hidden className="rgn-dock-divider" />
                        <DockButton title="撤销 ⌘Z" disabled={!past.length} onClick={undo}>
                            <Undo2 className="size-4" />
                        </DockButton>
                        <DockButton title="重做 ⇧⌘Z" disabled={!future.length} onClick={redo}>
                            <Redo2 className="size-4" />
                        </DockButton>
                        <DockButton
                            title="清空全部区域"
                            disabled={!regions.length}
                            onClick={() => {
                                commit([]);
                                setSelected(null);
                            }}
                        >
                            <RotateCcw className="size-4" />
                        </DockButton>
                        <span aria-hidden className="rgn-dock-divider" />
                        <span className="rgn-dock-count" aria-live="polite">
                            已标记 <strong>{regions.length}</strong> 处
                        </span>
                    </div>
                </section>

                <aside className="rgn-panel">
                    <header className="rgn-panel-header">
                        <div className="rgn-panel-heading">
                            <h2>区域标注</h2>
                            <p>框选区域后，用 @区域N 分别描述要怎么改</p>
                        </div>
                        <button type="button" className="rgn-close" aria-label="关闭" onClick={onClose}>
                            <X className="size-4" />
                        </button>
                    </header>

                    <div className="rgn-body">
                        <div className="rgn-label">区域{regions.length ? <span className="rgn-label-count">{regions.length}</span> : null}</div>
                        {orderedRegions.length ? (
                            <div className="rgn-tiles">
                                {orderedRegions.map((region) => {
                                    const label = regionMentionLabel(region.index);
                                    const thumbnail = thumbnails.get(region.index);
                                    return (
                                        <div key={region.index} className="rgn-tile">
                                            <button type="button" className="rgn-tile-select" aria-pressed={region.index === selected} aria-label={`选中${label}`} onClick={() => setSelected(region.index)}>
                                                {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : null}
                                                <span className="rgn-tile-badge">{region.index}</span>
                                            </button>
                                            <span className="rgn-tile-name">{label}</span>
                                            <button type="button" className="rgn-tile-remove" aria-label={`删除${label}`} onClick={() => removeRegion(region.index)}>
                                                <X className="size-3" strokeWidth={2.4} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="rgn-empty">
                                <span className="rgn-empty-icon">
                                    <SquareDashed className="size-5" />
                                </span>
                                <div>
                                    <strong>还没有区域</strong>
                                    <span>在左侧图片上拖拽画框，每个框会自动编号，并在提示词里加一行引用。</span>
                                </div>
                            </div>
                        )}

                        <div className="rgn-label">修改要求</div>
                        <div ref={editorRef} className="rgn-editor">
                            <CanvasResourceMentionTextarea
                                value={prompt}
                                references={mentionReferences}
                                mentionMenuLabels={MENTION_MENU_LABELS}
                                mentionMenuWidth={280}
                                sendOnEnter={false}
                                onSubmit={submit}
                                onChange={(value) => {
                                    setPrompt(value);
                                    setError("");
                                }}
                                containerClassName="rgn-editor-input"
                                className="thin-scrollbar h-full w-full resize-none border-none bg-transparent px-4 py-3 text-[var(--fs-body)] leading-7 !outline-none !ring-0 !shadow-none placeholder:text-current placeholder:opacity-40"
                                style={{ color: "var(--foreground)", outline: "none", boxShadow: "none" }}
                                placeholder={regions.length ? "在区域后写下修改要求，例如：@区域1 换成一艘渔船" : "先在左侧框选区域"}
                                aria-label="区域修改要求，可输入 @ 引用区域"
                            />
                            <div className="rgn-editor-tip">
                                <span>输入 @ 引用区域</span>
                                <span>
                                    <kbd>⌘</kbd> <kbd>Enter</kbd> 生成
                                </span>
                            </div>
                        </div>
                    </div>

                    {error || loadError ? (
                        <p role="alert" className="rgn-error">
                            {error || loadError}
                        </p>
                    ) : null}
                    <footer className="rgn-footer">
                        <ModelPicker
                            className="!h-9 !w-full !min-w-0 !justify-start !rounded-[var(--r-lg)] !text-[var(--fs-label)] !font-normal"
                            fullWidth
                            config={settings}
                            value={settings.model}
                            capability="image"
                            variant="creation"
                            showSelectedPrice={false}
                            showConfiguredModelName
                            onChange={(model) => setSettings((previous) => ({ ...previous, ...defaultImageParamsForModel(previous, model), imageModel: model, model }))}
                        />
                        <div className="rgn-footer-row">
                            <CanvasImageSettingsPopover
                                config={settings}
                                placement="topLeft"
                                buttonClassName="!h-9 !max-w-[220px] !justify-start !rounded-[var(--r-lg)] !px-3 !text-[var(--fs-label)]"
                                onConfigChange={(key, value) => setSettings((previous) => ({ ...previous, [key]: value }))}
                            />
                            <span className="rgn-footer-spacer" />
                            <Button className="rgn-submit" type="primary" shape="round" icon={<ArrowUp className="size-4" strokeWidth={2.4} />} disabled={!canSubmit} onClick={submit}>
                                生成
                            </Button>
                        </div>
                    </footer>
                </aside>
            </div>
        </AppModal>
    );
}

function DockButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <Tooltip title={title}>
            <button type="button" className="rgn-dock-button" aria-label={title} disabled={disabled} onClick={onClick}>
                {children}
            </button>
        </Tooltip>
    );
}
