import { expect, test } from "bun:test";
import { rebaseCanvasLocalEdits } from "../src/lib/canvas/canvas-sync-rebase";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

const project = (): CanvasProject => ({
    id: "canvas", title: "Canvas", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    nodes: [{ id: "node", type: "text", title: "Text", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "Original", prompt: "Original prompt" } }] as CanvasProject["nodes"],
    connections: [], viewport: { x: 0, y: 0, k: 1 },
});

test("concurrent authored text retains both inputs while unrelated cloud fields merge", () => {
    const base = project();
    const remote = structuredClone(base);
    remote.revision = 2;
    remote.nodes[0]!.title = "Cloud title";
    remote.nodes[0]!.height = 200;
    remote.nodes[0]!.metadata!.content = "Cloud text";
    const local = structuredClone(base);
    local.nodes[0]!.title = "Current title";
    local.nodes[0]!.position.x = 50;
    local.nodes[0]!.metadata!.content = "Current text";
    const merged = rebaseCanvasLocalEdits(base, remote, local);
    expect(merged.nodes[0]).toMatchObject({ title: "Cloud titleCurrent title", position: { x: 50 }, height: 200, metadata: { content: "Cloud textCurrent text" } });
    expect(merged.revision).toBe(2);
    expect(remote.nodes[0]!.title).toBe("Cloud title");
});

test("unverified cache preserves same-ID local edits and cloud-only nodes without inferring deletions", () => {
    const remote = project();
    remote.nodes.push({ ...remote.nodes[0]!, id: "cloud-new" });
    const local = project();
    local.nodes[0]!.metadata!.content = "Unsaved text";
    const merged = rebaseCanvasLocalEdits(undefined, remote, local);
    expect(merged.nodes.map((node) => node.id)).toEqual(["node", "cloud-new"]);
    expect(merged.nodes[0]!.metadata!.content).toBe("Unsaved text");
    expect(rebaseCanvasLocalEdits(undefined, remote, { ...local, nodes: [] }).nodes).toHaveLength(2);
});

test("explicit local deletion keeps cloud additions, and cloud deletion never resurrects a late edit", () => {
    const base = project();
    const remote = project();
    remote.nodes.push({ ...remote.nodes[0]!, id: "cloud-new" });
    expect(rebaseCanvasLocalEdits(base, remote, { ...base, nodes: [] }).nodes.map((node) => node.id)).toEqual(["cloud-new"]);
    const local = project();
    local.nodes[0]!.title = "Late rename";
    local.connections = [{ id: "link", fromNodeId: "node", toNodeId: "node" }] as CanvasProject["connections"];
    expect(rebaseCanvasLocalEdits(base, { ...base, nodes: [] }, local)).toMatchObject({ nodes: [], connections: [] });
});

test("remote task replacement keeps its binding and media while retaining authored prompt and title", () => {
    const base = project();
    base.nodes[0]!.metadata = { taskId: "old-task", content: "old result", prompt: "Original" };
    const remote = structuredClone(base);
    remote.nodes[0]!.metadata = { taskId: "new-task", taskStatus: "succeeded", content: "new result", storageKey: "resource:new", assetId: "new-asset", prompt: "Original" };
    const local = structuredClone(base);
    local.nodes[0]!.title = "Current title";
    local.nodes[0]!.metadata!.prompt = "Current prompt";
    local.nodes[0]!.metadata!.content = "stale observer result";
    expect(rebaseCanvasLocalEdits(base, remote, local).nodes[0]).toMatchObject({ title: "Current title", metadata: { taskId: "new-task", taskStatus: "succeeded", content: "new result", assetId: "new-asset", prompt: "Current prompt" } });
});

test("undefined matches absent JSON fields and remote snapshots are not mutated", () => {
    const base = project();
    const remote = project();
    remote.nodes[0]!.title = "Cloud title";
    const local = structuredClone(base);
    local.nodes[0]!.metadata!.taskId = undefined;
    const before = structuredClone(remote);
    expect(rebaseCanvasLocalEdits(base, remote, local).nodes[0]!.title).toBe("Cloud title");
    expect(remote).toEqual(before);
});
