import { App, Input } from "antd";
import { CanvasAnchoredDropdown as Dropdown } from "./canvas-anchored-dropdown";
import { Clock3, Download, FolderKanban, Layers3, LoaderCircle, MoreHorizontal, Pencil, Shapes, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { formatAbsoluteDateTime, formatRelativeTime } from "@/lib/relative-time";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasLibrarySummary } from "@/services/api/user-data";
import { loadCanvasProjectForEditing, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { cn } from "@/lib/utils";

type CanvasFolderCardProps = {
    project: CanvasLibrarySummary;
    projectName?: string;
    onClick: () => void;
    onPrefetch?: () => void;
    opening?: boolean;
};

/**
 * 画布库卡片：内嵌圆角封面（最多三张媒体拼图）+ 标题 + 归属/更新时间页脚。
 * 节点数作为封面角标；重命名铅笔紧跟标题行尾，多选框与更多菜单浮在封面顶部，仅 hover/focus 显示，触屏常显。
 */
export function CanvasFolderCard({ project, projectName, onClick, onPrefetch, opening = false }: CanvasFolderCardProps) {
    const { message } = App.useApp();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const updatedTitle = `更新于 ${formatAbsoluteDateTime(project.updatedAt)} · 创建于 ${formatAbsoluteDateTime(project.createdAt)}`;

    const saveTitle = async () => {
        if (!editing) return;
        stopEditing();
        try {
            await loadCanvasProjectForEditing(project.id);
            renameProject(project.id, editingTitle);
            await saveRemoteUserDataNow(project.id);
        } catch (error) { message.error(error instanceof Error ? error.message : "重命名失败"); }
    };
    const exportProject = async () => {
        try {
            const fullProject = await loadCanvasProjectForEditing(project.id);
            if (!fullProject) throw new Error("画布不存在");
            await exportCanvasProjects([fullProject], project.title || "画布");
        } catch (error) { message.error(error instanceof Error ? error.message : "导出失败"); }
    };

    const handleOpenKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!editing && !opening) onClick();
        }
    };

    return (
        <article className={cn("product-collection-card canvas-collection-card", selected && "is-selected", editing && "is-editing", opening && "is-opening")} onPointerEnter={onPrefetch} onPointerDown={onPrefetch} onFocusCapture={onPrefetch}>
            <div className="canvas-collection-open" role="button" tabIndex={0} aria-label={`打开画布 ${project.title}`} aria-busy={opening} onClick={() => !editing && !opening && onClick()} onKeyDown={handleOpenKeyDown}>
                <div className="canvas-collection-preview">
                    <div className="canvas-collection-preview-media" aria-hidden="true">
                        <ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} preferLatestImage quiet mosaic />
                    </div>
                    <span className="canvas-collection-badge" title={`${project.nodeCount} 个节点`}>
                        <Layers3 aria-hidden="true" />
                        <span>{project.nodeCount}</span>
                        <span className="sr-only">个节点</span>
                    </span>
                    {opening ? <div className="canvas-collection-opening"><LoaderCircle className="size-5 animate-spin" aria-hidden="true" /><span>正在打开</span></div> : null}
                </div>
                <div className="canvas-collection-body">
                    <div className="canvas-collection-heading-row">
                        {editing ? (
                            <Input
                                className="canvas-collection-title-input"
                                size="small"
                                value={editingTitle}
                                aria-label="画布名称"
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                onBlur={saveTitle}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") saveTitle();
                                    if (event.key === "Escape") stopEditing();
                                }}
                                autoFocus
                            />
                        ) : (
                            <span className="canvas-collection-title" title={project.title}>{project.title}</span>
                        )}
                    </div>
                    <div className="canvas-collection-footer">
                        <span className={cn("canvas-collection-project", !projectName && "is-free")} title={projectName ? `所属项目：${projectName}` : "未归属项目的自由画布"}>
                            {projectName ? <FolderKanban aria-hidden="true" /> : <Shapes aria-hidden="true" />}
                            <span>{projectName || "自由画布"}</span>
                        </span>
                        <time className="canvas-collection-updated" dateTime={project.updatedAt} title={updatedTitle}>
                            <Clock3 aria-hidden="true" />
                            {formatRelativeTime(project.updatedAt)}
                        </time>
                    </div>
                </div>
            </div>

            {!editing ? (
                <button
                    type="button"
                    className="product-icon-button canvas-collection-rename"
                    aria-label={`重命名 ${project.title}`}
                    title="重命名"
                    onClick={(event) => {
                        event.stopPropagation();
                        startEditing(project.id, project.title);
                    }}
                >
                    <Pencil />
                </button>
            ) : null}

            <span className={cn("canvas-collection-select", selected && "is-visible")} onClick={(event) => event.stopPropagation()}>
                <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    aria-label={`选择 ${project.title}`}
                />
            </span>

            <div className="canvas-collection-actions" onClick={(event) => event.stopPropagation()}>
                <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    menu={{
                        onClick: ({ domEvent }) => domEvent.stopPropagation(),
                        items: [
                            { key: "rename", icon: <Pencil className="size-3.5" />, label: "重命名", onClick: () => startEditing(project.id, project.title) },
                            { key: "export", icon: <Download className="size-3.5" />, label: "导出画布", onClick: () => void exportProject() },
                            { type: "divider" },
                            { key: "delete", danger: true, icon: <Trash2 className="size-3.5" />, label: "删除", onClick: () => setDeleteIds([project.id]) },
                        ],
                    }}
                >
                    <button type="button" className="product-icon-button canvas-collection-more" aria-label={`${project.title} 画布操作`} title="更多操作" onClick={(event) => event.stopPropagation()}>
                        <MoreHorizontal />
                    </button>
                </Dropdown>
            </div>
        </article>
    );
}
