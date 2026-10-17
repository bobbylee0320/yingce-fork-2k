import { canonicalize } from "json-canonicalize";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { mergeCanvasRichText, mergeCanvasText } from "@/lib/canvas/canvas-text-merge";

const equal = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identified = (items: unknown[]): items is { id: string }[] => items.every((item) => record(item) && typeof item.id === "string");

// Reapply authored fields to a fresh server baseline. Non-text scalar edits
// keep the current editor's value; authored text uses the common baseline below.
// Absence in an unverified cache is never interpreted as a deletion.
function rebaseValue(before: unknown, remote: unknown, local: unknown, verified: boolean): unknown {
    if (verified && equal(before, local)) return remote;
    if (equal(remote, local)) return remote;
    if (record(remote) && record(local)) {
        const base = record(before) ? before : {};
        const result = { ...remote };
        for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
            if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("无效的画布同步字段");
            const value = rebaseValue(base[key], remote[key], local[key], verified);
            if (value === undefined) delete result[key];
            else result[key] = value;
        }
        return result;
    }
    if (Array.isArray(remote) && Array.isArray(local) && identified(remote) && identified(local) && (before === undefined || (Array.isArray(before) && identified(before)))) {
        const base = new Map((Array.isArray(before) ? before : []).map((item) => [item.id, item]));
        const current = new Map(remote.map((item) => [item.id, item]));
        const edited = new Map(local.map((item) => [item.id, item]));
        const baseOrder = [...base.keys()].filter((id) => edited.has(id));
        const localOrder = local.map((item) => item.id).filter((id) => base.has(id));
        const order = verified && !equal(baseOrder, localOrder) ? [...edited.keys(), ...current.keys()] : [...current.keys(), ...edited.keys()];
        return [...new Set(order)].flatMap((id) => {
            const old = base.get(id);
            const incoming = current.get(id);
            const edit = edited.get(id);
            // Never resurrect a server-deleted object through a late edit.
            if (verified && old && (!incoming || !edit)) return [];
            const value = rebaseValue(old, incoming, edit, verified);
            return value === undefined ? [] : [value];
        });
    }
    if (!verified && local === undefined) return remote;
    return local;
}

export function rebaseCanvasLocalEdits(baseline: CanvasProject | undefined, remote: CanvasProject, local: CanvasProject): CanvasProject {
    const merged = { ...rebaseValue(baseline, remote, local, Boolean(baseline)) as CanvasProject };
    const oldNodes = new Map(baseline?.nodes.map((node) => [node.id, node]));
    const remoteNodes = new Map(remote.nodes.map((node) => [node.id, node]));
    const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
    merged.nodes = merged.nodes.map((node) => {
        const old = oldNodes.get(node.id);
        const incoming = remoteNodes.get(node.id);
        if (!incoming) return node;
        const edited = localNodes.get(node.id);
        if (baseline && edited) {
            const text = (before: unknown, other: unknown, current: unknown) => typeof other === "string" && typeof current === "string" && (before === undefined || typeof before === "string") ? mergeCanvasText(before || "", other, current) : current;
            const metadata = { ...node.metadata };
            for (const field of ["prompt", "composerContent", ...(["text", "script", "markdown"].includes(node.type) ? ["content"] : [])] as const) {
                const key = field as "prompt" | "composerContent" | "content";
                if (typeof incoming.metadata?.[key] === "string" && typeof edited.metadata?.[key] === "string") metadata[key] = text(old?.metadata?.[key], incoming.metadata[key], edited.metadata[key]) as string;
            }
            if (metadata.generationSpec && incoming.metadata?.generationSpec && edited.metadata?.generationSpec) {
                metadata.generationSpec = { ...metadata.generationSpec, prompt: text(old?.metadata?.generationSpec?.prompt, incoming.metadata.generationSpec.prompt, edited.metadata.generationSpec.prompt) as string };
            }
            if (["text", "script"].includes(node.type) && incoming.metadata?.richText?.type === "doc" && edited.metadata?.richText?.type === "doc" && !equal(incoming.metadata.richText, edited.metadata.richText)) {
                const base = old?.metadata?.richText;
                const before = base?.type === "doc" ? base : { type: "doc", content: (old?.metadata?.content || "").split("\n").map((line) => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })) };
                Object.assign(metadata, mergeCanvasRichText(before, incoming.metadata.richText, edited.metadata.richText));
            }
            node = { ...node, title: text(old?.title, incoming.title, edited.title) as string, metadata: node.metadata || Object.keys(metadata).length ? metadata : undefined };
        }
        const oldTask = old?.metadata?.taskId;
        const remoteTask = incoming.metadata?.taskId;
        const remoteTime = Date.parse(incoming.metadata?.taskUpdatedAt || "");
        const localTime = Date.parse(node.metadata?.taskUpdatedAt || "");
        if (remoteTask === oldTask && !(remoteTask && remoteTask === node.metadata?.taskId && Number.isFinite(remoteTime) && (!Number.isFinite(localTime) || remoteTime > localTime))) return node;
        // Task bindings/results follow the server; authored title, prompt and
        // geometry still survive a task replacement or newer terminal result.
        const metadata = { ...node.metadata };
        const keys = new Set([...Object.keys(metadata), ...Object.keys(incoming.metadata || {})]);
        for (const key of keys) {
            if (!key.startsWith("task") && !["status", "content", "storageKey", "assetId", "richText"].includes(key)) continue;
            const value = incoming.metadata?.[key as keyof typeof incoming.metadata];
            if (value === undefined) delete (metadata as Record<string, unknown>)[key];
            else (metadata as Record<string, unknown>)[key] = value;
        }
        return { ...node, metadata };
    });
    const ids = new Set(merged.nodes.map((node) => node.id));
    return { ...merged, id: remote.id, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash, viewport: local.viewport, connections: merged.connections.filter((connection) => ids.has(connection.fromNodeId) && ids.has(connection.toNodeId)) };
}
