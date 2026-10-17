import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CanvasNodeData } from "../../src/types/canvas";

class Socket {
    static all: Socket[] = [];
    readyState = 1;
    bufferedAmount = 0;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    constructor() {
        Socket.all.push(this);
    }
    send(value: string) {
        this.sent.push(JSON.parse(value));
    }
    close() {}
    receive(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) });
    }
}
const dom = new Window({ url: "http://localhost/" });
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Element: dom.Element,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    WebSocket: Socket,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CanvasCollaborationLayer } = await import("../../src/components/canvas/canvas-collaboration-layer");
const { subscribeCanvasRealtime } = await import("../../src/services/canvas-realtime");
const { CANVAS_NODE_DRAG_PREVIEW_EVENT, CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT } = await import("../../src/lib/canvas/canvas-live-viewport");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const canvas = document.createElement("div");
    host.append(canvas);
    let reads = 0;
    canvas.getBoundingClientRect = () => {
        reads++;
        return { left: 10, top: 20, width: 800, height: 600, right: 810, bottom: 620, x: 10, y: 20, toJSON: () => ({}) };
    };
    const overlay = document.createElement("div");
    host.append(overlay);
    const containerRef = { current: canvas as unknown as HTMLDivElement };
    const viewportRef = { current: { x: 100, y: -50, k: 0.5 } };
    const nodesRef = { current: [{ id: "node", position: { x: 20, y: 30 }, width: 240, height: 160 }] as CanvasNodeData[] };
    return {
        host,
        canvas,
        overlay,
        containerRef,
        viewportRef,
        nodesRef,
        root: createRoot(overlay),
        get reads() {
            return reads;
        },
    };
}

test("real layer labels each window and follows live pan/zoom without moving document nodes", async () => {
    const f = mount();
    const stop = subscribeCanvasRealtime("canvas", () => {});
    const before = Socket.all.length;
    try {
        await act(async () => f.root.render(<CanvasCollaborationLayer canvasId="canvas" enabled {...f} />));
        expect(Socket.all).toHaveLength(before);
        await act(async () =>
            Socket.all.at(-1)!.receive({
                type: "welcome",
                selfId: "self",
                peers: [
                    { id: "self", number: 1, cursor: null, drag: null, updatedAt: 1 },
                    { id: "one", number: 2, cursor: { x: 200, y: 300 }, drag: [{ id: "node", x: 40, y: 60, width: 240, height: 160 }], updatedAt: 1 },
                    { id: "two", number: 3, cursor: null, drag: null, updatedAt: 1 },
                ],
            }),
        );
        flushFrames();
        expect(f.overlay.textContent).toContain("此窗口");
        expect(f.overlay.textContent).toContain("设备1");
        expect(f.overlay.textContent).toContain("设备2");
        const cursor = f.overlay.querySelector('[data-peer-label="设备2"]') as HTMLElement;
        expect(cursor.style.transform).toBe("translate3d(200px, 100px, 0)");
        expect((f.overlay.querySelector(".canvas-collaboration-drag") as HTMLElement).style.width).toBe("120px");
        await act(async () => f.canvas.dispatchEvent(new dom.CustomEvent(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: { x: 0, y: 10, k: 1.5 } })));
        flushFrames();
        expect(cursor.style.transform).toBe("translate3d(300px, 460px, 0)");
        expect(f.nodesRef.current[0].position).toEqual({ x: 20, y: 30 });
    } finally {
        await act(async () => f.root.unmount());
        stop();
        f.host.remove();
    }
});

test("real pointer/drag events broadcast world coordinates and blur clears presence", async () => {
    const f = mount();
    try {
        await act(async () => f.root.render(<CanvasCollaborationLayer canvasId="other" enabled {...f} />));
        const socket = Socket.all.at(-1)!;
        await act(async () =>
            socket.receive({
                type: "welcome",
                selfId: "self",
                peers: [
                    { id: "self", number: 1, cursor: null, drag: null, updatedAt: 1 },
                    { id: "remote", number: 2, cursor: null, drag: null, updatedAt: 1 },
                ],
            }),
        );
        await act(async () => {
            f.canvas.dispatchEvent(new dom.PointerEvent("pointermove", { clientX: 210, clientY: 120, bubbles: true }));
            f.canvas.dispatchEvent(new dom.CustomEvent(CANVAS_NODE_DRAG_PREVIEW_EVENT, { detail: { x: 50, y: -10, nodeIds: new Set(["node"]) } }));
            await new Promise((resolve) => setTimeout(resolve, 60));
        });
        expect(socket.sent.at(-1).cursor).toEqual({ x: 200, y: 300 });
        expect(socket.sent.at(-1).drag[0]).toEqual({ id: "node", x: 70, y: 20, width: 240, height: 160 });
        await act(async () => dom.dispatchEvent(new dom.Event("blur")));
        expect(socket.sent.at(-1)).toEqual({ type: "presence", cursor: null, drag: null });
    } finally {
        await act(async () => f.root.unmount());
        f.host.remove();
    }
});

test("one remaining device removes all labels and stops pointer and viewport work", async () => {
    const f = mount();
    try {
        await act(async () => f.root.render(<CanvasCollaborationLayer canvasId="solo" enabled {...f} />));
        const socket = Socket.all.at(-1)!;
        const self = { id: "self", number: 1, cursor: null, drag: null, updatedAt: 1 };
        await act(async () => socket.receive({ type: "welcome", selfId: "self", peers: [self] }));
        const sent = socket.sent.length;
        for (let i = 0; i < 100; i++) {
            f.canvas.dispatchEvent(new dom.PointerEvent("pointermove", { clientX: i, clientY: 100, bubbles: true }));
            f.canvas.dispatchEvent(new dom.CustomEvent(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: { x: i, y: 0, k: 1 } }));
        }
        flushFrames();
        expect(f.reads).toBe(0);
        expect(socket.sent).toHaveLength(sent);
        expect(f.overlay.textContent).toBe("");
        await act(async () => socket.receive({ type: "peer", peer: { ...self, id: "other", number: 2, cursor: { x: 0, y: 0 } } }));
        flushFrames();
        expect(f.overlay.querySelector("summary")?.textContent).toBe("2 设备在线");
        expect(f.overlay.querySelector('[data-peer-label="当前设备"]')).toBeNull();
        await act(async () => socket.receive({ type: "leave", peerId: "other" }));
        flushFrames();
        expect(f.overlay.querySelector(".canvas-collaboration-members")).toBeNull();
        expect(f.overlay.querySelector(".canvas-collaboration-cursor")).toBeNull();
        const reads = f.reads;
        f.canvas.dispatchEvent(new dom.PointerEvent("pointermove", { clientX: 300, clientY: 100, bubbles: true }));
        expect(f.reads).toBe(reads);
        expect(frames.size).toBe(0);
    } finally {
        await act(async () => f.root.unmount());
        f.host.remove();
    }
});

test("high frequency presence and viewport frames reuse graphics without React commits or layout reads", async () => {
    const f = mount();
    let commits = 0;
    try {
        await act(async () =>
            f.root.render(
                <Profiler id="collaboration" onRender={() => commits++}>
                    <CanvasCollaborationLayer canvasId="performance" enabled {...f} />
                </Profiler>,
            ),
        );
        const socket = Socket.all.at(-1)!;
        const remote = { id: "remote", number: 2, cursor: { x: 100, y: 100 }, drag: [{ id: "node", x: 0, y: 0, width: 100, height: 100 }], updatedAt: 1 };
        await act(async () => socket.receive({ type: "welcome", selfId: "self", peers: [{ id: "self", number: 1, cursor: null, drag: null, updatedAt: 1 }, remote] }));
        flushFrames();
        const cursor = f.overlay.querySelector(".canvas-collaboration-cursor");
        const outline = f.overlay.querySelector(".canvas-collaboration-drag");
        const initialCommits = commits,
            initialReads = f.reads;
        await act(async () => {
            for (let i = 0; i < 100; i++) {
                socket.receive({ type: "peer", peer: { ...remote, cursor: { x: i, y: 100 }, drag: [{ ...remote.drag[0], x: i }] } });
                f.canvas.dispatchEvent(new dom.PointerEvent("pointermove", { clientX: i, clientY: 100, bubbles: true }));
                f.canvas.dispatchEvent(new dom.CustomEvent(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: { x: i, y: 0, k: 1 } }));
                flushFrames();
            }
        });
        expect(commits).toBe(initialCommits);
        expect(f.reads).toBe(initialReads);
        expect(f.overlay.querySelector(".canvas-collaboration-cursor")).toBe(cursor);
        expect(f.overlay.querySelector(".canvas-collaboration-drag")).toBe(outline);
        expect((cursor as HTMLElement).style.transform).toBe("translate3d(198px, 100px, 0)");
        await act(async () => socket.receive({ type: "peer", peer: { ...remote, cursor: null, drag: null } }));
        flushFrames();
        expect((cursor as HTMLElement).hidden).toBe(true);
        expect(f.overlay.querySelector(".canvas-collaboration-drag")).toBeNull();
    } finally {
        await act(async () => f.root.unmount());
        f.host.remove();
    }
});

test("both windows keep the same server numbers and only mark their own row as this window", async () => {
    const a = mount(),
        b = mount();
    try {
        await act(async () => {
            a.root.render(<CanvasCollaborationLayer canvasId="identity-a" enabled {...a} />);
            b.root.render(<CanvasCollaborationLayer canvasId="identity-b" enabled {...b} />);
        });
        const sockets = Socket.all.slice(-2);
        const peers = [
            { id: "a", number: 1, cursor: { x: 10, y: 200 }, drag: null, updatedAt: 1 },
            { id: "b", number: 2, cursor: { x: 20, y: 200 }, drag: null, updatedAt: 1 },
        ];
        await act(async () => {
            sockets[0].receive({ type: "welcome", selfId: "a", peers });
            sockets[1].receive({ type: "welcome", selfId: "b", peers: [...peers].reverse() });
        });
        flushFrames();
        const rows = (f: ReturnType<typeof mount>) => [...f.overlay.querySelectorAll("li")].map((row) => ({ number: row.getAttribute("data-device-number"), label: row.children[1].textContent, self: row.querySelector("small")?.textContent === "此窗口" }));
        expect(rows(a)).toEqual([
            { number: "1", label: "设备1", self: true },
            { number: "2", label: "设备2", self: false },
        ]);
        expect(rows(b)).toEqual([
            { number: "1", label: "设备1", self: false },
            { number: "2", label: "设备2", self: true },
        ]);
        expect(a.overlay.querySelector("[data-peer-label]")?.getAttribute("data-peer-label")).toBe("设备2");
        expect(b.overlay.querySelector("[data-peer-label]")?.getAttribute("data-peer-label")).toBe("设备1");
    } finally {
        await act(async () => {
            a.root.unmount();
            b.root.unmount();
        });
        a.host.remove();
        b.host.remove();
    }
});
