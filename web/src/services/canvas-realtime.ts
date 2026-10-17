import { apiBaseURL } from "@/services/api/request";
import { getActiveUserScope } from "@/lib/user-scope";
import { canvasRealtimeURL, createCanvasRealtimeClient, type CanvasRealtimeEvent, type CanvasRealtimeSnapshot, type PresenceNode, type PresencePoint } from "./canvas-realtime-client";

const clients = new Map<string, { client: ReturnType<typeof createCanvasRealtimeClient>; consumers: number }>();
const keyFor = (canvasId: string) => JSON.stringify([getActiveUserScope(), canvasId]);

export function subscribeCanvasRealtime(canvasId: string, listener: (state: CanvasRealtimeSnapshot, event: CanvasRealtimeEvent) => void) {
    const key = keyFor(canvasId);
    const scope = getActiveUserScope();
    let entry = clients.get(key);
    if (!entry) {
        entry = { client: createCanvasRealtimeClient({ url: canvasRealtimeURL(apiBaseURL, canvasId, window.location.href) }), consumers: 0 };
        clients.set(key, entry);
    }
    entry.consumers++;
    const unsubscribe = entry.client.subscribe((state, event) => {
        if (scope === getActiveUserScope()) listener(state, event);
        else {
            entry.client.close();
            clients.delete(key);
        }
    });
    return () => {
        unsubscribe();
        if (--entry.consumers === 0) {
            entry.client.close();
            clients.delete(key);
        }
    };
}

export function updateCanvasPresence(canvasId: string, cursor: PresencePoint | null, drag: PresenceNode[] | null, immediate = false) {
    clients.get(keyFor(canvasId))?.client.update(cursor, drag, immediate);
}
