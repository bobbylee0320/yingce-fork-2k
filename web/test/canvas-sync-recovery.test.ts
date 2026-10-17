import { expect, test } from "bun:test";
import { hasUnpersistedCanvasInput } from "../src/stores/use-sync-progress-store";

test("cloud recovery does not trap navigation, while genuinely unsaved local input is protected", () => {
    expect(hasUnpersistedCanvasInput([{ localPhase: "saved" }])).toBe(false);
    expect(hasUnpersistedCanvasInput([{}])).toBe(false);
    expect(hasUnpersistedCanvasInput([{ localPhase: "pending" }])).toBe(true);
    expect(hasUnpersistedCanvasInput([{ localPhase: "error" }])).toBe(true);
});
import { CanvasSyncPendingError, createSyncSingleFlight, waitForCanvasSync, rememberSyncRecovery, forgetSyncRecovery, syncRecoveryCopies } from "../src/lib/canvas/sync-recovery";

test("a stalled writer releases the caller at deadline without starting a second transaction", async () => {
    const singleFlight = createSyncSingleFlight();
    let finish!: () => void;
    let starts = 0;
    const run = () =>
        singleFlight("account:canvas", () => {
            starts++;
            return new Promise<void>((resolve) => {
                finish = resolve;
            });
        });
    const original = run();
    await expect(waitForCanvasSync(original, 5)).rejects.toBeInstanceOf(CanvasSyncPendingError);
    expect(run()).toBe(original);
    expect(starts).toBe(1);
    finish();
    await original;
    await singleFlight("account:canvas", async () => {
        starts++;
    });
    expect(starts).toBe(2);
});

test("one failed operation does not poison future saves and different accounts have independent flights", async () => {
    const singleFlight = createSyncSingleFlight();
    const hung = singleFlight("account-a:canvas", () => new Promise<void>(() => {}));
    await singleFlight("account-b:canvas", async () => {});
    await expect(
        singleFlight("failure", async () => {
            throw new Error("offline");
        }),
    ).rejects.toThrow("offline");
    await singleFlight("failure", async () => {});
    await expect(waitForCanvasSync(hung, 5)).rejects.toBeInstanceOf(CanvasSyncPendingError);
});

test("storage-unavailable recovery copies remain exportable only in the owning account", () => {
    rememberSyncRecovery("account-a", "draft", { title: "Original draft" });
    expect(syncRecoveryCopies("account-a")).toEqual({ draft: { title: "Original draft" } });
    expect(syncRecoveryCopies("account-b")).toEqual({});
    forgetSyncRecovery("account-a", "draft");
    expect(syncRecoveryCopies("account-a")).toEqual({});
});
