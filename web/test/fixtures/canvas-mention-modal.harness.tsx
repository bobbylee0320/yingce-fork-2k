import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CanvasResourceReference } from "../../src/lib/canvas/canvas-resource-references";

const dom = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "Element", "Node", "HTMLElement", "HTMLTextAreaElement", "MutationObserver", "ResizeObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : dom[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom) });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MentionMenu } = await import("../../src/components/canvas/canvas-mention-menu");
afterAll(() => dom.happyDOM.abort());

for (const inModal of [true, false]) {
    test(inModal ? "放大弹窗保留焦点边界、搜索和资产点击" : "普通编辑仍使用 body Portal", async () => {
        const host = document.createElement("div");
        const container = document.createElement("div");
        container.className = inModal ? "ant-modal" : "inline-editor";
        container.style.pointerEvents = "none";
        const anchor = document.createElement("textarea");
        container.append(anchor);
        document.body.append(host, container);
        const root = createRoot(host);
        const reference: CanvasResourceReference = { id: "asset-1", nodeId: "asset-1", kind: "image", label: "图片1", title: "角色参考", active: true };
        const selected: string[] = [];
        let query = "";
        try {
            await act(async () => root.render(<MentionMenu anchor={anchor} connectedReferences={[reference]} assetReferences={[]} filteredReferences={[reference]} query="" cursorOffset={0} preferredWidth={320} onQueryChange={(value) => { query = value; }} onClose={() => {}} onSelect={(item) => selected.push(item.id)} />));
            const menu = document.querySelector<HTMLElement>("[data-canvas-resource-mention-menu]")!;
            expect(menu.parentElement).toBe(inModal ? container : document.body);
            expect(menu.classList.contains("pointer-events-auto")).toBe(true);
            const search = menu.querySelector("input")!;
            search.focus();
            expect(document.activeElement).toBe(search);
            expect(inModal ? container.contains(document.activeElement) : true).toBe(true);
            await act(async () => {
                Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(search, "角色");
                search.dispatchEvent(new dom.Event("input", { bubbles: true }));
            });
            expect(query).toBe("角色");
            await act(async () => menu.querySelector<HTMLButtonElement>(".canvas-resource-mention-item")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true })));
            expect(selected).toEqual(["asset-1"]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            host.remove();
        }
    });
}
