import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, Element: dom.Element, Node: dom.Node, Text: dom.Text, SVGElement: dom.SVGElement, getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CanvasResourceMentionTextarea } = await import("../../src/components/canvas/canvas-resource-mention-textarea");
const { CanvasTextLeaseIndicator } = await import("../../src/components/canvas/use-canvas-text-lease");
const { canvasEditLeases } = await import("../../src/services/canvas-edit-leases");

afterAll(() => {
    dom.happyDOM.abort(); canvasEditLeases.reset();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("真实提示词组件在中文组词期间接收远端更新，组词完成后保留两端文字且光标跟随", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const writes: string[] = [];
    const render = (value: string) => root.render(<CanvasResourceMentionTextarea value={value} references={[]} onChange={(next) => { writes.push(next); render(next); }} aria-label="prompt" />);
    try {
        await act(async () => render("场景："));
        const textarea = host.querySelector("textarea")!;
        textarea.focus();
        await act(async () => textarea.dispatchEvent(new dom.CompositionEvent("compositionstart", { bubbles: true })));
        await act(async () => {
            Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "场景：乙");
            textarea.setSelectionRange(4, 4);
            textarea.dispatchEvent(new dom.InputEvent("input", { bubbles: true, isComposing: true, data: "乙" }));
        });
        await act(async () => render("场景：甲"));
        expect(textarea.value).toBe("场景：乙");
        expect(writes).toEqual([]);
        await act(async () => textarea.dispatchEvent(new dom.CompositionEvent("compositionend", { bubbles: true, data: "乙" })));
        expect(textarea.value).toBe("场景：甲乙");
        expect(writes).toEqual(["场景：甲乙"]);
        expect(textarea.selectionStart).toBe(5);
        expect(textarea.readOnly).toBe(false);
    } finally { await act(async () => root.unmount()); host.remove(); }
});

test("租约争抢只有输入状态，不渲染报错、草稿恢复或手动重试按钮", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    canvasEditLeases.status("canvas", { revision: 1, serverTime: new Date().toISOString(), leases: [{ nodeId: "node", sessionId: "other-device", expiresAt: new Date(Date.now() + 30000).toISOString() }] });
    try {
        await act(async () => root.render(<CanvasTextLeaseIndicator nodeId="node" canvasId="canvas" />));
        expect(host.textContent).toContain("其他窗口正在输入");
        expect(host.querySelector("button")).toBeNull();
        expect(host.textContent).not.toContain("草稿待同步");
        expect(host.textContent).not.toContain("失败");
        expect(host.textContent).not.toContain("重试");
    } finally { await act(async () => root.unmount()); host.remove(); }
});
