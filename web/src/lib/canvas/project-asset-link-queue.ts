export type PendingCanvasProjectAssetLink = {
    assetId: string;
    domainProjectId: string;
    category?: string;
    folderId?: string;
    attempts: number;
    nextAttemptAt: number;
    revision: number;
};

export type CanvasProjectAssetLinkRequest = Pick<PendingCanvasProjectAssetLink, "assetId" | "domainProjectId" | "category" | "folderId">;

type Storage = {
    getItem(name: string): string | null | Promise<string | null>;
    setItem(name: string, value: string): unknown;
    removeItem(name: string): unknown;
};

function queueIdentity(entry: Pick<PendingCanvasProjectAssetLink, "assetId" | "domainProjectId">) {
    return `${entry.domainProjectId}\0${entry.assetId}`;
}

function parseQueue(value: string | null): PendingCanvasProjectAssetLink[] {
    if (!value) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("项目资产待同步记录已损坏，原记录已保留");
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => !isQueueEntry(entry))) {
        throw new Error("项目资产待同步记录格式无效，原记录已保留");
    }
    return parsed;
}

function isQueueEntry(value: unknown): value is PendingCanvasProjectAssetLink {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<PendingCanvasProjectAssetLink>;
    return (
        typeof entry.assetId === "string" &&
        Boolean(entry.assetId) &&
        typeof entry.domainProjectId === "string" &&
        Boolean(entry.domainProjectId) &&
        (entry.category === undefined || typeof entry.category === "string") &&
        (entry.folderId === undefined || typeof entry.folderId === "string") &&
        Number.isSafeInteger(entry.attempts) &&
        Number.isFinite(entry.nextAttemptAt) &&
        Number.isSafeInteger(entry.revision)
    );
}

export function createCanvasProjectAssetLinkQueue(storage: Storage, storageKey: string) {
    let tail: Promise<unknown> = Promise.resolve();

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = tail.then(operation, operation);
        tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    async function read() {
        return parseQueue(await storage.getItem(storageKey));
    }

    async function write(entries: PendingCanvasProjectAssetLink[]) {
        if (entries.length) await storage.setItem(storageKey, JSON.stringify(entries));
        else await storage.removeItem(storageKey);
    }

    return {
        list() {
            return serialize(read);
        },
        upsert(request: CanvasProjectAssetLinkRequest) {
            return serialize(async () => {
                const entries = await read();
                const identity = queueIdentity(request);
                const index = entries.findIndex((entry) => queueIdentity(entry) === identity);
                const current = index >= 0 ? entries[index] : undefined;
                const sameRequest = current && current.category === request.category && current.folderId === request.folderId;
                if (sameRequest) return current;
                const next: PendingCanvasProjectAssetLink = {
                    ...request,
                    attempts: 0,
                    nextAttemptAt: 0,
                    revision: (current?.revision || 0) + 1,
                };
                if (index >= 0) entries[index] = next;
                else entries.push(next);
                await write(entries);
                return next;
            });
        },
        update(entry: PendingCanvasProjectAssetLink, changes: Pick<PendingCanvasProjectAssetLink, "attempts" | "nextAttemptAt">) {
            return serialize(async () => {
                const entries = await read();
                const index = entries.findIndex((candidate) => queueIdentity(candidate) === queueIdentity(entry) && candidate.revision === entry.revision);
                if (index < 0) return undefined;
                const next = { ...entries[index], ...changes, revision: entries[index].revision + 1 };
                entries[index] = next;
                await write(entries);
                return next;
            });
        },
        remove(entry: PendingCanvasProjectAssetLink) {
            return serialize(async () => {
                const entries = await read();
                const index = entries.findIndex((candidate) => queueIdentity(candidate) === queueIdentity(entry) && candidate.revision === entry.revision);
                if (index < 0) return false;
                entries.splice(index, 1);
                await write(entries);
                return true;
            });
        },
    };
}
