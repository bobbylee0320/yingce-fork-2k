import { compactApiParams, http } from "@/services/api/request";
import type { Project } from "@/services/api/projects";

// 短剧自动制作：章节只承载小说原文，集是剧本、分镜与成片的基石。编排全部在服务端完成。

export type DramaModelChoice = {
    logicalModelId?: string;
    channelId?: string;
    modelKey?: string;
    label?: string;
    priceLabel?: string;
};

export type DramaCapability = "text" | "image" | "video";

export type DramaModels = Record<DramaCapability, DramaModelChoice>;

export type DramaReviewMode = "sample" | "every" | "auto";

/** manual：先只跑剧本、分镜、设定与视频提示词，确认后手动开始生成参考图与视频；auto：一路跑到成片。 */
export type DramaMediaMode = "manual" | "auto";

export type DramaAssetMode = "portrait" | "turnaround" | "fourview" | "custom";

/** 角色/场景参考图方案：保存的是全文提示词，用户看到的就是实际发送的内容。道具参考图使用固定模板。 */
export type DramaAssetSettings = {
    mode: DramaAssetMode;
    characterPrompt: string;
    scenePrompt: string;
    characterRatio: string;
    sourceSkillId?: string;
    sourceSkillName?: string;
    sourcePath?: string;
};

export type DramaAssetScheme = {
    mode: Exclude<DramaAssetMode, "custom">;
    name: string;
    description: string;
    ratio: string;
    frameHint: string;
    characterPrompt: string;
};

export type DramaAssetSchemeCatalog = { schemes: DramaAssetScheme[]; scenePrompt: string; characterVariables: string[]; sceneVariables: string[] };

/** 剧情段怎么切：智能按场景与冲突切、单段不超过模型上限；固定每段 segmentSeconds 秒；范围在 segmentMin–MaxSeconds 之间。 */
export type DramaSegmentMode = "auto" | "fixed" | "range";

/**
 * 分镜规则：剧情段（一次视频调用）怎么切、镜头节奏、对白密度与转场。
 * 剧本提示词、镜头时长、剧情段切分与成片渲染共用；三种切段模式的数值都保留，切换模式不丢值。
 */
export type DramaStoryboardSettings = {
    segmentMode: DramaSegmentMode;
    segmentSeconds: number;
    segmentMinSeconds: number;
    segmentMaxSeconds: number;
    pacing: "fast" | "standard" | "slow";
    dialogue: "dense" | "standard" | "sparse";
    transition: "auto" | "cut" | "fadeblack" | "fadewhite";
    transitionMs: number;
};

/** 用户技能库里的一个技能文件，作为剧情段视频提示词的写作方法。 */
export type DramaSkillRef = { skillId: string; skillName: string; path: string };

export type DramaTransition = "cut" | "fadeblack" | "fadewhite";

export type DramaSettings = {
    aspectRatio: string;
    episodeSeconds: number;
    stylePrompt: string;
    styleName: string;
    language: string;
    assets: DramaAssetSettings;
    storyboard: DramaStoryboardSettings;
    /** 为空时按内置格式撰写段视频提示词。 */
    promptSkill?: DramaSkillRef;
    reviewMode: DramaReviewMode;
    mediaMode: DramaMediaMode;
    concurrency: number;
    models: DramaModels;
};

export type DramaStatus = "draft" | "running" | "paused" | "completed";

export type DramaEpisodeStage = "queued" | "script" | "prompts" | "review" | "video" | "render" | "done";

export type DramaMediaStatus = "" | "queued" | "running" | "ready" | "failed" | "stale" | "skipped";

export type DramaProductionView = {
    status: DramaStatus;
    stage: "bible" | "produce" | "done";
    pauseReason: string;
    settings: DramaSettings;
    budgetMicrocredits: number;
    spentMicrocredits: number;
    planDone: boolean;
    planCursor: number;
    sampleApproved: boolean;
    assetsReleased: boolean;
    logline: string;
    tone: string;
    chapterCount: number;
    wordCount: number;
};

/** 按剧情段统计的单集进度。 */
export type DramaEpisodeStats = { segments: number; promptReady: number; videoReady: number; failed: number };

export type DramaEpisodeRow = {
    id: string;
    number: number;
    title: string;
    synopsis: string;
    stage: DramaEpisodeStage;
    error: string;
    shotCount: number;
    durationMs: number;
    approved: boolean;
    mediaReleased: boolean;
    awaitingMedia: boolean;
    finalResourceId?: string;
    finalStale: boolean;
    stats: DramaEpisodeStats;
};

export type DramaInboxItem = {
    id: string;
    kind: "media_ready" | "review" | "episode_error" | "paused" | "cast_failed" | "segment_failed";
    severity: "info" | "warning" | "error";
    title: string;
    detail: string;
    episodeId?: string;
    castId?: string;
    castKind?: DramaCastKind;
    episodeNumber?: number;
    segmentIndex: number;
    media?: "prompt" | "video";
};

export type DramaSummary = {
    project: Project;
    production: DramaProductionView;
    episodes: DramaEpisodeRow[];
    jobCounts: Partial<Record<"queued" | "running" | "succeeded" | "failed" | "canceled", number>>;
    inbox: DramaInboxItem[];
    castCount: number;
};

export type DramaShot = {
    id: string;
    projectId: string;
    episodeId: string;
    position: number;
    segmentIndex: number;
    segmentTitle: string;
    scene: string;
    sceneCastId?: string;
    castIdsJson: string;
    propIdsJson: string;
    speaker: string;
    dialogue: string;
    action: string;
    shotSize: string;
    camera: string;
    transition: DramaTransition | "";
    durationMs: number;
    imagePrompt: string;
    videoPrompt: string;
    sourceQuote: string;
};

export type DramaEpisode = {
    id: string;
    projectId: string;
    number: number;
    title: string;
    synopsis: string;
    hook: string;
    cliffhanger: string;
    chapterIdsJson: string;
    stage: DramaEpisodeStage;
    error: string;
    shotCount: number;
    durationMs: number;
    approved: boolean;
    finalResourceId?: string;
    finalStale: boolean;
    subtitleSrt: string;
    revision: number;
};

export type DramaJob = {
    id: string;
    kind: "bible" | "plan" | "cast_image" | "script" | "segment_prompt" | "segment_video" | "render";
    status: "queued" | "running" | "succeeded" | "failed" | "canceled";
    label: string;
    error?: string;
    episodeId?: string;
    shotId?: string;
    taskId?: string;
    costMicrocredits: number;
    attempt: number;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
};

export type DramaJobTask = {
    id: string;
    status: string;
    stage?: string;
    operation?: string;
    model: string;
    modelLabel: string;
    prompt: string;
    params: Record<string, string>;
    error?: string;
    mediaStage?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    resultMode?: string;
    resultText?: string;
    resourceIds?: string[];
};

export type DramaJobAttempt = { taskId?: string; status: string; error?: string; costMicrocredits: number; at: string; task?: DramaJobTask };

export type DramaJobDetail = { job: DramaJob; target: string; attempts: DramaJobAttempt[] };

export type DramaChapterRef = { id: string; title: string; position: number; wordCount: number };

export type DramaEpisodeDetail = {
    episode: DramaEpisode;
    shots: DramaShot[];
    /** 剧情段是视频生成单位：一段一次调用视频模型，对白与音效由视频模型生成。 */
    segments: DramaSegment[];
    chapters: DramaChapterRef[];
    jobs: DramaJob[];
    scriptJob?: DramaJob;
};

/** 剧情段视频提示词的撰写状态：none 无记录、stale 镜头或设定改过后过期。 */
export type DramaSegmentPromptStatus = "none" | "queued" | "running" | "ready" | "stale" | "failed";

/** 一个剧情段；videoPrompt 为生效内容（手动改写优先），generated 为模型撰写的版本。 */
export type DramaSegment = {
    id: string;
    index: number;
    title: string;
    shotIds: string[];
    durationMs: number;
    videoPrompt: string;
    generated: string;
    custom: boolean;
    promptStatus: DramaSegmentPromptStatus;
    promptError?: string;
    videoStatus: DramaMediaStatus;
    videoResourceId?: string;
    tailFrameResourceId?: string;
    videoError?: string;
    /** 视频已生成，只是后处理（如抽尾帧）失败；可重新处理已有视频，不重新生成。 */
    videoReprocessable?: boolean;
    videoModel: DramaModelChoice;
    request: DramaSegmentRequest;
    promptJob?: DramaJob;
    videoJob?: DramaJob;
    /** 视频已请求但尚未提交时，调度实际卡住的原因（等待上一段、参考图、放行或制作暂停）。 */
    videoWait?: string;
};

/** 参考图编号与提交顺序一致；sent=false 表示未就绪或超过模型上限，不随请求发送。 */
export type DramaSegmentReference = { castId: string; label: string; kind: DramaCastKind; name: string; resourceId?: string; sent: boolean };

/**
 * 生成本段视频时实际发送的内容，与提交同一函数计算。
 * operation：image_to_video（上一段最后一帧作首帧）、reference_to_video（参考图）、text_to_video。
 * firstFramePending：上一段视频还没生成，本段要等它完成后才能提交。
 */
export type DramaSegmentRequest = {
    operation: "image_to_video" | "reference_to_video" | "text_to_video" | "";
    seconds: number;
    maxVideoSeconds: number;
    firstFrameResourceId?: string;
    firstFramePending: boolean;
    references: DramaSegmentReference[];
    header: string;
    warning?: string;
};

export type DramaCastKind = "character" | "prop" | "scene";

export type DramaCast = {
    id: string;
    projectId: string;
    kind: DramaCastKind;
    name: string;
    aliasesJson: string;
    role: string;
    description: string;
    appearance: string;
    voiceInstructions: string;
    importance: number;
    imageResourceId?: string;
    imageStatus: DramaMediaStatus;
    imageVersion: number;
    locked: boolean;
    position: number;
};

export type DramaListItem = {
    project: Project;
    status: DramaStatus;
    stage: string;
    pauseReason: string;
    episodeCount: number;
    doneCount: number;
    coverResourceId?: string;
    coverResourceIds?: string[];
    aspectRatio: string;
    styleName?: string;
    spentMicrocredits: number;
    updatedAt: string;
};

export type DramaListPage = { items: DramaListItem[]; page: number; pageSize: number; total: number; hasMore: boolean; statusCounts: Partial<Record<DramaStatus | "all", number>> };

export type DramaModelOption = { choice: DramaModelChoice; capability: DramaCapability; label: string; priceLabel: string; maxVideoSeconds?: number };

/** 平台目录里有、但短剧流水线无法使用的模型及原因；前端置灰展示。 */
export type DramaModelUnavailable = { choice: DramaModelChoice; reason: string };

export type DramaModelCatalog = { defaults: DramaModels; options: Record<DramaCapability, DramaModelOption[]>; unavailable?: Partial<Record<DramaCapability, DramaModelUnavailable[]>> };

export type DramaEstimate = {
    episodes: number;
    shots: number;
    images: number;
    videos: number;
    textCalls: number;
    minMicrocredits: number;
    maxMicrocredits: number;
    sampleMicrocredits: number;
    priced: boolean;
    note: string;
    durationMinutes: number;
};

export type CreateDramaInput = {
    name: string;
    chapters: Array<{ title: string; text: string }>;
    settings: Partial<DramaSettings>;
    budgetMicrocredits: number;
    start: boolean;
};

const base = (projectId: string) => `/dramas/${encodeURIComponent(projectId)}`;

export function listDramas(params: { page: number; pageSize: number; q?: string; status?: DramaStatus }, signal?: AbortSignal) {
    return http.get<DramaListPage>("/dramas", { params: compactApiParams(params), signal });
}

export function getDramaAssetSchemes() {
    return http.get<DramaAssetSchemeCatalog>("/dramas/asset-schemes");
}

export function getDramaModels() {
    return http.get<DramaModelCatalog>("/dramas/models");
}

export function estimateDrama(input: { chapterCount: number; wordCount: number; settings: Partial<DramaSettings> }, signal?: AbortSignal) {
    return http.post<DramaEstimate>("/dramas/estimate", input, { signal });
}

export function createDrama(input: CreateDramaInput) {
    return http.post<DramaSummary>("/dramas", input, { timeout: 120_000 });
}

export function deleteDrama(projectId: string) {
    return http.delete<{ deleted: boolean }>(base(projectId));
}

export function getDrama(projectId: string, signal?: AbortSignal) {
    return http.get<DramaSummary>(base(projectId), { signal });
}

export function updateDramaSettings(projectId: string, input: { settings?: DramaSettings; budgetMicrocredits?: number }) {
    return http.patch<DramaSummary>(`${base(projectId)}/settings`, input);
}

export function startDrama(projectId: string) {
    return http.post<DramaSummary>(`${base(projectId)}/start`);
}

export function pauseDrama(projectId: string) {
    return http.post<DramaSummary>(`${base(projectId)}/pause`);
}

export function retryFailedDrama(projectId: string) {
    return http.post<{ segments: number; casts: number }>(`${base(projectId)}/retry-failed`);
}

export function listDramaJobs(projectId: string, limit = 60, signal?: AbortSignal) {
    return http.get<{ jobs: DramaJob[] }>(`${base(projectId)}/jobs`, { params: { limit }, signal });
}

export function getDramaJob(projectId: string, jobId: string, signal?: AbortSignal) {
    return http.get<DramaJobDetail>(`${base(projectId)}/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function getDramaChapter(projectId: string, chapterId: string, signal?: AbortSignal) {
    return http.get<{ chapter: { id: string; title: string; sourceText: string; wordCount: number; position: number } }>(`${base(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { signal });
}

export function getDramaEpisode(projectId: string, episodeId: string, signal?: AbortSignal) {
    return http.get<DramaEpisodeDetail>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}`, { signal });
}

export function renameDramaEpisode(projectId: string, episodeId: string, title: string) {
    return http.patch<{ episode: DramaEpisode }>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}`, { title });
}

export function approveDramaEpisode(projectId: string, episodeId: string) {
    return http.post<DramaEpisodeDetail>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/approve`);
}

export function rescriptDramaEpisode(projectId: string, episodeId: string) {
    return http.post<DramaEpisodeDetail>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/rescript`);
}

export type DramaShotPatch = Partial<Pick<DramaShot, "speaker" | "dialogue" | "action" | "shotSize" | "camera" | "imagePrompt" | "videoPrompt">> & { transition?: DramaTransition; durationSeconds?: number };

/** 让文本模型（重新）撰写指定剧情段的完整视频提示词。 */
export function writeDramaSegmentPrompts(projectId: string, episodeId: string, segments: number[]) {
    return http.post<{ queued: number }>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/segments/prompts`, { segments });
}

/** 保存整段视频提示词改写；传空串恢复为模型撰写的版本。 */
export function updateDramaSegment(projectId: string, episodeId: string, index: number, videoPromptOverride: string) {
    return http.patch<{ saved: boolean }>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/segments/${index}`, { videoPromptOverride });
}

export function updateDramaShot(projectId: string, shotId: string, patch: DramaShotPatch) {
    return http.patch<{ shot: DramaShot }>(`${base(projectId)}/shots/${encodeURIComponent(shotId)}`, patch);
}

export function listDramaCast(projectId: string, signal?: AbortSignal) {
    return http.get<{ cast: DramaCast[] }>(`${base(projectId)}/cast`, { signal });
}

export type DramaCastPatch = Partial<Pick<DramaCast, "name" | "appearance" | "description" | "voiceInstructions" | "locked">> & { aliases?: string[] };

export function updateDramaCast(projectId: string, castId: string, patch: DramaCastPatch) {
    return http.patch<{ cast: DramaCast }>(`${base(projectId)}/cast/${encodeURIComponent(castId)}`, patch);
}

export function getDramaCastImpact(projectId: string, castId: string, signal?: AbortSignal) {
    return http.get<{ segments: number; episodes: number }>(`${base(projectId)}/cast/${encodeURIComponent(castId)}/impact`, { signal });
}

/** restyleSegments=true 时引用该设定的剧情段视频标记过期，需要重新生成；段提示词保持不变。 */
export function regenerateDramaCast(projectId: string, castId: string, restyleSegments: boolean) {
    return http.post<{ affectedSegments: number }>(`${base(projectId)}/cast/${encodeURIComponent(castId)}/regenerate`, { restyleSegments });
}

/** 重新处理已生成但后处理失败的段视频：重放原任务结果，不重新生成、不扣费。 */
export function reprocessDramaSegmentVideo(projectId: string, episodeId: string, segmentIndex: number) {
    return http.post<{ reprocessing: boolean }>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/segments/${segmentIndex}/reprocess`);
}

/** 按剧情段生成视频；段会按顺序提交，第 2 段起等上一段最后一帧。可同时换视频模型。 */
export function generateDramaSegments(projectId: string, episodeId: string, segments: number[], videoModel?: DramaModelChoice) {
    return http.post<{ queued: number }>(`${base(projectId)}/episodes/${encodeURIComponent(episodeId)}/segments/generate`, { segments, ...(videoModel ? { videoModel } : {}) });
}

export function regenerateDramaCasts(projectId: string, kind: DramaCastKind, restyleSegments: boolean) {
    return http.post<{ queued: number; skipped: number; affectedSegments: number }>(`${base(projectId)}/cast/regenerate-all`, { kind, restyleSegments });
}

/** 手动模式下放行生成：assets 只生成参考图，episodes 生成指定集的参考图与段视频，all 全部开始。 */
export function releaseDramaMedia(projectId: string, target: "assets" | "episodes" | "all", episodeIds?: string[]) {
    return http.post<DramaSummary>(`${base(projectId)}/media/release`, { target, ...(episodeIds ? { episodeIds } : {}) });
}
