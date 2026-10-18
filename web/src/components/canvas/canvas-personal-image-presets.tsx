import { App, Button, Form, Input } from "antd";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { AppModal } from "@/components/ui/product/app-modal";
import { createTool, deleteTool, getTool, listTools, updateTool, type ToolItem, type ToolMutationInput, type ToolSummary } from "@/services/api/tools";
import { useUserStore } from "@/stores/use-user-store";

type PresetValues = { label: string; desc: string; prompt: string };

export function CanvasPersonalImagePresets({
    open,
    onSelect,
    onEditingChange,
    activeToolId,
    onClear,
}: {
    open: boolean;
    onSelect: (toolId: number, label: string, icon: string) => void;
    onEditingChange: (editing: boolean) => void;
    activeToolId?: number;
    onClear?: () => void;
}) {
    const { message, modal } = App.useApp();
    const userId = useUserStore((state) => state.user?.id);
    const queryClient = useQueryClient();
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [editor, setEditor] = useState<{ tool?: ToolItem } | null>(null);
    const [form] = Form.useForm<PresetValues>();

    useEffect(() => {
        const timer = window.setTimeout(() => setSearch(searchInput.trim()), 200);
        return () => window.clearTimeout(timer);
    }, [searchInput]);

    useEffect(() => {
        setEditor(null);
        onEditingChange(false);
        setSearchInput("");
        setSearch("");
        form.resetFields();
    }, [userId, form, onEditingChange]);

    const presets = useInfiniteQuery({
        queryKey: ["canvas-tools", userId, "personal-image-presets", search],
        queryFn: ({ signal, pageParam }) => listTools({ scope: "custom", type: "nine_grid", search: search || undefined, page: pageParam, pageSize: 40 }, { signal }),
        initialPageParam: 1,
        getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
        enabled: open && Boolean(userId),
    });
    const items = presets.data?.pages.flatMap((page) => page.tools) ?? [];
    const isCurrentUser = (id: string) => useUserStore.getState().user?.id === id;
    const closeEditor = () => {
        setEditor(null);
        onEditingChange(false);
    };
    const invalidate = (id: string) => queryClient.invalidateQueries({ queryKey: ["canvas-tools", id] });

    const save = useMutation({
        mutationFn: ({ existing, account, values }: { existing?: ToolItem; account: string; values: PresetValues }) => {
            if (!isCurrentUser(account)) throw new Error("账号已切换，请重新打开预设");
            const input: ToolMutationInput = {
                type: "nine_grid",
                label: values.label.trim(),
                desc: values.desc?.trim() || "",
                prompt: values.prompt.trim(),
                visibility: existing?.visibility === "public" ? "public" : "private",
                tag: existing?.tag,
                cover: existing?.cover,
                extraInfo: existing?.extraInfo,
                ratio: existing?.ratio,
                mediaUrl: existing?.mediaUrl,
            };
            return existing ? updateTool(existing.id, input) : createTool(input);
        },
        onSuccess: (saved, variables) => {
            if (!isCurrentUser(variables.account)) return;
            void invalidate(variables.account);
            setSearchInput("");
            setSearch("");
            if (saved.id === activeToolId) onSelect(saved.id, saved.label, "WandSparkles");
            closeEditor();
            message.success("已保存到我的预设");
        },
        onError: (error, variables) => {
            if (isCurrentUser(variables.account)) message.error(error instanceof Error ? error.message : "预设保存失败");
        },
    });

    const edit = useMutation({
        mutationFn: ({ tool, account }: { tool: ToolSummary; account: string }) => {
            if (!isCurrentUser(account)) throw new Error("账号已切换，请重新打开预设");
            return getTool(tool.id);
        },
        onSuccess: (tool, variables) => {
            if (!isCurrentUser(variables.account)) return;
            form.setFieldsValue({ label: tool.label, desc: tool.desc, prompt: tool.prompt });
            setEditor({ tool });
            onEditingChange(true);
        },
        onError: (error, variables) => {
            if (isCurrentUser(variables.account)) message.error(error instanceof Error ? error.message : "读取预设失败");
        },
    });

    const remove = useMutation({
        mutationFn: ({ id, account }: { id: number; account: string }) => {
            if (!isCurrentUser(account)) throw new Error("账号已切换，请重新打开预设");
            return deleteTool(id);
        },
        onSuccess: (_, variables) => {
            if (!isCurrentUser(variables.account)) return;
            if (variables.id === activeToolId) onClear?.();
            void invalidate(variables.account);
            message.success("预设已删除");
        },
        onError: (error, variables) => {
            if (isCurrentUser(variables.account)) message.error(error instanceof Error ? error.message : "删除预设失败");
        },
    });

    const confirmDelete = (tool: ToolSummary) => {
        if (!userId) return;
        const account = userId;
        onEditingChange(true);
        modal.confirm({
            title: `删除“${tool.label}”？`,
            content: "删除后将不能再从我的预设中复用。",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => remove.mutateAsync({ id: tool.id, account }),
            afterClose: () => onEditingChange(false),
        });
    };

    return (
        <>
            <div className="flex items-center gap-2 p-2">
                <Input size="small" aria-label="搜索我的图片预设" placeholder="搜索我的预设" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} allowClear />
                <Button
                    size="small"
                    icon={<Plus className="size-3.5" />}
                    disabled={!userId}
                    onClick={() => {
                        form.resetFields();
                        setEditor({});
                        onEditingChange(true);
                    }}
                >
                    新增预设
                </Button>
            </div>
            <div className="thin-scrollbar max-h-80 overflow-y-auto px-2 pb-2">
                {presets.isPending ? (
                    <div className="py-8 text-center text-xs opacity-60">正在读取预设…</div>
                ) : presets.isError ? (
                    <div role="alert" className="py-6 text-center text-xs">
                        <p>预设加载失败</p>
                        <Button size="small" type="link" onClick={() => void presets.refetch()}>
                            重试
                        </Button>
                    </div>
                ) : items.length ? (
                    items.map((tool) => (
                        <div key={tool.id} className="flex items-center gap-1 rounded-lg hover:bg-surface-active">
                            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left" aria-pressed={activeToolId === tool.id} onClick={() => onSelect(tool.id, tool.label, "WandSparkles")}>
                                <WandSparkles className="size-3.5 shrink-0" />
                                <span className="min-w-0">
                                    <span className="block truncate text-xs font-medium">{tool.label}</span>
                                    {tool.desc ? <span className="block truncate text-xs opacity-60">{tool.desc}</span> : null}
                                </span>
                            </button>
                            <Button
                                type="text"
                                size="small"
                                aria-label={`编辑预设 ${tool.label}`}
                                icon={<Pencil className="size-3.5" />}
                                loading={edit.isPending && edit.variables?.tool.id === tool.id}
                                onClick={() => userId && edit.mutate({ tool, account: userId })}
                            />
                            <Button type="text" size="small" aria-label={`删除预设 ${tool.label}`} icon={<Trash2 className="size-3.5" />} disabled={remove.isPending} onClick={() => confirmDelete(tool)} />
                        </div>
                    ))
                ) : (
                    <div className="py-8 text-center text-xs opacity-60">{search ? "没有匹配的预设" : "还没有个人预设，点击新增保存常用提示词"}</div>
                )}
                {presets.hasNextPage ? (
                    <Button block type="text" size="small" loading={presets.isFetchingNextPage} onClick={() => void presets.fetchNextPage()}>
                        加载更多
                    </Button>
                ) : null}
            </div>
            <AppModal
                title={editor?.tool ? "编辑我的图片预设" : "新增我的图片预设"}
                open={editor !== null}
                onCancel={closeEditor}
                onOk={() => form.submit()}
                okText="保存预设"
                cancelText="取消"
                confirmLoading={save.isPending}
                closable={!save.isPending}
                maskClosable={!save.isPending}
                keyboard={!save.isPending}
                cancelButtonProps={{ disabled: save.isPending }}
            >
                <Form form={form} layout="vertical" onFinish={(values) => userId && save.mutate({ existing: editor?.tool, account: userId, values })}>
                    <p className="mb-4 text-xs text-muted-foreground">{editor?.tool?.visibility === "public" ? "此预设已公开，修改后保留原有可见范围。" : "保存后仅自己可见，下次出图时点击即可复用。"}</p>
                    <Form.Item name="label" label="预设名称" rules={[{ required: true, whitespace: true, message: "请输入预设名称" }]}>
                        <Input maxLength={40} placeholder="例如：商品白底图" />
                    </Form.Item>
                    <Form.Item name="desc" label="简介（选填）">
                        <Input maxLength={160} placeholder="一句话说明用途" />
                    </Form.Item>
                    <Form.Item
                        name="prompt"
                        label="提示词"
                        rules={[
                            { required: true, whitespace: true, message: "请输入提示词" },
                            { validator: (_, value: string) => (new TextEncoder().encode(value || "").length <= 8000 ? Promise.resolve() : Promise.reject(new Error("提示词过长，请控制在约2600个汉字以内"))) },
                        ]}
                    >
                        <Input.TextArea rows={8} placeholder="填写希望反复使用的画面要求、风格或构图提示词" />
                    </Form.Item>
                </Form>
            </AppModal>
        </>
    );
}
