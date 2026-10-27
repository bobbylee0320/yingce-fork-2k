import { useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Button, Input, Tooltip, type InputRef } from "antd";
import { AudioLines, Check, Cpu, Film, Grid2X2, Image, Layers3, MessageSquare, Search, X } from "lucide-react";

import { toc } from "@lobehub/icons/es/toc";

import { cn } from "@/lib/utils";
import { createModelLogoResolver } from "@/lib/model-logo-id";
import { createModelLogoOption, MODEL_LOGO_CATEGORIES, MODEL_LOGO_FEATURED, type ModelLogoCategory } from "@/lib/model-logo-catalog";
import { AppModal } from "@/components/ui/product/app-modal";

type LobeIconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

// 优先使用品牌原色，缺少彩色版本时使用 Mono。不能使用 eager glob：目录有数百个模块，
// eager 会让每次进入工作区都发起数百个开发模块请求，即使用户从未打开 Logo 选择器。
const iconModules = "Bun" in globalThis ? {} : import.meta.glob("../../node_modules/@lobehub/icons/es/*/components/Mono.js", { import: "default" });
const colorIconModules = "Bun" in globalThis ? {} : import.meta.glob("../../node_modules/@lobehub/icons/es/*/components/Color.js", { import: "default" });
const iconLoaders = Object.fromEntries(
    [...Object.entries(iconModules), ...Object.entries(colorIconModules)]
        .map(([path, loader]) => [path.match(/\/([^/]+)\/components\/(?:Mono|Color)\.js$/)?.[1], loader])
        .filter((entry): entry is [string, () => Promise<LobeIconComponent>] => Boolean(entry[0] && entry[1])),
) as Record<string, () => Promise<LobeIconComponent>>;
const resolveIconId = createModelLogoResolver(Object.keys(iconLoaders));
const iconRegistry = new Map<string, LobeIconComponent>();
const iconLoadPromises = new Map<string, Promise<LobeIconComponent | undefined>>();
const iconOptions = toc
    .filter((item) => item.group === "model" || item.group === "provider" || item.group === "application")
    .map(createModelLogoOption)
    .filter((item) => Boolean(iconLoaders[item.id]));

const logoFilters = [{ id: "all", label: "全部" } as const, ...MODEL_LOGO_CATEGORIES];
type ModelLogoFilter = ModelLogoCategory | "all";
const categoryIcons = { all: Layers3, image: Image, video: Film, llm: MessageSquare, audio: AudioLines, platform: Grid2X2 };
const pickerFocusClassName = "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

function loadIcon(icon?: string) {
    if (!icon) return Promise.resolve(undefined);
    const cached = iconRegistry.get(icon);
    if (cached) return Promise.resolve(cached);
    const existing = iconLoadPromises.get(icon);
    if (existing) return existing;
    const loader = iconLoaders[icon];
    if (!loader) return Promise.resolve(undefined);
    const promise = loader()
        .then((module) => {
            const loaded = (module as unknown as { default?: LobeIconComponent }).default || module;
            iconRegistry.set(icon, loaded);
            return loaded;
        })
        .catch(() => undefined);
    iconLoadPromises.set(icon, promise);
    return promise;
}

export function ModelLogo({ icon: rawIcon, size = 18, className }: { icon?: string; size?: number; className?: string }) {
    const icon = resolveIconId(rawIcon);
    const [Icon, setIcon] = useState<LobeIconComponent | undefined>(() => (icon ? iconRegistry.get(icon) : undefined));
    useEffect(() => {
        let cancelled = false;
        setIcon(icon ? iconRegistry.get(icon) : undefined);
        if (!icon || !iconLoaders[icon])
            return () => {
                cancelled = true;
            };
        void loadIcon(icon).then((loaded) => {
            if (!cancelled) setIcon(loaded);
        });
        return () => {
            cancelled = true;
        };
    }, [icon]);
    if (!Icon) return <Cpu className={cn("shrink-0 text-foreground/45", className)} size={size} aria-hidden />;
    return <Icon size={size} className={cn("shrink-0", className)} aria-hidden />;
}

export function ModelIconPicker({ value, onChange }: { value?: string; onChange?: (value: string) => void }) {
    const [open, setOpen] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<ModelLogoFilter>("all");
    const searchInputRef = useRef<InputRef>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const query = keyword.trim().toLowerCase();

    useEffect(() => {
        if (resultsRef.current) resultsRef.current.scrollTop = 0;
    }, [category, query]);

    const filteredIcons = useMemo(() => {
        if (query) return iconOptions.filter((item) => item.searchText.includes(query));
        if (category === "all") return iconOptions;
        const featured = MODEL_LOGO_FEATURED[category];
        const rank = (id: string) => {
            const index = featured.indexOf(id);
            return index === -1 ? featured.length : index;
        };
        return iconOptions.filter((item) => item.categories.includes(category)).sort((a, b) => rank(a.id) - rank(b.id));
    }, [query, category]);

    const selectedId = resolveIconId(value);
    const selectedOption = iconOptions.find((item) => item.id === selectedId);
    const categoryLabel = logoFilters.find((item) => item.id === category)?.label;

    const close = () => setOpen(false);
    const clear = () => {
        onChange?.("");
        close();
    };

    return (
        <>
            <div className="flex min-w-0 items-center rounded-md border border-border bg-background">
                <button
                    type="button"
                    className={cn("flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 hover:bg-surface-hover motion-reduce:transition-none pointer-coarse:min-h-11", pickerFocusClassName)}
                    aria-label="选择模型 Logo"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={() => {
                        setKeyword("");
                        setCategory(selectedOption?.categories[0] ?? "all");
                        setOpen(true);
                    }}
                >
                    <ModelLogo icon={value} size={18} />
                    <span className="min-w-0 flex-1 truncate">{selectedOption?.label || value || "选择 Logo"}</span>
                    {!value ? <span className="text-xs text-muted-foreground">浏览</span> : null}
                </button>
                {value ? (
                    <button type="button" className={cn("mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-surface-hover pointer-coarse:size-11", pickerFocusClassName)} onClick={clear} aria-label="清除 Logo">
                        <X size={12} aria-hidden />
                    </button>
                ) : null}
            </div>

            <AppModal
                flush
                title={null}
                aria-label="选择模型 Logo"
                open={open}
                onCancel={close}
                width={640}
                centered
                closable={false}
                footer={null}
                afterOpenChange={(visible) => {
                    if (visible) searchInputRef.current?.focus({ preventScroll: true });
                }}
            >
                <section className="bg-surface text-foreground" aria-label="选择模型 Logo">
                    <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
                        <h2 className="m-0 text-base font-semibold">选择模型 Logo</h2>
                        <Button type="text" size="small" icon={<X size={16} aria-hidden />} onClick={close} aria-label="关闭 Logo 选择器" />
                    </header>
                    <div className="px-5 pb-4">
                        <Input
                            ref={searchInputRef}
                            prefix={<Search size={14} className="text-muted-foreground" aria-hidden />}
                            value={keyword}
                            onChange={(event) => setKeyword(event.target.value)}
                            placeholder="搜索模型 Logo"
                            aria-label="搜索全部模型 Logo"
                            allowClear
                        />
                    </div>
                    <div className="grid grid-cols-[calc(var(--space-10)*3)_minmax(0,1fr)] border-t border-border max-[520px]:grid-cols-1">
                        <nav className="flex flex-col gap-1 border-r border-border px-2 py-3 max-[520px]:flex-row max-[520px]:border-r-0 max-[520px]:border-b max-[520px]:py-2" aria-label="Logo 分类">
                            {logoFilters.map((item) => {
                                const Icon = categoryIcons[item.id];
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className={cn(
                                            "flex min-h-10 items-center gap-2.5 rounded-md px-3 py-2 text-left text-[length:var(--typ-caption)] text-muted-foreground transition-colors duration-150 hover:bg-surface-hover hover:text-foreground aria-pressed:bg-[var(--control-selected-bg)] aria-pressed:text-[var(--control-selected-fg)] max-[520px]:flex-1 max-[520px]:justify-center max-[520px]:gap-1 max-[520px]:px-1 motion-reduce:transition-none pointer-coarse:min-h-11",
                                            pickerFocusClassName,
                                        )}
                                        aria-pressed={query ? item.id === "all" : category === item.id}
                                        onClick={() => {
                                            setCategory(item.id);
                                            setKeyword("");
                                        }}
                                    >
                                        <Icon size={15} className="shrink-0 max-[520px]:hidden" aria-hidden />
                                        <span>{item.label}</span>
                                    </button>
                                );
                            })}
                        </nav>
                        <div className="h-[min(360px,48dvh)] min-w-0 overflow-y-auto overscroll-contain p-3 [scrollbar-color:var(--control-selected-border)_transparent] [scrollbar-width:thin] max-[520px]:h-[min(320px,44dvh)]" ref={resultsRef}>
                            <div className="mb-2 flex items-center justify-between gap-2 text-[length:var(--typ-caption)] font-medium">
                                <span>{query ? "搜索结果" : categoryLabel}</span>
                                <span className="text-xs font-normal text-muted-foreground" role="status">
                                    {query ? "全部分类 · " : ""}
                                    {filteredIcons.length} 个 Logo
                                </span>
                            </div>
                            {filteredIcons.length ? (
                                <ul className="m-0 grid list-none grid-cols-4 gap-1 p-0 max-[520px]:grid-cols-3" aria-label={query ? "Logo 搜索结果" : `${categoryLabel} Logo`}>
                                    {filteredIcons.map((item) => {
                                        const selected = selectedId === item.id;
                                        return (
                                            <li key={item.id} className="min-w-0">
                                                <Tooltip title={item.title} trigger={["hover", "focus"]}>
                                                    <button
                                                        type="button"
                                                        aria-pressed={selected}
                                                        aria-label={`选择 ${item.label}`}
                                                        className={cn(
                                                            "relative flex h-full min-h-16 w-full flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1 py-2 transition-colors duration-150 hover:bg-surface-hover aria-pressed:border-[var(--control-selected-border)] aria-pressed:bg-[var(--control-selected-bg)] aria-pressed:text-[var(--control-selected-fg)] motion-reduce:transition-none",
                                                            pickerFocusClassName,
                                                        )}
                                                        onClick={() => {
                                                            onChange?.(item.id);
                                                            close();
                                                        }}
                                                    >
                                                        <ModelLogo icon={item.id} size={22} />
                                                        <span className="line-clamp-2 min-h-4 max-w-full text-xs leading-4 [overflow-wrap:anywhere]">{item.label}</span>
                                                        {selected ? <Check size={12} className="absolute top-1 right-1" aria-hidden /> : null}
                                                    </button>
                                                </Tooltip>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : (
                                <div className="flex flex-col items-center gap-3 px-2 py-10 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                    <Search size={20} aria-hidden />
                                    <span>未找到与“{keyword.trim()}”相关的 Logo</span>
                                    <Button type="text" size="small" onClick={() => setKeyword("")}>
                                        清空搜索
                                    </Button>
                                </div>
                            )}
                        </div>
                    </div>
                    <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs max-[520px]:flex-wrap max-[520px]:px-3">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <ModelLogo icon={value} size={16} />
                            <span className="shrink-0 text-muted-foreground">{value ? "当前" : "尚未设置 Logo"}</span>
                            {value ? <span className="min-w-0 flex-1 truncate">{selectedOption?.label || value}</span> : null}
                        </div>
                        <div className="flex min-w-0 shrink-0 items-center gap-2">
                            <span className="text-muted-foreground max-[520px]:hidden">单击图标即选用</span>
                            {value ? (
                                <Button type="text" size="small" onClick={clear}>
                                    清除 Logo
                                </Button>
                            ) : null}
                        </div>
                    </footer>
                </section>
            </AppModal>
        </>
    );
}
