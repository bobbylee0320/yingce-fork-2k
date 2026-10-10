import { nanoid } from "nanoid";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { withCanvasStorePersistenceLock, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { withGenerationArtifactCommitLock } from "@/services/generation-asset-repository";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";

export type CanvasSyncDraft = { id: string; savedAt: string; project: CanvasProject };
const draftKey = (projectId: string) => `yingce:sync-drafts:${projectId}`;
const draftIndexKey = "yingce:sync-draft-index";

export async function readAllCanvasSyncDrafts(scope = getActiveUserScope()) {
    const raw = await localForageStorageForScope(scope).getItem(draftIndexKey);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    return (await Promise.all(ids.map((id) => readCanvasSyncDrafts(id, scope)))).flat();
}

export async function readCanvasSyncDrafts(projectId: string, scope = getActiveUserScope()): Promise<CanvasSyncDraft[]> {
    const raw = await localForageStorageForScope(scope).getItem(draftKey(projectId));
    return raw ? JSON.parse(raw) : [];
}

/** Caller must hold the scope's canvas persistence lock. Never reacquire it here. */
export async function preserveCanvasSyncDraftLocked(snapshot: CanvasProject, scope: string) {
    try {
        const drafts = await readCanvasSyncDrafts(snapshot.id, scope);
        if (!drafts.some((draft) => sameCanvasContent(draft.project, snapshot))) {
            const storage = localForageStorageForScope(scope);
            const rawIndex = await storage.getItem(draftIndexKey);
            const ids: string[] = rawIndex ? JSON.parse(rawIndex) : [];
            if (!ids.includes(snapshot.id)) await storage.setItem(draftIndexKey, JSON.stringify([...ids, snapshot.id]));
            drafts.push({ id: nanoid(), savedAt: new Date().toISOString(), project: snapshot });
            await storage.setItem(draftKey(snapshot.id), JSON.stringify(drafts));
        }
        if (getActiveUserScope() === scope) useSyncProgressStore.getState().setProjectProgress(snapshot.id, { draftCount: drafts.length, draftError: undefined });
        return drafts.length;
    } catch (error) {
        if (getActiveUserScope() === scope) {
            const progress = useSyncProgressStore.getState();
            const current = progress.syncingProjects[snapshot.id];
            progress.setProjectProgress(snapshot.id, {
                phase: current?.phase === "conflict" ? "conflict" : "error",
                errorKind: "draft",
                draftError: error instanceof Error ? error.message : "本地草稿保存失败",
                message: "保存暂未完成，已暂停版本替换，当前编辑内容保持不变",
            });
        }
        throw error;
    }
}

export async function preserveCanvasSyncDraft(project: CanvasProject, scope = getActiveUserScope()) {
    const snapshot = structuredClone(project);
    return withGenerationArtifactCommitLock(scope, () => withCanvasStorePersistenceLock(scope, () => preserveCanvasSyncDraftLocked(snapshot, scope)));
}
