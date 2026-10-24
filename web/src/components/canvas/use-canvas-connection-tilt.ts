import { useLayoutEffect, type RefObject } from "react";
import { canvasConnectionTilt } from "@/lib/canvas/canvas-connection-tilt";

/** Track captured connection pointers without re-rendering the node's media. */
export function useCanvasConnectionTilt(nodeRef: RefObject<HTMLDivElement | null>, shellRef: RefObject<HTMLDivElement | null>, initial: ReturnType<typeof canvasConnectionTilt>) {
    const active = Boolean(initial);
    const { rotateX = 0, rotateY = 0, glareX = "50%", glareY = "50%" } = initial || {};

    useLayoutEffect(() => {
        const node = nodeRef.current;
        const shell = shellRef.current;
        if (!node || !shell || !active) return;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let frame: number | null = null;
        let pointer: { x: number; y: number } | null = null;
        const write = (tilt: NonNullable<typeof initial>) => {
            shell.style.setProperty("--connection-tilt-x", `${tilt.rotateX}deg`);
            shell.style.setProperty("--connection-tilt-y", `${tilt.rotateY}deg`);
            shell.style.setProperty("--connection-glare-x", tilt.glareX);
            shell.style.setProperty("--connection-glare-y", tilt.glareY);
        };
        const clear = () => {
            shell.style.removeProperty("--connection-tilt-x");
            shell.style.removeProperty("--connection-tilt-y");
            shell.style.removeProperty("--connection-glare-x");
            shell.style.removeProperty("--connection-glare-y");
        };
        const update = () => {
            frame = null;
            if (!pointer) return;
            if (reducedMotion.matches || node.closest(".no-motion")) {
                clear();
                return;
            }
            // Measure the flat outer node: measuring the rotating shell feeds its
            // transformed bounds back into the next angle and causes edge jitter.
            const rect = node.getBoundingClientRect();
            const tilt = canvasConnectionTilt({ position: { x: rect.left, y: rect.top }, width: rect.width, height: rect.height }, pointer);
            if (tilt) write(tilt);
            else clear();
        };
        const syncMotionPreference = () => {
            if (reducedMotion.matches || node.closest(".no-motion")) {
                if (frame !== null) window.cancelAnimationFrame(frame);
                frame = null;
                clear();
                return;
            }
            if (pointer) {
                if (frame === null) frame = window.requestAnimationFrame(update);
                return;
            }
            write({ rotateX, rotateY, glareX, glareY });
        };
        syncMotionPreference();
        const move = (event: PointerEvent) => {
            if (!event.isPrimary) return;
            pointer = { x: event.clientX, y: event.clientY };
            if (reducedMotion.matches || node.closest(".no-motion")) {
                if (frame !== null) window.cancelAnimationFrame(frame);
                frame = null;
                clear();
                return;
            }
            if (frame === null) frame = window.requestAnimationFrame(update);
        };
        window.addEventListener("pointermove", move, { passive: true });
        reducedMotion.addEventListener("change", syncMotionPreference);
        return () => {
            window.removeEventListener("pointermove", move);
            reducedMotion.removeEventListener("change", syncMotionPreference);
            if (frame !== null) window.cancelAnimationFrame(frame);
            clear();
        };
    }, [nodeRef, shellRef, active, rotateX, rotateY, glareX, glareY]);
}
