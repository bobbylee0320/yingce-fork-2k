import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Asset } from "../../src/stores/use-asset-store";
import type { RemoteAssetPage } from "../../src/services/api/user-data";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
}))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const antd = await import("antd");
mock.module("antd", () => ({ ...antd, App: { useApp: () => ({ message: { success() {}, warning() {}, error() {} } }) } }));
mock.module("../../src/components/ui/product/app-modal", () => ({ AppModal: ({ open, children }: any) => (open ? children : null) }));
mock.module("../../src/components/cached-resource-image", () => ({ CachedResourceImage: ({ alt }: any) => <span>{alt}</span> }));
mock.module("../../src/components/asset-media-preview", () => ({ AssetMediaPreview: () => null }));
mock.module("../../src/components/layout/workspace-page", () => ({
    PaginationBar: ({ current, total, onChange }: any) => (
        <div data-page={current} data-total={total}>
            <button onClick={() => onChange(2, 40)}>下一页</button>
        </div>
    ),
}));

const image = (id: string, folderId?: string): Asset => ({
    id,
    title: id,
    kind: "image",
    category: "material",
    folderId,
    coverUrl: "",
    tags: [],
    createdAt: "2026-10-18",
    updatedAt: "2026-10-18",
    data: { dataUrl: "", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
});
let folderNames = [
    { id: "people", name: "病娇-人物" },
    { id: "places", name: "病娇-场景" },
    { id: "empty", name: "空分类" },
];
let folderFailure = false;
const folderReads: AbortSignal[] = [];
const pageReads: any[] = [];
const api = await import("../../src/services/api/user-data");
mock.module("../../src/services/api/user-data", () => ({
    ...api,
    listAssetFolders: async (signal: AbortSignal) => {
        folderReads.push(signal);
        if (folderFailure) throw new Error("分类服务暂时不可用");
        return { folders: folderNames };
    },
}));
const page = (options: any): RemoteAssetPage => {
    const selectedFolder = options.uncategorized ? "" : options.folderId;
    const id = selectedFolder === "people" ? `人物-${options.page}` : selectedFolder === "places" ? "场景" : selectedFolder === "" ? "未归类图片" : "全部图片";
    const assets = selectedFolder === "empty" || options.query === "不存在" ? [] : [image(id, selectedFolder || undefined)];
    return { assets, total: assets.length ? 81 : 0, page: options.page, pageSize: options.pageSize, hasMore: true, kindCounts: { image: 81 }, categoryCounts: { material: 81 }, folderCounts: { people: 48, places: 66, empty: 0, "": 455 } };
};
mock.module("../../src/services/user-data-sync", () => ({
    loadAssetLibraryPage: async (options: any) => {
        pageReads.push(options);
        return page(options);
    },
    deleteAssetsWithRemoteSync: async () => {},
    saveRemoteUserDataNow: async () => {},
    localSavedRemotePendingMessage: () => "",
}));
const { AssetLibraryPickerModal, remoteAssetToPickerItem } = await import("../../src/components/assets/asset-library-picker-modal");
const { useUserStore } = await import("../../src/stores/use-user-store");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 0 } } });
const root = createRoot(document.body.appendChild(document.createElement("div")));
let picked: string[] = [];
let pickedItems: any[] = [];
let open = true;
const cached = image("缓存中其他分类的图片", "people");
const render = async () => {
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <AssetLibraryPickerModal
                    remoteLibrary
                    acceptRemoteItems
                    open={open}
                    items={[
                        { id: cached.id, title: cached.title, category: "material", kindLabel: "图片", asset: cached },
                        { id: "external-image", title: "插件图片", category: "external:eagle", kindLabel: "图片", folderId: "external-folder", external: { sourceId: "eagle", sourceName: "Eagle", item: { id: "image", title: "插件图片", kind: "image" } } },
                    ]}
                    folders={[{ id: "external-folder", name: "Eagle 文件夹" }]}
                    categoryLabels={{ all: "全部素材", material: "素材", "external:eagle": "Eagle" }}
                    onClose={() => {}}
                    onConfirm={(ids, items) => {
                        picked = ids;
                        pickedItems = items || [];
                    }}
                />
            </QueryClientProvider>,
        );
    });
    await settle();
};
async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
    });
}
async function click(text: string, selector = "button") {
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((entry) => entry.textContent?.replace(/\s+/g, "").includes(text.replace(/\s+/g, "")));
    expect(button, text).toBeDefined();
    await act(async () => button!.click());
    await settle();
}
const sidebar = () => document.querySelector('nav[aria-label="素材分类"]')!;

afterAll(async () => {
    await act(async () => root.unmount());
    client.clear();
    dom.happyDOM.abort();
});

test("读取个人分类及全量数量，带分类查询所有分页，跨分类选择保留正确素材", async () => {
    useUserStore.setState({ user: { id: "user-a", username: "test", displayName: "test", role: "user", status: "active" }, hydrated: true });
    await render();
    expect(sidebar().textContent).toContain("我的分类");
    expect(sidebar().textContent).toContain("病娇-人物48");
    expect(sidebar().textContent).toContain("病娇-场景66");
    expect(sidebar().textContent).toContain("未分类455");
    expect(folderReads[0]).toBeInstanceOf(AbortSignal);
    await click("病娇-人物");
    expect(pageReads.at(-1)).toMatchObject({ page: 1, folderId: "people", uncategorized: false });
    expect(document.querySelector(".asset-picker-grid")!.textContent).toContain("人物-1");
    await click("人物-1", ".asset-picker-card-action");
    await click("下一页");
    expect(pageReads.at(-1)).toMatchObject({ page: 2, folderId: "people" });
    await click("人物-2", ".asset-picker-card-action");
    await click("病娇-场景");
    expect(pageReads.at(-1)).toMatchObject({ page: 1, folderId: "places" });
    await click("场景", ".asset-picker-card-action");
    await click("使用已选素材");
    expect(picked).toEqual(["人物-1", "人物-2", "场景"]);
    expect(pickedItems.filter((item) => picked.includes(item.id)).map((item) => item.asset.folderId)).toEqual(["people", "people", "places"]);
});

test("未分类、空分类和空搜索保持服务端结果，不退回其他分类缓存", async () => {
    await click("未分类");
    expect(pageReads.at(-1)).toMatchObject({ page: 1, uncategorized: true });
    expect(pageReads.at(-1).folderId).toBeUndefined();
    expect(document.querySelector(".asset-picker-grid")!.textContent).toContain("未归类图片");
    await click("空分类");
    expect(pageReads.at(-1).folderId).toBe("empty");
    expect(document.querySelector(".asset-picker-grid")!.textContent).toContain("这个分类还没有素材");
    expect(document.querySelector(".asset-picker-grid")!.textContent).not.toContain(cached.title);
    expect(document.querySelector("[data-total]")!.getAttribute("data-total")).toBe("0");
    await click("病娇-人物");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索素材"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "不存在");
        input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();
    expect(pageReads.at(-1)).toMatchObject({ folderId: "people", query: "不存在" });
    expect(document.querySelector(".asset-picker-grid")!.textContent).not.toContain(cached.title);
});

test("重新打开刷新分类名，账号切换不沿用上一账号的分类", async () => {
    open = false;
    await render();
    folderNames = [{ id: "people", name: "重命名后的人物" }];
    open = true;
    await render();
    expect(sidebar().textContent).toContain("重命名后的人物");
    expect(sidebar().textContent).not.toContain("病娇-人物");
    folderNames = [{ id: "other", name: "另一账号分类" }];
    await act(async () => useUserStore.setState({ user: { id: "user-b", username: "other", displayName: "other", role: "user", status: "active" } }));
    await settle();
    expect(sidebar().textContent).toContain("另一账号分类");
    expect(sidebar().textContent).not.toContain("重命名后的人物");
});

test("远端分类归属覆盖旧缓存中的归属", () => {
    const asset = image("moved", "places");
    expect(remoteAssetToPickerItem(asset, { id: "moved", title: "旧缓存", category: "material", kindLabel: "图片", folderId: "people" }, true).folderId).toBe("places");
});

test("分类读取失败显示重试，并在恢复后正常展示", async () => {
    folderFailure = true;
    await act(async () => useUserStore.setState({ user: { id: "user-c", username: "third", displayName: "third", role: "user", status: "active" } }));
    await settle();
    expect(sidebar().querySelector('[role="alert"]')?.textContent).toContain("分类加载失败");
    folderFailure = false;
    await click("重试");
    expect(sidebar().querySelector('[role="alert"]')).toBeNull();
    expect(sidebar().textContent).toContain("另一账号分类");
});

test("切换到插件来源仍显示插件文件夹，不混入个人分类", async () => {
    await click("素材库", 'button[aria-label^="素材库来源"]');
    await click("插件来源", '[role="menuitem"]');
    expect(sidebar().textContent).toContain("Eagle 文件夹");
    expect(sidebar().textContent).not.toContain("另一账号分类");
    await click("Eagle 文件夹");
    expect(document.querySelector(".asset-picker-grid")!.textContent).toContain("插件图片");
    await click("素材库", 'button[aria-label^="素材库来源"]');
    await click("本地素材", '[role="menuitem"]');
    expect(sidebar().textContent).toContain("另一账号分类");
    expect(sidebar().textContent).not.toContain("Eagle 文件夹");
});
