import { expect, test } from "bun:test";
import { canvasRealtimeURL, createCanvasRealtimeClient, type CanvasRealtimeSnapshot } from "../src/services/canvas-realtime-client";

class Socket {
    readyState = 1;
    bufferedAmount = 0;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    send(value: string) {
        this.sent.push(JSON.parse(value));
    }
    close() {
        this.onclose?.({ code: 1006 });
    }
    receive(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) });
    }
}

function fixture() {
    let now = 0,
        sequence = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const sockets: Socket[] = [];
    const events: string[] = [];
    let state: CanvasRealtimeSnapshot = { connected: false, selfId: null, peers: [] };
    const client = createCanvasRealtimeClient({
        url: "ws://localhost/api/canvas-projects/canvas/realtime",
        socket: () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
        now: () => now,
        random: () => 0.5,
        schedule: (callback, delay) => {
            const id = ++sequence;
            timers.set(id, { at: now + delay, callback });
            return id as unknown as ReturnType<typeof setTimeout>;
        },
        clear: (timer) => {
            timers.delete(timer as unknown as number);
        },
    });
    client.subscribe((snapshot, event) => {
        state = snapshot;
        events.push(event);
    });
    return {
        client,
        sockets,
        events,
        get state() {
            return state;
        },
        welcome(id = "self") {
            sockets.at(-1)!.receive({ type: "welcome", selfId: id, peers: [{ id, number: 1, cursor: null, drag: null, updatedAt: now }] });
        },
        advance(ms: number) {
            const until = now + ms;
            for (;;) {
                const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
            }
            now = until;
        },
    };
}

test("realtime URL follows API deployment path, HTTPS and encoded canvas identity", () => {
    expect(canvasRealtimeURL("/api", "a/b", "https://canvas.example/canvas/a")).toBe("wss://canvas.example/api/canvas-projects/a%2Fb/realtime");
    expect(canvasRealtimeURL("https://api.example/custom/", "canvas", "https://canvas.example")).toBe("wss://api.example/custom/canvas-projects/canvas/realtime");
});

test("presence coalesces rapid pointer and drag frames, retaining final coordinates", () => {
    const f = fixture();
    f.welcome();
    f.sockets[0].sent = [];
    for (let i = 0; i < 20; i++) f.client.update({ x: i, y: -i }, [{ id: "node", x: i * 10, y: 0, width: 240, height: 160 }]);
    expect(f.sockets[0].sent).toHaveLength(0);
    f.advance(50);
    expect(f.sockets[0].sent).toHaveLength(1);
    expect(f.sockets[0].sent[0].cursor).toEqual({ x: 19, y: -19 });
    expect(f.sockets[0].sent[0].drag[0].x).toBe(190);
    f.client.update(null, null, true);
    expect(f.sockets[0].sent.at(-1).drag).toBeNull();
    f.client.close();
});

test("congested transport eventually delivers the final drag cancellation", () => {
    const f = fixture();
    f.welcome();
    f.sockets[0].bufferedAmount = 40000;
    f.client.update(null, null, true);
    f.advance(100);
    f.sockets[0].bufferedAmount = 0;
    f.advance(50);
    expect(f.sockets[0].sent.at(-1)).toEqual({ type: "presence", cursor: null, drag: null });
    f.client.close();
});

test("outgoing presence does not echo into subscribers and identical state is not resent", () => {
    const f = fixture();
    f.welcome();
    const events = f.events.length;
    f.client.update({ x: 10, y: 20 }, null);
    f.advance(50);
    const sent = f.sockets[0].sent.length;
    for (let i = 0; i < 100; i++) f.client.update({ x: 10, y: 20 }, null);
    f.advance(50);
    expect(f.sockets[0].sent).toHaveLength(sent);
    expect(f.events).toHaveLength(events);
    f.client.close();
});

test("disconnect clears peers and reconnect invalidates the document; policy denial stops retries", () => {
    const f = fixture();
    f.welcome();
    f.sockets[0].receive({ type: "peer", peer: { id: "remote", number: 2, cursor: { x: 1, y: 2 }, drag: null, updatedAt: 0 } });
    expect(f.state.peers).toHaveLength(2);
    f.sockets[0].close();
    expect(f.state.connected).toBe(false);
    expect(f.state.peers).toHaveLength(0);
    f.advance(500);
    expect(f.sockets).toHaveLength(2);
    f.welcome("reconnected");
    expect(f.events.filter((event) => event === "invalidate")).toHaveLength(2);
    f.sockets[1].onclose?.({ code: 1008 });
    f.advance(60000);
    expect(f.sockets).toHaveLength(2);
    f.client.close();
});

test("leave removes ghosts and malformed remote coordinates cannot enter the renderer", () => {
    const f = fixture();
    f.welcome();
    f.sockets[0].receive({ type: "peer", peer: { id: "invalid", number: 2, cursor: { x: "NaN", y: 2 }, drag: null, updatedAt: 0 } });
    expect(f.state.peers).toHaveLength(1);
    f.sockets[0].receive({ type: "peer", peer: { id: "remote", number: 2, cursor: { x: 1, y: 2 }, drag: null, updatedAt: 0 } });
    f.sockets[0].receive({ type: "leave", peerId: "remote" });
    expect(f.state.peers.map((peer) => peer.id)).toEqual(["self"]);
    f.client.close();
});
