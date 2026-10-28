import { generationErrorMessage } from "@/lib/generation-error";
import { http, apiBaseURL, ApiError, type BackendEnvelope } from "@/services/api/request";
import { consumeTaskTextStream, createTaskTextStreamParser, type TaskTextStreamEvent } from "@/services/api/task-text-stream";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { getActiveUserScope } from "@/lib/user-scope";

export type { BackendEnvelope } from "@/services/api/request";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskBillingStatus = "reserved" | "running" | "settled" | "refunded" | "uncertain";
export type ProviderCancelStatus = "requested" | "confirmed" | "uncertain";
export type GenerationTaskResultState = "NOT_AVAILABLE" | "PENDING_MATERIALIZATION" | "MATERIALIZING" | "READY" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";
export type GenerationTaskOutput = {
    outputIndex: number;
    mediaType: "image" | "video" | "audio";
    providerArtifactRef?: string;
    materializedAssetId?: string;
    materializationErrorCode?: string;
};

export type GenerationTask = {
    id: string;
    clientOperationId?: string;
    retryOf?: string;
    attemptGroupId?: string;
    projectId?: string;
    type: string;
    status: TaskStatus;
    progress?: number;
    stage?: string;
    mediaStage?: "download" | "upload" | "local_save" | "register" | "completed" | "checkpoint" | "client_upload_pending" | "client_uploading";
    canRecoverMedia?: boolean;
    prompt: string;
    operation?: string;
    provider?: string;
    model?: string;
    providerRequestId?: string;
    providerCancelStatus?: ProviderCancelStatus;
    providerCancelError?: string;
    providerCancelAttempts?: number;
    providerCancelRequestedAt?: string;
    providerCancelledAt?: string;
    errorCode?: string;
    officialStatus?: "pending" | "processing" | "completed" | "failed" | "cancelled";
    receiptRecorded?: boolean;
    previewUrl?: string;
    previewKind?: "image" | "video";
    previewPosterUrl?: string;
    inputJson?: string;
    resultJson?: string;
    resultState?: GenerationTaskResultState;
    outputs?: GenerationTaskOutput[];
    textDraft?: string;
    error?: string;
    attempts: number;
    startedAt?: string;
    completedAt?: string;
    createdAt: string;
    updatedAt: string;
    billing?: {
        amountMicrocredits: number;
        status: TaskBillingStatus;
    };
    clientContext?: {
        conversationId?: string;
        messageId?: string;
        nodeId?: string;
        batchIndex?: number;
        batchCount?: number;
        domainProjectId?: string;
        chapterId?: string;
		chapterOperation?: "characters" | "storyboard";
		shotId?: string;
		workflowStepId?: string;
		artifactType?: string;
	};
    created_at?: string;
    updated_at?: string;
};

type TaskMediaUploadIntent = {
    taskId: string;
    resourceId: string;
    sourceUrl: string;
    uploadUrl?: string;
    headers?: Record<string, string>;
    mimeType: string;
    size: number;
    expiresAt?: string;
    index: number;
    multipartUploadId?: string;
    parts?: Array<{ partNumber: number; uploadUrl: string }>;
    partSize?: number;
};

const clientMediaUploadRequests = new Map<string, Promise<GenerationTask>>();
type ClientUploadProgress = (uploadedBytes: number, totalBytes: number) => void;

/**
 * Materializes a checkpointed provider URL in the browser. The server only
 * signs the destination and verifies it with HEAD; media bytes never enter
 * the backend process.
 */
export function ensureClientTaskMediaUploaded(task: GenerationTask, signal?: AbortSignal, onProgress?: ClientUploadProgress): Promise<GenerationTask> {
    if (task.mediaStage !== "client_upload_pending") return Promise.resolve(task);
    const current = clientMediaUploadRequests.get(task.id);
    if (current) return current;
    const request = uploadClientTaskMedia(task, signal, onProgress).catch(async (error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
            await http.post(`/tasks/${encodeURIComponent(task.id)}/media-upload-fail`, { message: error instanceof Error ? error.message : "浏览器上传生成作品失败" }, { signal: undefined }).catch(() => undefined);
        }
        throw error;
    }).finally(() => {
        if (clientMediaUploadRequests.get(task.id) === request) clientMediaUploadRequests.delete(task.id);
    });
    clientMediaUploadRequests.set(task.id, request);
    return request;
}

async function uploadClientTaskMedia(task: GenerationTask, signal?: AbortSignal, onProgress?: ClientUploadProgress) {
    let items = taskMediaItems(task);
    if (!items.length) {
        const sources = await http.get<Array<{ index: number; sourceUrl: string; mimeType?: string }>>(`/tasks/${encodeURIComponent(task.id)}/media-upload-sources`, { signal });
        items = sources.map((item) => ({ sourceUrl: item.sourceUrl, mimeType: item.mimeType }));
    }
    if (!items.length) throw new Error("生成作品上传信息为空");
    for (let index = 0; index < items.length; index += 1) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const source = await fetchClientMedia(items[index].sourceUrl, signal);
        const hintedMime = items[index].mimeType;
        const concreteMime = hintedMime && !hintedMime.includes("*") ? hintedMime : undefined;
        const mimeType = (!source.type || source.type === "application/octet-stream") ? (concreteMime || (task.type.includes("video") ? "video/mp4" : task.type.includes("audio") ? "audio/mpeg" : "image/png")) : source.type;
        const dimensions = mimeType.startsWith("image/") ? await imageDimensions(source) : { width: 0, height: 0 };
        const intent = await http.post<TaskMediaUploadIntent>(`/tasks/${encodeURIComponent(task.id)}/media-upload-intent`, {
            index,
            fileName: fileNameFromURL(items[index].sourceUrl, task.type, index, mimeType),
            size: source.size,
            mimeType,
            width: dimensions.width,
            height: dimensions.height,
        }, { signal });
        let completedParts: Array<{ partNumber: number; etag: string }> | undefined;
        if (intent.multipartUploadId && intent.parts?.length && intent.partSize) {
            try {
                completedParts = [];
                for (const part of intent.parts) {
                    const start = (part.partNumber - 1) * intent.partSize;
                    const end = Math.min(source.size, start + intent.partSize);
                    const etag = await putClientMediaPart(part.uploadUrl, source.slice(start, end), signal, (loaded) => onProgress?.(start + loaded, source.size));
                    completedParts.push({ partNumber: part.partNumber, etag });
                }
            } catch (error) {
                await http.post(`/resources/${encodeURIComponent(intent.resourceId)}/direct-upload/abort`, { multipartUploadId: intent.multipartUploadId }, { signal: undefined }).catch(() => undefined);
                throw error;
            }
        } else if (intent.uploadUrl) {
            try {
                await putClientMedia(intent.uploadUrl, intent.headers || {}, source, signal, onProgress);
            } catch (error) {
                await http.post(`/resources/${encodeURIComponent(intent.resourceId)}/direct-upload/abort`, {}, { signal: undefined }).catch(() => undefined);
                throw error;
            }
        }
        if (intent.uploadUrl || completedParts) {
            await http.post(`/resources/${encodeURIComponent(intent.resourceId)}/direct-upload/complete`, completedParts ? { multipartUploadId: intent.multipartUploadId, parts: completedParts, generated: true } : { generated: true }, { signal });
        }
    }
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(task.id)}/media-upload-complete`, {}, { signal });
}

async function imageDimensions(blob: Blob) {
    if (typeof createImageBitmap !== "function") return { width: 0, height: 0 };
    try {
        const bitmap = await createImageBitmap(blob);
        const result = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return result;
    } catch {
        return { width: 0, height: 0 };
    }
}

function taskMediaItems(task: GenerationTask) {
    const raw = task.resultJson;
    // The checkpoint is server only. The intent endpoint echoes the URL per
    // item through a lightweight task field when a client upload is pending.
    // Keep the parser tolerant for older task snapshots that expose a single
    // preview URL.
    const urls: Array<{ sourceUrl: string; mimeType?: string }> = [];
    if (task.previewUrl && !task.previewUrl.startsWith("data:")) urls.push({ sourceUrl: resolveTaskURL(task.previewUrl), mimeType: task.previewKind ? `${task.previewKind}/*` : undefined });
    if (raw) {
        try {
            const value = JSON.parse(raw) as { images?: Array<{ url?: string; dataUrl?: string; mimeType?: string }>; video?: { url?: string; dataUrl?: string; mimeType?: string }; audio?: { url?: string; dataUrl?: string; mimeType?: string } };
            const images = Array.isArray(value.images) ? value.images : [];
            for (const item of images) if (item.url && !item.url.startsWith("data:")) urls.push({ sourceUrl: resolveTaskURL(item.url), mimeType: item.mimeType });
            for (const item of [value.video, value.audio]) if (item?.url && !item.url.startsWith("data:")) urls.push({ sourceUrl: resolveTaskURL(item.url), mimeType: item.mimeType });
        } catch {
            // Result JSON is intentionally not required for the pending path.
        }
    }
    const unique = new Map<string, { sourceUrl: string; mimeType?: string }>();
    for (const item of urls) unique.set(item.sourceUrl, item);
    return [...unique.values()];
}

function resolveTaskURL(value: string) {
    if (/^(?:https?:|blob:)/i.test(value)) return value;
    const base = String(apiBaseURL).replace(/\/+$/, "");
    if (value.startsWith("/")) return /^https?:\/\//i.test(base) ? new URL(value, `${base}/`).toString() : value;
    return `${base}/${value.replace(/^\/+/, "")}`;
}

async function fetchClientMedia(url: string, signal?: AbortSignal) {
    const resolved = resolveTaskURL(url);
    const apiOrigin = String(apiBaseURL).replace(/\/+$/, "");
    const platformURL = resolved.startsWith("/") || (/^https?:\/\//i.test(apiOrigin) && resolved.startsWith(apiOrigin));
    const response = await fetch(resolved, { mode: "cors", credentials: platformURL ? "include" : "omit", signal });
    if (!response.ok) throw new Error(`读取上游生成结果失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("上游生成结果为空");
    return blob;
}

function fileNameFromURL(raw: string, taskType: string, index: number, mimeType: string) {
    try {
        const value = new URL(raw).pathname.split("/").pop() || "";
        if (value && value.length <= 255 && value.includes(".")) return value;
    } catch {
        // Use a generated safe name below.
    }
    const ext = mimeType.split("/")[1]?.split(";")[0] || (taskType.includes("video") ? "mp4" : "bin");
    return `generated-${index + 1}.${ext}`;
}

function putClientMedia(url: string, headers: Record<string, string>, blob: Blob, signal?: AbortSignal, onProgress?: ClientUploadProgress) {
    return new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", url);
        request.withCredentials = false;
        Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
        request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
        request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`生成作品直传失败（HTTP ${request.status}）`));
        request.onerror = () => reject(new Error("生成作品直传网络失败"));
        request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
        const abort = () => request.abort();
        signal?.addEventListener("abort", abort, { once: true });
        request.onloadend = () => signal?.removeEventListener("abort", abort);
        request.send(blob);
    });
}

function putClientMediaPart(url: string, blob: Blob, signal?: AbortSignal, onProgress?: (loadedBytes: number) => void) {
    return new Promise<string>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", url);
        request.withCredentials = false;
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded); };
        request.onload = () => {
            if (request.status >= 200 && request.status < 300) {
                const etag = request.getResponseHeader("ETag") || request.getResponseHeader("etag");
                if (!etag) reject(new Error("对象存储未返回分片 ETag"));
                else resolve(etag.replace(/^"|"$/g, ""));
            } else reject(new Error(`生成视频分片上传失败（HTTP ${request.status}）`));
        };
        request.onerror = () => reject(new Error("生成视频分片网络失败"));
        request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
        const abort = () => request.abort();
        signal?.addEventListener("abort", abort, { once: true });
        request.onloadend = () => signal?.removeEventListener("abort", abort);
        request.send(blob);
    });
}

export type ProviderTaskQueryResult = {
    task: GenerationTask;
    providerStatus: string;
    recovered: boolean;
    billingSettled: boolean;
};

export type TaskTextDelta = {
    id: string;
    taskId: string;
    sequence: number;
    content: string;
    byteCount: number;
    createdAt: string;
    expiresAt: string;
};

export type TaskTextReplay = {
    deltas: TaskTextDelta[];
    textDraft?: string;
    finalText?: string;
    complete: boolean;
    status: TaskStatus;
    stage?: string;
    progress: number;
    error?: string;
};

export type TaskLog = {
    id: string;
    taskId: string;
    level: "info" | "warn" | "error";
    stage: string;
    errorCode?: string;
    provenance: "task_state" | "provider_observation" | "background_reconcile" | "manual_refresh" | "backend";
    observedAt?: string;
    createdAt: string;
};

export type CreateTaskInput = {
    projectId?: string;
    type?: string;
    operation?: string;
    prompt: string;
    provider?: string;
    model?: string;
	logicalModelId?: string;
    input?: Record<string, unknown>;
};
export function createGenerationTask(input: CreateTaskInput) {
    const metadata = input.input?.metadata as Record<string, unknown> | undefined;
    const clientOperationId = typeof metadata?.clientOperationId === "string" && metadata.clientOperationId ? metadata.clientOperationId : crypto.randomUUID();
    const request = { ...input, input: { ...input.input, metadata: { ...metadata, clientOperationId } } };
    return http.post<GenerationTask>("/tasks", request).catch((error) => {
        if (error instanceof ApiError && error.retryable) throw new TaskSubmissionUncertainError(clientOperationId);
        throw error;
    }).then((task) => {
        recordDiagnosticEvent({ level: "info", category: "task", message: "任务已创建", taskId: task.id, projectId: task.projectId });
        notifyCanvasTaskCreated(task);
        // 创建任务时积分已被预占，不能等任务结束后才刷新可用余额。
        window.dispatchEvent(new CustomEvent("wallet:updated"));
        return task;
    });
}

export class TaskSubmissionUncertainError extends Error {
    constructor(readonly clientOperationId: string) {
        super("提交结果暂未确认，正在查找原任务，请勿重复提交");
        this.name = "TaskSubmissionUncertainError";
    }
}

export class TaskObservationError extends Error {
    constructor(readonly taskId: string) {
        super("暂时无法同步生成进度，正在重新连接，请勿重复提交");
        this.name = "TaskObservationError";
    }
}

export async function resolveGenerationTaskSubmissions(operationIds: string[], signal?: AbortSignal) {
    const tasks = await http.post<GenerationTask[]>("/tasks/resolve-submissions", { operationIds }, { signal });
    return tasks.map((task) => {
        if (!task.inputJson) return task;
        const metadata = (JSON.parse(task.inputJson) as { metadata?: Record<string, unknown> }).metadata;
        if (!metadata) return task;
        return { ...task, clientOperationId: typeof metadata.clientOperationId === "string" ? metadata.clientOperationId : undefined, clientContext: {
            conversationId: typeof metadata.conversationId === "string" ? metadata.conversationId : undefined,
            messageId: typeof metadata.messageId === "string" ? metadata.messageId : undefined,
            batchIndex: typeof metadata.batchIndex === "number" ? metadata.batchIndex : undefined,
            batchCount: typeof metadata.batchCount === "number" ? metadata.batchCount : undefined,
        } };
    });
}

export type GenerationTaskPageRequest = {
    limit: number;
    projectId?: string;
    activeOnly: boolean;
    cursor?: string;
};

type GenerationTaskPage<T> = { tasks: T[]; nextCursor?: string };
type GenerationTaskListOptions = { projectId?: string; activeOnly?: boolean };
type GenerationTaskListDependencies = {
    listBackend?(limit: number, options?: GenerationTaskListOptions, signal?: AbortSignal): Promise<GenerationTask[]>;
    listBackendPage?(request: GenerationTaskPageRequest, signal?: AbortSignal): Promise<GenerationTaskPage<GenerationTask>>;
};

const defaultGenerationTaskListDependencies: GenerationTaskListDependencies = {
    listBackendPage: async (page, signal) => ({
        tasks: await http.get<GenerationTask[]>("/tasks", {
                params: { pageSize: Math.min(page.limit, 100), projectId: page.projectId, activeOnly: page.activeOnly || undefined },
                signal,
            }),
    }),
};

export async function listGenerationTasks(limit = 30, options?: { projectId?: string; activeOnly?: boolean }, dependencies: GenerationTaskListDependencies = defaultGenerationTaskListDependencies, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(10_000, Math.trunc(limit))) : 30;
    const baseRequest = {
        limit: Math.min(100, boundedLimit),
        ...(options?.projectId ? { projectId: options.projectId } : {}),
        activeOnly: options?.activeOnly === true,
    } satisfies GenerationTaskPageRequest;
    const backendPageReader =
        dependencies.listBackendPage ??
        (async (page: GenerationTaskPageRequest, pageSignal?: AbortSignal) => ({
            tasks:
                (await dependencies.listBackend?.(
                    page.limit,
                    {
                        ...(page.projectId ? { projectId: page.projectId } : {}),
                        activeOnly: page.activeOnly,
                    },
                    pageSignal,
                )) ?? [],
        }));
    const backendTasks = await collectGenerationTaskPages(backendPageReader, baseRequest, boundedLimit, signal);
    const clientUploadTasks = await Promise.all(backendTasks.map((task) => task.mediaStage === "client_upload_pending" ? ensureClientTaskMediaUploaded(task, signal).catch(() => task) : task));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return clientUploadTasks
        .filter((task) => !options?.projectId || task.projectId === options.projectId)
        .filter((task) => !options?.activeOnly || task.status === "queued" || task.status === "running")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
        .slice(0, boundedLimit);
}

async function collectGenerationTaskPages<T>(readPage: (request: GenerationTaskPageRequest, signal?: AbortSignal) => Promise<GenerationTaskPage<T>>, baseRequest: GenerationTaskPageRequest, limit: number, signal?: AbortSignal) {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await readPage({ ...baseRequest, ...(cursor ? { cursor } : {}) }, signal);
        const page = Array.isArray(response) ? { tasks: response as T[] } : response;
        items.push(...page.tasks);
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    } while (items.length < limit);
    return items.slice(0, limit);
}

export function queryGenerationTask(id: string, options?: { signal?: AbortSignal }) {
    return http.get<GenerationTask>(`/tasks/${encodeURIComponent(id)}`, { signal: options?.signal });
}

type GenerationTaskSubscriptionDependencies = {
    queryTask(id: string, options?: { signal?: AbortSignal }): Promise<GenerationTask>;
    waitTask(id: string, options?: { signal?: AbortSignal; initialTask?: GenerationTask; onTaskUpdate?: (task: GenerationTask) => void }): Promise<GenerationTask>;
};

export function createGenerationTaskSubscriptionService(dependencies: GenerationTaskSubscriptionDependencies) {
    type Entry = {
        listeners: Set<(task: GenerationTask) => void>;
        latest?: GenerationTask;
        observation?: Promise<void>;
        controller?: AbortController;
        retry?: ReturnType<typeof setTimeout>;
        failures: number;
        scope: string;
    };
    const entries = new Map<string, Entry>();
    const publish = (entry: Entry, task: GenerationTask) => {
        if (entry.scope !== getActiveUserScope() || !entry.listeners.size) return;
        entry.latest = task;
        for (const listener of entry.listeners) listener(task);
    };
    const observe = (id: string, entry: Entry) => {
        if (entry.observation || !entry.listeners.size || entry.scope !== getActiveUserScope()) return;
        if (entry.latest && ["succeeded", "failed", "cancelled"].includes(entry.latest.status)) return;
        if (entry.retry) clearTimeout(entry.retry);
        entry.retry = undefined;
        const controller = new AbortController();
        entry.controller = controller;
        entry.observation = (async () => {
            const initial = await dependencies.queryTask(id, { signal: controller.signal });
            if (controller.signal.aborted) return;
            publish(entry, initial);
            if (initial.status === "succeeded" || initial.status === "failed" || initial.status === "cancelled") return;
            const terminal = await dependencies.waitTask(id, {
                initialTask: initial,
                signal: controller.signal,
                onTaskUpdate: (task) => { entry.failures = 0; publish(entry, task); },
            });
            publish(entry, terminal);
        })().catch((error) => {
            if (controller.signal.aborted) return;
            console.warn("生成任务观察中断，将重连原任务", { taskId: id, error });
        }).finally(() => {
            entry.observation = undefined;
            if (controller.signal.aborted || !entry.listeners.size || entry.scope !== getActiveUserScope()) return;
            if (entry.latest && ["succeeded", "failed", "cancelled"].includes(entry.latest.status)) return;
            const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(entry.failures++, 4));
            entry.retry = setTimeout(() => observe(id, entry), delayMs);
        });
    };
    const reconnect = () => {
        for (const [id, entry] of entries) observe(id, entry);
    };
    let listening = false;
    return {
        refresh(ids: readonly string[]) {
            for (const id of ids) {
                const entry = entries.get(id);
                if (!entry) continue;
                entry.latest = undefined;
                observe(id, entry);
            }
        },
        subscribe(ids: readonly string[], listener: (task: GenerationTask) => void) {
            if (!listening && typeof window !== "undefined") {
                window.addEventListener("online", reconnect);
                listening = true;
            }
            const uniqueIds = [...new Set(ids)];
            const ownedEntries = new Map<string, Entry>();
            for (const id of uniqueIds) {
                const old = entries.get(id);
                if (old && old.scope !== getActiveUserScope()) {
                    old.controller?.abort();
                    if (old.retry) clearTimeout(old.retry);
                    old.listeners.clear();
                    entries.delete(id);
                }
                const entry = entries.get(id) ?? { listeners: new Set<(task: GenerationTask) => void>(), failures: 0, scope: getActiveUserScope() };
                entries.set(id, entry);
                ownedEntries.set(id, entry);
                entry.listeners.add(listener);
                if (entry.latest) listener(entry.latest);
                observe(id, entry);
            }
            return () => {
                for (const [id, entry] of ownedEntries) {
                    entry.listeners.delete(listener);
                    if (entry.listeners.size) continue;
                    entry.controller?.abort();
                    if (entry.retry) clearTimeout(entry.retry);
                    if (entries.get(id) === entry) entries.delete(id);
                }
                if (!entries.size && listening) {
                    window.removeEventListener("online", reconnect);
                    listening = false;
                }
            };
        },
    };
}

const generationTaskSubscriptionService = createGenerationTaskSubscriptionService({
    queryTask: (id, options) => queryGenerationTask(id, options),
    waitTask: (id, options) => waitForGenerationTask(id, options),
});

export function subscribeGenerationTasks(ids: readonly string[], listener: (task: GenerationTask) => void) {
    return generationTaskSubscriptionService.subscribe(ids, listener);
}

export function refreshGenerationTaskObservations(ids: readonly string[]) {
    generationTaskSubscriptionService.refresh(ids);
}

export function appendTaskTextDelta(id: string, content: string) {
    return http.post<TaskTextDelta>(`/tasks/${encodeURIComponent(id)}/text-deltas`, { content });
}

export function completeTextReplayTask(id: string, text: string) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/text-replay-complete`, { text });
}

export function queryTaskTextReplay(id: string, after = 0) {
    return http.get<TaskTextReplay>(`/tasks/${encodeURIComponent(id)}/text-deltas`, { params: { after } });
}

export function retryGenerationTask(id: string) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/retry`);
}

export function recoverGenerationTaskMedia(id: string) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/recover-media`).then((task) => {
        refreshGenerationTaskObservations([id]);
        return task;
    });
}

export function cancelGenerationTask(id: string) {
    return http.post<GenerationTask>(`/tasks/${encodeURIComponent(id)}/cancel`).then((task) => {
        window.dispatchEvent(new CustomEvent("canvas:task-cancelled", { detail: { task } }));
        window.dispatchEvent(new CustomEvent("wallet:updated"));
        return task;
    });
}

export function queryFailedVideoProviderTask(id: string) {
    return http.post<ProviderTaskQueryResult>(`/tasks/${encodeURIComponent(id)}/query-provider`);
}

export function refreshGenerationTaskStatus(id: string, options?: { signal?: AbortSignal }) {
    return http.get<GenerationTask>(`/tasks/${encodeURIComponent(id)}`, { signal: options?.signal });
}

export function deleteGenerationTask(id: string) {
    return http.delete<void>(`/tasks/${encodeURIComponent(id)}`);
}

export async function listTaskLogs(id: string) {
    const raw = await http.get<Array<{ level?: unknown; message?: unknown; payload?: unknown; createdAt?: unknown }>>(`/tasks/${encodeURIComponent(id)}/logs`);
    return raw.map((log, index) => projectBackendSafeTaskLog(id, log, index));
}

export function formatTaskLog(log: TaskLog) {
    return [`stage=${log.stage}`, ...(log.errorCode ? [`error=${log.errorCode}`] : []), `provenance=${log.provenance}`, ...(log.observedAt ? [`observedAt=${log.observedAt}`] : [])].join(" ");
}

export function projectBackendSafeTaskLog(taskId: string, raw: { level?: unknown; message?: unknown; payload?: unknown; createdAt?: unknown }, index: number): TaskLog {
    const text = [raw.message, raw.payload].filter((value): value is string => typeof value === "string").join(" ");
    const stage = safeTaskLogStage(text) || "backend_event";
    const errorCode = safeTaskLogErrorCode(text);
    const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : "1970-01-01T00:00:00.000Z";
    return {
        id: `safe:${taskId}:${index}`,
        taskId,
        level: raw.level === "error" ? "error" : raw.level === "warn" ? "warn" : "info",
        stage,
        ...(errorCode ? { errorCode } : {}),
        provenance: "backend",
        createdAt,
    };
}

function safeTaskLogStage(value: unknown) {
    if (typeof value !== "string") return undefined;
    const match = value.match(/(?:^|[^a-z0-9_])(queued|submitting|submitted|generating|submission_unknown|processing|completed|succeeded|failed|cancelled)(?:$|[^a-z0-9_])/i);
    return match?.[1]?.toLowerCase();
}

const SAFE_TASK_LOG_ERROR_CODES = new Set(["provider_query_failed", "provider_submission_unknown", "provider_reference_invalid"]);

function safeTaskLogErrorCode(value: unknown) {
    if (typeof value !== "string") return undefined;
    for (const match of value.matchAll(/(?:model|provider)_[a-z0-9_]{2,80}/gi)) {
        const errorCode = match[0].toLowerCase();
        if (SAFE_TASK_LOG_ERROR_CODES.has(errorCode)) return errorCode;
    }
    return undefined;
}

/**
 * 后端任务已进入失败/取消终态。只有这类错误代表“生成失败”；轮询连续失败、等待超时、
 * 结果读取失败都只是页面没跟上原任务，调用方应继续跟进而不是让用户重新付费生成。
 */
export class GenerationTaskTerminalError extends Error {
    readonly task: GenerationTask;

    constructor(message: string, task: GenerationTask) {
        super(message);
        this.name = "GenerationTaskTerminalError";
        this.task = task;
    }
}

export function isGenerationTaskTerminalError(error: unknown): error is GenerationTaskTerminalError {
    return error instanceof GenerationTaskTerminalError;
}

function terminalTaskError(task: GenerationTask) {
    return new GenerationTaskTerminalError(task.error ? generationErrorMessage(task.error) : `任务${task.status === "cancelled" ? "已取消" : "失败"}`, task);
}

export type WaitForGenerationTaskOptions = {
	onConnectionChange?: (state: "connected" | "reconnecting") => void;
	textEventsSource?: "task" | "agent";
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
    initialTask?: GenerationTask;
    onTaskUpdate?: (task: GenerationTask) => void;
    onTextDelta?: (text: string) => void;
    useTextEvents?: boolean;
};

export async function waitForGenerationTask(id: string, options?: WaitForGenerationTaskOptions) {
    if (options?.onTextDelta || options?.useTextEvents) return waitForGenerationTaskTextEvents(id, options);
    const startedAt = Date.now();
    const intervalMs = options?.intervalMs || 2000;
    let lastTask = options?.initialTask;
    let lastQueryError: unknown;
    let consecutiveFailures = 0;
    try {
        while (Date.now() - startedAt < (options?.timeoutMs || taskWaitTimeoutMs(lastTask))) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let task: GenerationTask;
            try {
                task = await queryGenerationTask(id, { signal: options?.signal });
                lastTask = task;
                lastQueryError = undefined;
                consecutiveFailures = 0;
                options?.onTaskUpdate?.(task);
                options?.onConnectionChange?.("connected");
            } catch (error) {
                lastQueryError = error;
                consecutiveFailures += 1;
                if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                options?.onConnectionChange?.("reconnecting");
                if (error instanceof ApiError && !error.retryable) throw new TaskObservationError(id);
                await delay(Math.min(30_000, intervalMs * 2 ** Math.min(consecutiveFailures - 1, 4)), options?.signal);
                continue;
            }
            if (task.mediaStage === "client_upload_pending") {
                task = await ensureClientTaskMediaUploaded(task, options?.signal, (uploadedBytes, totalBytes) => options?.onTaskUpdate?.({ ...task, mediaStage: "client_uploading", progress: totalBytes > 0 ? Math.round(uploadedBytes / totalBytes * 100) : 0 }));
                lastTask = task;
                options?.onTaskUpdate?.(task);
                continue;
            }
            if (task.status === "succeeded") {
                window.dispatchEvent(new CustomEvent("wallet:updated"));
                return task;
            }
            if (task.status === "failed" || task.status === "cancelled") {
                window.dispatchEvent(new CustomEvent("wallet:updated"));
                throw terminalTaskError(task);
            }
            await delay(intervalMs, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) {
            // Abort 只停止当前页面的状态监听，不能把已发起的上游任务改成取消状态。
            throw new DOMException("Aborted", "AbortError");
        }
        throw error;
    }
    throw new TaskObservationError(id);
}

async function waitForGenerationTaskTextEvents(id: string, options: WaitForGenerationTaskOptions) {
    const startedAt = Date.now();
    const intervalMs = options.intervalMs || 1000;
    let lastTask = options.initialTask;
    let lastEventId = 0;
    // Agent subscriptions replay from cursor 0; an existing draft must not be
    // prepended to the same persisted deltas when reopening a conversation.
    let fullText = options.textEventsSource === "agent" ? "" : lastTask?.textDraft || "";
    let lastStreamError: unknown;
    if (!lastTask) {
        lastTask = await queryGenerationTask(id, { signal: options.signal });
        options.onTaskUpdate?.(lastTask);
    }
    const timeoutMs = options.timeoutMs || taskWaitTimeoutMs(lastTask);
    while (Date.now() - startedAt < timeoutMs) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let terminalReceived = false;
        try {
            const base = String(apiBaseURL).replace(/\/+$/, "");
            const cursor = lastEventId > 0 ? `?after=${encodeURIComponent(String(lastEventId))}` : "";
            const path = options.textEventsSource === "agent" ? `/agent/runs/${encodeURIComponent(id)}/events` : `/tasks/${encodeURIComponent(id)}/text-events`;
            const response = await fetch(`${base}${path}${cursor}`, {
                headers: { Accept: "text/event-stream" },
                credentials: "include",
                signal: options.signal,
            });
            if (!response.ok) throw new TaskTextStreamFatalError(await taskTextStreamHTTPError(response));
            if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) {
                throw new TaskTextStreamFatalError("任务文本流接口未返回事件流，请检查后端地址和反向代理配置");
            }
            if (!response.body) throw new Error("任务文本流不可用");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = createTaskTextStreamParser();
            const onEvent = (event: TaskTextStreamEvent) => {
                const payload = asTaskTextStreamRecord(event.data);
                if (event.event === "delta") {
                    const sequence = numberValue(payload.sequence) || event.id || 0;
                    if (sequence <= lastEventId) return;
                    const content = typeof payload.content === "string" ? payload.content : "";
                    lastEventId = sequence;
                    if (!content) return;
                    fullText += content;
                    options.onTextDelta?.(fullText);
                    if (lastTask) {
                        lastTask = { ...lastTask, textDraft: fullText };
                        options.onTaskUpdate?.(lastTask);
                    }
                    return;
                }
                if (event.event === "progress") {
                    if (!lastTask) return;
                    lastTask = {
                        ...lastTask,
                        ...(isTaskStatus(payload.status) ? { status: payload.status } : {}),
                        ...(typeof payload.stage === "string" ? { stage: payload.stage } : {}),
                        ...(numberValue(payload.progress) !== undefined ? { progress: numberValue(payload.progress) } : {}),
                    };
                    options.onTaskUpdate?.(lastTask);
                    return;
                }
                if (event.event === "terminal") {
                    terminalReceived = true;
                    if (typeof payload.finalText === "string" && payload.finalText !== fullText) {
                        fullText = payload.finalText;
                        options.onTextDelta?.(fullText);
                    }
                    return;
                }
                if (event.event === "error") throw new Error(typeof payload.message === "string" ? payload.message : "任务文本流不可用");
            };
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                consumeTaskTextStream(parser, decoder.decode(value, { stream: true }), onEvent);
            }
            consumeTaskTextStream(parser, decoder.decode(), onEvent, true);
            if (terminalReceived) {
                const completed = await queryGenerationTask(id, { signal: options.signal });
                options.onTaskUpdate?.(completed);
                window.dispatchEvent(new CustomEvent("wallet:updated"));
                if (completed.status === "succeeded") return completed;
                if (completed.status === "failed" || completed.status === "cancelled") throw terminalTaskError(completed);
            }
            lastStreamError = new Error("任务文本流连接提前结束");
        } catch (error) {
            if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (error instanceof TaskTextStreamFatalError || error instanceof GenerationTaskTerminalError) throw error;
            lastStreamError = error;
        }
        await delay(intervalMs, options.signal);
    }
    throw new Error(lastStreamError instanceof Error ? `任务文本流同步失败：${lastStreamError.message}` : "任务执行超时，请稍后重试");
}

function asTaskTextStreamRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
    return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

class TaskTextStreamFatalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TaskTextStreamFatalError";
    }
}

async function taskTextStreamHTTPError(response: Response) {
    try {
        const payload = await response.json() as { msg?: unknown };
        if (typeof payload.msg === "string" && payload.msg.trim()) return payload.msg;
    } catch {
        // SSE 错误响应可能是空正文或网关 HTML，只返回状态码，避免泄露正文。
    }
    return `任务文本流请求失败（HTTP ${response.status}）`;
}

function taskWaitTimeoutMs(task?: GenerationTask) {
    const type = task?.type || "";
    // 等待上限必须不小于后端同类任务的执行超时（分镜 20 分钟、视频 120 分钟，见后台
    // 资源与策略），否则长任务会在前端被判超时、消息显示失败，而后端其实还在跑并最终成功。
    if (type.includes("storyboard")) return 25 * 60 * 1000;
    if (type.includes("video")) return 125 * 60 * 1000;
    if (type.includes("image")) return 10 * 60 * 1000;
    if (type.includes("text") || type.includes("audio")) return 12 * 60 * 1000;
    return 10 * 60 * 1000;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function notifyCanvasTaskCreated(task: GenerationTask) {
    if (typeof window === "undefined" || !task.projectId) return;
    window.dispatchEvent(new CustomEvent("canvas:task-created", { detail: { task } }));
}
