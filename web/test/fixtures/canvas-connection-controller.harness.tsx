import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CanvasNodeData, CanvasConnection } from "../../src/types/canvas";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("antd");
const { useCanvasConnectionController } = await import("../../src/pages/canvas/use-canvas-connection-controller");
const { CanvasConnectionDrafts } = await import("../../src/components/canvas/canvas-connection-drafts");
const { defaultConfig } = await import("../../src/stores/use-config-store");
const { canvasThemes } = await import("../../src/lib/canvas-theme");
const { CanvasNodeType } = await import("../../src/types/canvas");
const { CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT } = await import("../../src/lib/canvas/canvas-live-viewport");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const noop = () => {};
const nodes: CanvasNodeData[] = [
    { id: "source", title: "来源", type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 100, height: 100 },
    { id: "front", title: "前景", type: CanvasNodeType.Text, position: { x: 300, y: 0 }, width: 200, height: 200 },
    { id: "back", title: "后景", type: CanvasNodeType.Text, position: { x: 300, y: 0 }, width: 200, height: 200 },
];

async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let controller!: ReturnType<typeof useCanvasConnectionController>;
    let edges: CanvasConnection[] = [];
    let hit: Element | null = null;
    const originalHit = document.elementFromPoint;
    document.elementFromPoint = () => hit;
    function Harness() {
        const [items, setNodes] = useState(nodes);
        const [connections, setConnections] = useState<CanvasConnection[]>([]);
        const nodesRef = useRef(items);
        nodesRef.current = items;
        const connectionsRef = useRef(connections);
        connectionsRef.current = connections;
        const viewportRef = useRef({ x: 0, y: 0, k: 1 });
        const containerRef = useRef<HTMLDivElement>(null);
        edges = connections;
        controller = useCanvasConnectionController({
            projectId: "test",
            config: defaultConfig,
            defaultDrawingEngine: "excalidraw",
            nodesRef,
            connectionsRef,
            viewportRef,
            scriptScrollTopById: {},
            screenToCanvas: (x, y) => ({ x, y }),
            setNodes,
            setConnections,
            setSelectedNodeIds: noop,
            setSelectedConnectionId: noop,
            setContextMenu: noop,
            setDialogNodeId: noop,
            setDrawingNodeId: noop,
        });
        return (
            <div ref={containerRef}>
                <button onPointerDown={(event) => controller.handleConnectStart(event, "source", "source")}>start</button>
                <button onPointerDown={(event) => controller.startBatchConnection(event, ["source"])}>batch</button>
                {items.map((node) => (
                    <div key={node.id} className="node-element" data-node-id={node.id}>
                        <span>{node.title}</span>
                    </div>
                ))}
                <CanvasConnectionDrafts
                    containerRef={containerRef}
                    viewport={viewportRef.current}
                    theme={canvasThemes.dark}
                    connectingParams={controller.connectingParams}
                    batchConnectionPreview={controller.batchConnectionPreview}
                    mouseWorld={controller.mouseWorld}
                    nodeById={new Map(items.map((node) => [node.id, node]))}
                    scriptScrollTopById={{}}
                />
            </div>
        );
    }
    await act(async () =>
        root.render(
            <App>
                <Harness />
            </App>,
        ),
    );
    const event = (type: string, x: number, y: number) => new dom.PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y, button: 0 });
    return {
        host,
        controller: () => controller,
        edges: () => edges,
        hit: (id: string | null) => {
            hit = id ? host.querySelector(`[data-node-id="${id}"] span`) : null;
        },
        start: async (batch = false) => {
            await act(async () => host.querySelectorAll("button")[batch ? 1 : 0].dispatchEvent(event("pointerdown", 100, 50)));
        },
        pointer: async (type: string, x = 400, y = 100) => {
            await act(async () => {
                window.dispatchEvent(event(type, x, y));
                if (type === "pointermove") await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            });
        },
        dispose: async () => {
            await act(async () => root.unmount());
            document.elementFromPoint = originalHit;
            host.remove();
        },
    };
}

for (const batch of [false, true]) {
    test(`${batch ? "批量" : "普通"}连接只在释放时提交到可见前景节点`, async () => {
        const h = await mount();
        try {
            await h.start(batch);
            h.hit("front");
            await h.pointer("pointermove");
            expect(h.edges()).toHaveLength(0);
            expect(batch ? h.controller().batchConnectionPreview?.targetNodeId : h.controller().connectionTargetNodeId).toBe("front");
            const draft = h.host.querySelector("[data-canvas-connection-drafts]")!;
            const base = draft.querySelector("path")!;
            const beam = draft.querySelector("[data-connection-beam]")!;
            expect(base.parentElement === beam.parentElement).toBe(true);
            expect(base.nextElementSibling === beam).toBe(true);
            expect(base.getAttribute("d")).toEndWith("400 100");
            draft.parentElement!.dispatchEvent(new dom.CustomEvent(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: { x: 80, y: 40, k: 0.5 } }));
            expect((draft.firstElementChild as HTMLElement).style.transform).toBe("translate3d(80px, 40px, 0) scale(0.5)");
            await h.pointer("pointerup");
            expect(h.edges()).toHaveLength(1);
            expect(h.edges()[0].toNodeId).toBe("front");
            expect(h.host.querySelector("[data-canvas-connection-drafts]") === null).toBe(true);
        } finally {
            await h.dispose();
        }
    });
}

test("无效可见主体不穿透也不打开新增菜单", async () => {
    const h = await mount();
    try {
        await h.start();
        h.hit("source");
        await h.pointer("pointermove");
        await h.pointer("pointerup");
        expect(h.edges()).toHaveLength(0);
        expect(h.controller().pendingConnectionCreate).toBeNull();
        expect(h.controller().connectingParams).toBeNull();
    } finally {
        await h.dispose();
    }
});

test("取消不提交连线，空白处释放仍可新增", async () => {
    const h = await mount();
    try {
        await h.start();
        h.hit("front");
        await h.pointer("pointermove");
        await h.pointer("pointercancel");
        expect(h.edges()).toHaveLength(0);
        expect(h.host.querySelector("[data-canvas-connection-drafts]") === null).toBe(true);
        await h.start();
        h.hit(null);
        await h.pointer("pointerup", 900, 900);
        expect(h.edges()).toHaveLength(0);
        expect(h.controller().pendingConnectionCreate).not.toBeNull();
    } finally {
        await h.dispose();
    }
});
