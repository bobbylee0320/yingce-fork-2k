import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window();
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCanvasConnectionTilt } = await import("../../src/components/canvas/use-canvas-connection-tilt");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("captured pointers track the flat bounds, coalesce frames, respect motion settings and stop on exit", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    window.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    window.cancelAnimationFrame = (id) => {
        frames.delete(id);
    };
    const preferenceListeners = new Set<() => void>();
    const preference = {
        matches: false,
        addEventListener: (_event: string, listener: () => void) => {
            preferenceListeners.add(listener);
        },
        removeEventListener: (_event: string, listener: () => void) => {
            preferenceListeners.delete(listener);
        },
    };
    window.matchMedia = (() => preference as unknown as MediaQueryList) as typeof window.matchMedia;
    const setReducedMotion = (matches: boolean) => {
        preference.matches = matches;
        for (const listener of preferenceListeners) listener();
    };
    let renders = 0;
    function Harness({ active }: { active: boolean }) {
        renders++;
        const node = useRef<HTMLDivElement>(null);
        const shell = useRef<HTMLDivElement>(null);
        useCanvasConnectionTilt(node, shell, active ? { rotateX: 0, rotateY: -8, glareX: "0%", glareY: "50%" } : undefined);
        return (
            <div ref={node}>
                <div ref={shell} />
            </div>
        );
    }
    const move = (x: number, y: number) => window.dispatchEvent(new dom.PointerEvent("pointermove", { clientX: x, clientY: y, isPrimary: true }) as unknown as PointerEvent);
    const flush = () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(16));
    };
    try {
        setReducedMotion(true);
        await act(async () => root.render(<Harness active />));
        const node = host.firstElementChild as HTMLElement;
        const shell = node.firstElementChild as HTMLElement;
        // A half-scale node: measure its stable screen bounds, not the tilted shell.
        node.getBoundingClientRect = () => ({ left: 100, top: 200, width: 200, height: 100 }) as DOMRect;
        expect(shell.style.getPropertyValue("--connection-tilt-x")).toBe("");
        expect(shell.style.getPropertyValue("--connection-glare-x")).toBe("");
        setReducedMotion(false);
        expect(shell.style.getPropertyValue("--connection-tilt-x")).toBe("0deg");
        const before = renders;
        move(100, 200);
        move(300, 300);
        expect(frames.size).toBe(1);
        flush();
        expect(shell.style.getPropertyValue("--connection-tilt-x")).toBe("-8deg");
        expect(shell.style.getPropertyValue("--connection-tilt-y")).toBe("8deg");
        expect(shell.style.getPropertyValue("--connection-glare-x")).toBe("100%");
        expect(renders).toBe(before);
        setReducedMotion(true);
        expect(shell.style.getPropertyValue("--connection-tilt-x")).toBe("");
        expect(shell.style.getPropertyValue("--connection-glare-x")).toBe("");
        move(100, 200);
        expect(frames.size).toBe(0);
        setReducedMotion(false);
        expect(frames.size).toBe(1);
        flush();
        expect(shell.style.getPropertyValue("--connection-tilt-x")).not.toBe("");
        host.className = "no-motion";
        move(100, 200);
        expect(frames.size).toBe(0);
        host.className = "";
        move(100, 200);
        await act(async () => root.render(<Harness active={false} />));
        expect(frames.size).toBe(0);
        expect(shell.style.getPropertyValue("--connection-tilt-x")).toBe("");
        move(300, 300);
        expect(frames.size).toBe(0);
        await act(async () => root.render(<Harness active />));
        move(100, 200);
        await act(async () => root.unmount());
        expect(frames.size).toBe(0);
        move(300, 300);
        expect(frames.size).toBe(0);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
