export class CanvasSyncPendingError extends Error {
    readonly retryable = true;
    constructor(message = "云端仍在处理，当前编辑可继续") {
        super(message);
        this.name = "CanvasSyncPendingError";
    }
}

// A deadline bounds the caller, not the transaction. Never unlock a writer or
// change its mutation identity while its network/storage outcome is unknown.
export function waitForCanvasSync<T>(operation: Promise<T>, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CanvasSyncPendingError()), timeoutMs);
        operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function createSyncSingleFlight() {
    const pending = new Map<string, Promise<void>>();
    return (key: string, start: () => Promise<void>) => {
        const existing = pending.get(key);
        if (existing) return existing;
        const operation = Promise.resolve().then(start);
        pending.set(key, operation);
        const clear = () => {
            if (pending.get(key) === operation) pending.delete(key);
        };
        void operation.then(clear, clear);
        return operation;
    };
}

// Storage failure must not trap the recovery path. Keep displaced work in
// memory until it can be persisted or explicitly exported, isolated by account.
const recoveryCopies = new Map<string, Map<string, unknown>>();
export function rememberSyncRecovery(scope: string, key: string, value: unknown) {
    let copies = recoveryCopies.get(scope);
    if (!copies) {
        copies = new Map();
        recoveryCopies.set(scope, copies);
    }
    copies.set(key, value);
}
export function forgetSyncRecovery(scope: string, key: string) {
    recoveryCopies.get(scope)?.delete(key);
}
export function syncRecoveryCopies(scope: string) {
    return Object.fromEntries(recoveryCopies.get(scope) || []);
}
