import { useMemo, useState } from "react";
import { Input, Popover } from "antd";
import { Search, WandSparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type CanvasPromptPreset = {
    id: string;
    name: string;
    description: string;
    prompt: string;
};

export function CanvasPresetPicker({
    skillReferences = [],
    open,
    onOpenChange,
    onSelect,
    compact = false,
    dense = false,
    appearance = "default",
}: {
    skillReferences?: CanvasResourceReference[];
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onSelect: (preset: CanvasPromptPreset) => void;
    compact?: boolean;
    dense?: boolean;
    appearance?: "default" | "quiet";
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [internalOpen, setInternalOpen] = useState(false);
    const [query, setQuery] = useState("");
    const actualOpen = open ?? internalOpen;
    const setOpen = (next: boolean) => {
        if (!next) setQuery("");
        setInternalOpen(next);
        onOpenChange?.(next);
    };
    const presets = useMemo(() => {
        const skills = skillReferences.flatMap((reference): CanvasPromptPreset[] => {
            if (!reference.skill) return [];
            return [
                {
                    id: `skill:${reference.skill.skillId}`,
                    name: reference.skill.skillName,
                    description: reference.skill.description || reference.skill.instruction || "已加入技能",
                    prompt: `@${reference.skill.skillName} `,
                },
            ];
        });
        const normalized = query.trim().toLowerCase();
        return skills.filter((preset) => !normalized || `${preset.name} ${preset.description}`.toLowerCase().includes(normalized));
    }, [query, skillReferences]);

    const content = (
        <div data-canvas-no-zoom className="canvas-preset-picker-menu w-[var(--panel-width-compact)] max-w-[calc(100vw-24px)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Input className="canvas-preset-picker-search" variant="borderless" autoFocus allowClear size="small" prefix={<Search className="size-3.5" />} placeholder="搜索已加入技能" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="thin-scrollbar mt-1 max-h-72 space-y-0.5 overflow-y-auto">
                {presets.length ? (
                    presets.map((preset) => (
                        <button
                            key={preset.id}
                            type="button"
                            className="canvas-preset-picker-option"
                            onClick={() => {
                                onSelect(preset);
                                setOpen(false);
                            }}
                        >
                            <span className="canvas-preset-picker-option-icon" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                                <WandSparkles className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: theme.node.text }}>
                                    <span className="truncate">{preset.name}</span>
                                    <span className="shrink-0 text-[var(--fs-micro)] font-medium" style={{ color: theme.accent.primary }}>
                                        技能
                                    </span>
                                </span>
                                <span className="mt-0.5 block truncate text-[var(--fs-tiny)] leading-4" style={{ color: theme.node.muted }}>
                                    {preset.description}
                                </span>
                            </span>
                        </button>
                    ))
                ) : (
                    <div className="py-8 text-center text-xs" style={{ color: theme.node.muted }}>
                        {skillReferences.length ? "没有匹配的技能" : "还没有已加入的技能"}
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <Popover
            open={actualOpen}
            onOpenChange={setOpen}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={content}
            classNames={{ root: "canvas-preset-picker-popover", container: "canvas-composer-popover-surface", content: "canvas-composer-popover-content" }}
        >
            <button
                type="button"
                className={`canvas-preset-picker-trigger ${appearance === "quiet" ? "canvas-node-composer-header-action" : ""} inline-flex shrink-0 items-center justify-center gap-1 rounded-lg transition focus-visible:outline-none ${compact ? "size-6" : dense ? "h-6 px-1.5" : "h-7 px-2"}`}
                style={appearance === "quiet" ? undefined : { background: theme.accent.primarySoft, color: theme.accent.primary }}
                title="选择已加入技能"
                aria-label="选择已加入技能"
                aria-expanded={actualOpen}
            >
                <WandSparkles className={dense ? "size-3" : "size-3.5"} />
                {compact ? null : <span className="text-[var(--fs-tiny)] font-medium">技能</span>}
            </button>
        </Popover>
    );
}
