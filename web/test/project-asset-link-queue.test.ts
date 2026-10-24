import { describe, expect, test } from "bun:test";

import { createCanvasProjectAssetLinkQueue } from "../src/lib/canvas/project-asset-link-queue";

function createStorage() {
    const values = new Map<string, string>();
    return {
        values,
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: string) => {
            values.set(key, value);
        },
        removeItem: async (key: string) => {
            values.delete(key);
        },
    };
}

describe("canvas project asset link queue", () => {
    test("persists pending links and reloads them in a fresh queue instance", async () => {
        const storage = createStorage();
        const first = createCanvasProjectAssetLinkQueue(storage, "pending-links");

        await first.upsert({ assetId: "asset-1", domainProjectId: "project-1", category: "character", folderId: "folder-1" });

        const restored = createCanvasProjectAssetLinkQueue(storage, "pending-links");
        expect(await restored.list()).toEqual([
            {
                assetId: "asset-1",
                domainProjectId: "project-1",
                category: "character",
                folderId: "folder-1",
                attempts: 0,
                nextAttemptAt: 0,
                revision: 1,
            },
        ]);
    });

    test("deduplicates a link and ignores stale retry completion after the request changes", async () => {
        const storage = createStorage();
        const queue = createCanvasProjectAssetLinkQueue(storage, "pending-links");
        const original = await queue.upsert({ assetId: "asset-1", domainProjectId: "project-1" });
        const duplicate = await queue.upsert({ assetId: "asset-1", domainProjectId: "project-1" });
        const changed = await queue.upsert({ assetId: "asset-1", domainProjectId: "project-1", folderId: "folder-2" });

        expect(duplicate).toEqual(original);
        expect(await queue.update(original, { attempts: 1, nextAttemptAt: Date.now() + 10_000 })).toBeUndefined();
        expect(await queue.remove(original)).toBe(false);
        expect(changed.revision).toBe(original.revision + 1);
        expect(await queue.list()).toEqual([changed]);
    });

    test("removes a confirmed link", async () => {
        const storage = createStorage();
        const queue = createCanvasProjectAssetLinkQueue(storage, "pending-links");
        const entry = await queue.upsert({ assetId: "asset-1", domainProjectId: "project-1" });

        expect(await queue.remove(entry)).toBe(true);
        expect(await queue.list()).toEqual([]);
        expect(storage.values.has("pending-links")).toBe(false);
    });

    test("preserves malformed recovery data instead of overwriting it", async () => {
        const storage = createStorage();
        storage.values.set("pending-links", "not-json");
        const queue = createCanvasProjectAssetLinkQueue(storage, "pending-links");

        await expect(queue.list()).rejects.toThrow("项目资产待同步记录已损坏");
        expect(storage.values.get("pending-links")).toBe("not-json");
    });
});
