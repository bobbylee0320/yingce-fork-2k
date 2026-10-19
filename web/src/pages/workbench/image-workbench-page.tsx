import { App, Button, Input, InputNumber, Modal, Popover, Progress, Select, Spin, Switch, Tooltip } from "antd";
import { Check, ChevronDown, CircleAlert, Copy, FileImage, History, Images, LoaderCircle, Mic, Plus, Search, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ImageSizePicker } from "@/components/image-size-picker";
import { MediaPreview } from "@/components/media-preview";
import { ModelPicker } from "@/components/model-picker";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import { VoiceRecordingButton } from "@/components/conversation/voice-recording-button";
import { normalizeCanvasNodeMentionTokens, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { imageResolutionUsesQuality } from "@/lib/image-size-presets";
import { modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue } from "@/lib/model-capabilities";
import { creationVideoConfig } from "@/pages/create/creation-generation-config";
import { imageQualityLabel } from "@/lib/image-quality";
import { modelQuoteRequest } from "@/lib/model-pricing";
import { quoteModel } from "@/services/api/logical-models";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, cancelGenerationTask, queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { createWorkbenchTask, listWorkbenchTasks, resolveWorkbenchResourceURL, type WorkbenchKind } from "@/services/api/workbench";
import { resourceStorageKey, resolveResourceUrl, uploadResourceFile } from "@/services/api/resources";
import { formatCredits, requestCreditCost } from "@/constant/credits";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { logicalModelIDForConfig, modelDisplayName, modelOptionName, resolveModelChannel, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

import { workbenchVideoOperation } from "./workbench-input";
import "./workbench.css";
import "./workbench-count-picker.css";
import "./video-workbench.css";

export type WorkbenchReference = {
    id: string;
    name: string;
    kind: "image" | "video" | "audio";
    resourceId?: string;
    previewUrl: string;
    progress: number;
    uploading: boolean;
    error?: string;
    role: "reference" | "first_frame" | "last_frame";
};

function parseInput(inputJson?: string) {
    if (!inputJson) return null;
    try {
        const parsed: unknown = JSON.parse(inputJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
    } catch {
        return null;
    }
}

type WorkbenchTaskReferenceSnapshot = {
    resourceId: string;
    kind: WorkbenchReference["kind"];
    role?: WorkbenchReference["role"];
};

type WorkbenchTaskSnapshot = {
    kind: WorkbenchKind;
    parameters: Record<string, unknown>;
    references: WorkbenchTaskReferenceSnapshot[];
};

type ListedWorkbenchTask = GenerationTask & { workbenchKind: WorkbenchKind };

export function workbenchTaskSnapshot(task: GenerationTask): WorkbenchTaskSnapshot | null {
    const input = parseInput(task.inputJson);
    if (!input) return null;
    const metadata = input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, any>) : {};
    const metadataSnapshot = metadata.workbench && typeof metadata.workbench === "object" ? (metadata.workbench as Record<string, any>) : {};
    const snapshot = input.workbench && typeof input.workbench === "object" ? (input.workbench as Record<string, any>) : metadataSnapshot;
    const kind = snapshot.kind || metadata.workbenchKind;
    if (kind !== "image" && kind !== "video") return null;
    const rawReferences = Array.isArray(snapshot.references) ? snapshot.references : [];
    const references = rawReferences.flatMap((value: unknown): WorkbenchTaskReferenceSnapshot[] => {
        if (!value || typeof value !== "object") return [];
        const reference = value as Record<string, unknown>;
        const resourceId = typeof reference.resourceId === "string" ? reference.resourceId.trim() : "";
        const referenceKind = reference.kind;
        if (!resourceId || (referenceKind !== "image" && referenceKind !== "video" && referenceKind !== "audio")) return [];
        const role = reference.role === "first_frame" || reference.role === "last_frame" || reference.role === "reference" ? reference.role : undefined;
        return [{ resourceId, kind: referenceKind, ...(role ? { role } : {}) }];
    });
    const rawParameters = snapshot.parameters && typeof snapshot.parameters === "object" ? snapshot.parameters : {};
    return {
        kind,
        parameters: rawParameters as Record<string, unknown>,
        references,
    };
}

function taskPreview(task: GenerationTask) {
    if (task.previewUrl) return task.previewUrl;
    try {
        const result = task.resultJson ? (JSON.parse(task.resultJson) as { images?: Array<{ url?: string; dataUrl?: string }>; video?: { url?: string; dataUrl?: string } }) : null;
        return task.previewKind === "video" ? result?.video?.url || result?.video?.dataUrl || "" : result?.images?.[0]?.url || result?.images?.[0]?.dataUrl || "";
    } catch {
        return "";
    }
}

function elapsedLabel(task: GenerationTask) {
    const start = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.createdAt);
    const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function displayTaskState(task: GenerationTask) {
    if (task.status === "queued") return "排队中";
    if (task.status === "running") return task.stage || "生成中";
    if (task.status === "succeeded") return "已完成";
    if (task.status === "cancelled") return "已取消";
    return task.error || task.stage || "生成失败";
}

function revokeReferencePreview(reference: WorkbenchReference) {
    if (reference.previewUrl.startsWith("blob:")) URL.revokeObjectURL(reference.previewUrl);
}

// 历史任务可能仍记录旧模型 ID，列表用通用名称展示。
function isModelIdLike(value: string | undefined) {
    if (!value) return true;
    const normalized = value.trim();
    if (!normalized) return true;
    if (/^[a-z0-9][a-z0-9._-]{1,40}$/i.test(normalized) && /[._-]/.test(normalized)) return true;
    return false;
}

export function WorkbenchPage({ initialKind }: { initialKind: WorkbenchKind }) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [searchParams, setSearchParams] = useSearchParams();
    const [kind, setKind] = useState<WorkbenchKind>(() => searchParams.get("mode") === "image" ? "image" : searchParams.get("mode") === "video" ? "video" : initialKind);
    const [prompt, setPrompt] = useState("");
    const [references, setReferencesState] = useState<WorkbenchReference[]>([]);
    const referencesRef = useRef<WorkbenchReference[]>([]);
    const setReferences = (update: WorkbenchReference[] | ((current: WorkbenchReference[]) => WorkbenchReference[])) => {
        const next = typeof update === "function" ? update(referencesRef.current) : update;
        referencesRef.current = next;
        setReferencesState(next);
    };
    useEffect(() => () => referencesRef.current.forEach(revokeReferencePreview), []);
    const [activeTask, setActiveTask] = useState<GenerationTask | null>(null);
    const [resultHidden, setResultHidden] = useState(false);
    const workbenchRevisionRef = useRef(0);
    const [tasks, setTasks] = useState<ListedWorkbenchTask[]>([]);
    const [tasksLoading, setTasksLoading] = useState(true);
    const [detailTask, setDetailTask] = useState<GenerationTask | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const detailRequestRef = useRef(0);
    const [busy, setBusy] = useState(false);
    const submitInFlightRef = useRef(false);
    const [taskBusyId, setTaskBusyId] = useState("");
    const [mobileTab, setMobileTab] = useState("generate");
    const [query, setQuery] = useState("");
    const [taskFilter, setTaskFilter] = useState<"all" | WorkbenchKind>("all");
    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);
    const imageWorkbenchEnabled = useUserStore((state) => state.features.imageWorkbenchEnabled);
    const videoWorkbenchEnabled = useUserStore((state) => state.features.videoWorkbenchEnabled);
    const [estimateCredits, setEstimateCredits] = useState<number | null>(null);
    const [estimateEstimated, setEstimateEstimated] = useState(false);
    const [estimateTone, setEstimateTone] = useState<"quote" | "local" | "usage" | "loading" | "unavailable">("unavailable");
    const fileRef = useRef<HTMLInputElement>(null);
    const preferencesHydrated = useCreationPreferencesStore((state) => state.hydrated);
    const rememberImageSettings = useCreationPreferencesStore((state) => state.rememberImageSettings);
    const rememberVideoSettings = useCreationPreferencesStore((state) => state.rememberVideoSettings);
    const [settingsReady, setSettingsReady] = useState(false);
    const [ratio, setRatio] = useState(kind === "image" ? "1:1" : "16:9");
    const [quality, setQuality] = useState("auto");
    const [imageResolution, setImageResolution] = useState("auto");
    const [count, setCount] = useState("1");
    const [seconds, setSeconds] = useState("6");
    const [videoQuality, setVideoQuality] = useState("720");
    const capability = kind;
    const configuredModel = kind === "image" ? config.imageModel || config.model : config.videoModel || config.model;
    // 与创作页同一份可选目录。系统渠道模型通常没有 logicalModelId，不能据此滤成空列表。
    const models = useMemo(() => selectableModelsByCapability(config, capability), [capability, config]);
    const selectedModel = models.includes(configuredModel) ? configuredModel : models[0] || "";
    const profile = useMemo(() => modelCapabilityConfigFor(config, selectedModel), [config, selectedModel]);
    const imageProfile = profile.image;
    const videoProfile = profile.video;
    const activeTasks = useMemo(() => tasks.filter((task) => task.status === "queued" || task.status === "running"), [tasks]);
    const historyTasks = useMemo(() => tasks.filter((task) => task.status !== "queued" && task.status !== "running"), [tasks]);
    const visibleActiveTasks = useMemo(() => activeTasks.filter((task) => taskFilter === "all" || task.workbenchKind === taskFilter), [activeTasks, taskFilter]);
    const visibleHistoryTasks = useMemo(() => historyTasks.filter((task) => taskFilter === "all" || task.workbenchKind === taskFilter), [historyTasks, taskFilter]);
    const selectedCount = Number(count) || 1;
    const promptReferences = useMemo<CanvasResourceReference[]>(
        () =>
            references.map((reference) => ({
                id: reference.id,
                nodeId: reference.id,
                kind: reference.kind,
                label: reference.name,
                title: reference.name,
                previewUrl: reference.previewUrl,
                ...(reference.resourceId ? { storageKey: resourceStorageKey(reference.resourceId) } : {}),
                active: true,
            })),
        [references],
    );
    const composerConfig = useMemo(
        () => (kind === "video" && selectedModel ? creationVideoConfig(config, selectedModel, { ratio, seconds, videoQuality }) : { ...config, model: selectedModel, imageModel: selectedModel, size: ratio, quality, imageResolution, count }),
        [config, count, imageResolution, kind, quality, ratio, seconds, selectedModel, videoQuality],
    );


    useEffect(() => {
        if (!preferencesHydrated || settingsReady || !imageProfile || !videoProfile) return;
        const saved = useCreationPreferencesStore.getState().preferences;
        if (kind === "image") {
            const normalized = normalizeImageValue(imageProfile, {
                size: saved.image?.ratio || imageProfile.size.default,
                quality: saved.image?.quality || imageProfile.quality.default,
                imageResolution: saved.image?.imageResolution || imageProfile.resolution.default,
                count: saved.image?.count || "1",
            });
            setRatio(normalized.size);
            setQuality(normalized.quality);
            setImageResolution(normalized.imageResolution || imageProfile.resolution.default || "auto");
            setCount(normalized.count);
        } else {
            const normalized = normalizeVideoValue(videoProfile, {
                seconds: saved.video?.seconds || String(videoProfile.duration.default),
                ratio: saved.video?.ratio || videoProfile.defaultRatio,
                resolution: saved.video?.videoQuality || videoProfile.defaultResolution,
            });
            setSeconds(normalized.seconds);
            setRatio(normalized.ratio);
            setVideoQuality(normalized.resolution.replace(/p$/i, ""));
        }
        setSettingsReady(true);
    }, [imageProfile, kind, preferencesHydrated, selectedModel, settingsReady, videoProfile]);

    useEffect(() => {
        if (!settingsReady || kind !== "image" || !imageProfile) return;
        const saved = useCreationPreferencesStore.getState().preferences.image;
        const normalized = normalizeImageValue(imageProfile, {
            size: saved?.ratio || imageProfile.size.default,
            quality: saved?.quality || imageProfile.quality.default,
            imageResolution: saved?.imageResolution || imageProfile.resolution.default,
            count: saved?.count || count,
        });
        setRatio(normalized.size);
        setQuality(normalized.quality);
        setImageResolution(normalized.imageResolution || imageProfile.resolution.default || "auto");
        setCount(normalized.count);
    }, [imageProfile, kind, selectedModel, settingsReady]);

    useEffect(() => {
        if (!settingsReady || kind !== "video" || !videoProfile) return;
        const saved = useCreationPreferencesStore.getState().preferences.video;
        const normalized = normalizeVideoValue(videoProfile, {
            seconds: saved?.seconds || String(videoProfile.duration.default),
            ratio: saved?.ratio || videoProfile.defaultRatio,
            resolution: saved?.videoQuality || videoProfile.defaultResolution,
        });
        setSeconds(normalized.seconds);
        setRatio(normalized.ratio);
        setVideoQuality(normalized.resolution.replace(/p$/i, ""));
    }, [kind, selectedModel, settingsReady, videoProfile]);

    const quoteRequirements = useMemo(
        () => ({
            capability,
            input: {
                textCount: prompt.trim() ? 1 : 0,
                imageCount: references.filter((reference) => reference.kind === "image").length,
                referenceImageCount: references.filter((reference) => reference.kind === "image" && reference.role !== "first_frame" && reference.role !== "last_frame").length,
                videoCount: references.filter((reference) => reference.kind === "video").length,
                audioCount: references.filter((reference) => reference.kind === "audio").length,
                characterCount: 0,
            },
            ...(kind === "image"
                ? { imageSize: ratio, options: { size: ratio, quality, ...(imageProfile?.resolution.supported ? { imageResolution } : {}), count: selectedCount } }
                : { videoSeconds: seconds, options: { size: ratio, videoSeconds: Number(seconds), vquality: videoQuality } }),
        }),
        [capability, imageProfile, imageResolution, kind, prompt, quality, ratio, references, seconds, selectedCount, videoQuality],
    );

    useEffect(() => {
        if (!creditsEnabled || !selectedModel) {
            setEstimateCredits(null);
            setEstimateTone("unavailable");
            return;
        }
        const priceChannel = resolveModelChannel(config, selectedModel);
        const localCredits = requestCreditCost({
            channelMode: priceChannel.scope === "system" ? "remote" : "local",
            modelCosts: priceChannel.modelCosts,
            model: modelOptionName(selectedModel),
            count: kind === "image" ? selectedCount : 1,
            seconds: kind === "video" ? Number(seconds) || 1 : 1,
            capability,
            config: composerConfig,
            requirements: quoteRequirements,
        });
        const request = modelQuoteRequest(composerConfig, selectedModel, capability, quoteRequirements);
        if (!request) {
            setEstimateCredits(localCredits);
            setEstimateEstimated(false);
            setEstimateTone(localCredits === null ? "usage" : "local");
            return;
        }
        const controller = new AbortController();
        if (localCredits === null) setEstimateTone("loading");
        else {
            setEstimateCredits(localCredits);
            setEstimateTone("local");
        }
        quoteModel(request, controller.signal)
            .then(({ quote }) => {
                setEstimateCredits(quote.amountMicrocredits / 1_000_000);
                setEstimateEstimated(quote.estimated === true);
                setEstimateTone("quote");
            })
            .catch(() => {
                if (controller.signal.aborted) return;
                setEstimateCredits(localCredits);
                setEstimateEstimated(false);
                setEstimateTone(localCredits === null ? "unavailable" : "local");
            });
        return () => controller.abort();
    }, [capability, composerConfig, config, creditsEnabled, kind, quoteRequirements, seconds, selectedCount, selectedModel]);

    const loadTasks = useCallback(async () => {
        try {
            const [images, videos] = await Promise.all([
                imageWorkbenchEnabled ? listWorkbenchTasks("image", 100) : Promise.resolve([]),
                videoWorkbenchEnabled ? listWorkbenchTasks("video", 100) : Promise.resolve([]),
            ]);
            const result: ListedWorkbenchTask[] = [
                ...images.map((task) => ({ ...task, workbenchKind: "image" as const })),
                ...videos.map((task) => ({ ...task, workbenchKind: "video" as const })),
            ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
            setTasks(result);
            return result;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务列表加载失败");
            return [];
        } finally {
            setTasksLoading(false);
        }
    }, [imageWorkbenchEnabled, message, videoWorkbenchEnabled]);

    useEffect(() => {
        let stopped = false;
        let timer = 0;
        const poll = async () => {
            const revision = workbenchRevisionRef.current;
            const result = await loadTasks();
            if (stopped) return;
            if (activeTask && revision === workbenchRevisionRef.current) {
                const latest = result.find((item) => item.id === activeTask.id);
                if (latest) {
                    setActiveTask(latest);
                    if (latest.status === "succeeded" || latest.status === "failed" || latest.status === "cancelled") setMobileTab("result");
                }
            }
            timer = window.setTimeout(() => void poll(), result.some((task) => task.status === "queued" || task.status === "running") ? 5000 : 30000);
        };
        void poll();
        const onVisible = () => {
            if (!document.hidden) {
                window.clearTimeout(timer);
                void poll();
            }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            window.clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [activeTask?.id, loadTasks]);


    const switchMode = (nextKind: WorkbenchKind) => {
        if (nextKind === kind) return;
        if ((nextKind === "image" && !imageWorkbenchEnabled) || (nextKind === "video" && !videoWorkbenchEnabled)) return;
        references.filter((reference) => nextKind === "image" && reference.kind !== "image").forEach(revokeReferencePreview);
        setReferences((current) => current.filter((reference) => nextKind === "video" || reference.kind === "image").map((reference) => ({ ...reference, role: "reference" })));
        const params = new URLSearchParams(searchParams);
        params.set("mode", nextKind);
        params.delete("tool");
        params.delete("preset");
        setSearchParams(params, { replace: true });
        setKind(nextKind);
    };


    const updateImageSettings = (size: string, nextQuality?: string, nextResolution?: string) => {
        setRatio(size);
        rememberImageSettings({ ratio: size });
        if (nextQuality) {
            setQuality(nextQuality);
            rememberImageSettings({ quality: nextQuality });
        }
        if (nextResolution) {
            setImageResolution(nextResolution);
            rememberImageSettings({ imageResolution: nextResolution });
        }
    };

    const addFiles = async (files: FileList | File[]) => {
        const list = Array.from(files);
        const allowedTypes = kind === "image" ? ["image"] : ["image", "video", "audio"];
        const accepted = list.filter((file) => allowedTypes.some((type) => file.type.startsWith(`${type}/`)));
        if (accepted.length !== list.length) message.warning(kind === "image" ? "图片创作仅支持图片素材" : "仅支持图片、视频和音频素材");
        const limits = kind === "image"
            ? { image: imageProfile?.references.maxImages || 0, video: 0, audio: 0 }
            : { image: videoProfile?.references.maxImages || 0, video: videoProfile?.references.maxVideos || 0, audio: videoProfile?.references.maxAudios || 0 };
        const counts = {
            image: references.filter((reference) => reference.kind === "image").length,
            video: references.filter((reference) => reference.kind === "video").length,
            audio: references.filter((reference) => reference.kind === "audio").length,
        };
        const picked = accepted.filter((file) => {
            const fileKind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio";
            if (counts[fileKind] >= limits[fileKind]) return false;
            counts[fileKind] += 1;
            return true;
        });
        if (picked.length < accepted.length) message.warning("部分素材超过当前模型的参考数量上限，未添加");
        const pending: WorkbenchReference[] = picked.map((file) => ({
            id: crypto.randomUUID(),
            name: file.name,
            kind: (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio") as WorkbenchReference["kind"],
            previewUrl: URL.createObjectURL(file),
            progress: 0,
            uploading: true,
            role: "reference" as const,
        }));
        setReferences((current) => [...current, ...pending]);
        await Promise.all(
            pending.map(async (reference, index) => {
                const file = picked[index];
                try {
                    const resource = await uploadResourceFile(file, reference.kind, { fileName: file.name }, (uploaded, total) => {
                        setReferences((current) => current.map((item) => (item.id === reference.id ? { ...item, progress: total ? (uploaded / total) * 100 : 0 } : item)));
                    });
                    setReferences((current) => current.map((item) => (item.id === reference.id ? { ...item, resourceId: resource.id, uploading: false, progress: 100 } : item)));
                } catch (error) {
                    setReferences((current) => current.map((item) => (item.id === reference.id ? { ...item, uploading: false, error: error instanceof Error ? error.message : "上传失败" } : item)));
                }
            }),
        );
    };

    const removeReference = (reference: WorkbenchReference) => {
        revokeReferencePreview(reference);
        setReferences((current) => current.filter((item) => item.id !== reference.id));
    };

    const submit = async () => {
        if (submitInFlightRef.current) return;
        const revision = workbenchRevisionRef.current;
        const submittedPrompt = normalizeCanvasNodeMentionTokens(prompt.trim(), promptReferences);
        if (!submittedPrompt) {
            message.warning("请填写提示词");
            return;
        }
        const logicalModelId = logicalModelIDForConfig({ ...composerConfig, model: selectedModel });
        const channel = resolveModelChannel(config, selectedModel);
        if (!selectedModel || !models.includes(selectedModel)) {
            message.error(`请选择可用的${kind === "image" ? "图片" : "视频"}模型`);
            return;
        }
        if (!isAiConfigReady(config, selectedModel)) {
            message.error("当前模型配置不完整，请先完成模型设置");
            return;
        }
        if (references.some((reference) => reference.uploading || reference.error || !reference.resourceId)) {
            message.warning("请等待参考素材上传完成或移除失败素材");
            return;
        }
        if (submittedPrompt.length > (kind === "image" ? imageProfile?.references.promptMaxChars || 32000 : videoProfile?.references.promptMaxChars || 8000)) {
            message.error("提示词超过当前模型支持的长度");
            return;
        }
        submitInFlightRef.current = true;
        setBusy(true);
        try {
            const imageRequest = kind === "image" && imageProfile ? normalizeImageValue(imageProfile, { size: ratio, quality, imageResolution, imageParameters: config.imageParameters, count, transparentBackground: config.transparentBackground }) : null;
            const videoRequest = kind === "video" && videoProfile ? normalizeVideoValue(videoProfile, { seconds, ratio, resolution: videoQuality }) : null;
            const parameters = imageRequest
                ? { size: imageRequest.size, quality: imageRequest.quality, imageResolution: imageRequest.imageResolution, count: Number(imageRequest.count) }
                : {
                      seconds: Number(videoRequest?.seconds || seconds),
                      ratio: videoRequest?.ratio || ratio,
                      resolution: videoRequest?.resolution || videoQuality,
                      generateAudio: composerConfig.videoGenerateAudio === "true",
                      watermark: composerConfig.videoWatermark === "true",
                  };
            const generationConfig = {
                ...composerConfig,
                model: selectedModel,
                ...(imageRequest ? { imageModel: selectedModel, size: imageRequest.size, quality: imageRequest.quality, imageResolution: imageRequest.imageResolution, count: imageRequest.count } : {}),
                ...(videoRequest ? { videoModel: selectedModel, size: videoRequest.ratio, videoSeconds: videoRequest.seconds, vquality: videoRequest.resolution.replace(/p$/i, "") } : {}),
            };
            const readyReferences = references.filter((reference) => reference.resourceId);
            const videoOperation = kind === "video" ? workbenchVideoOperation(readyReferences) : undefined;
            const referenceSnapshot = readyReferences.map((reference) => ({ resourceId: reference.resourceId!, kind: reference.kind, role: reference.role }));
            const createdTask =
                logicalModelId || channel?.scope === "system"
                    ? await createWorkbenchTask({
                          kind,
                          prompt: submittedPrompt,
                          model: modelOptionName(selectedModel),
                          ...(logicalModelId ? { logicalModelId } : { channelId: channel.id }),
                          parameters,
                          references: referenceSnapshot,
                      })
                    : await prepareBackendGenerationTask({
                          mode: kind,
                          prompt: submittedPrompt,
                          config: generationConfig,
                          referenceImages: readyReferences
                              .filter((reference) => reference.kind === "image")
                              .map((reference) => ({
                                  id: reference.id,
                                  name: reference.name,
                                  type: "image/*",
                                  dataUrl: "",
                                  storageKey: resourceStorageKey(reference.resourceId!),
                                  role: reference.role,
                              })),
                          referenceVideos: readyReferences
                              .filter((reference) => reference.kind === "video")
                              .map((reference) => ({
                                  id: reference.id,
                                  name: reference.name,
                                  type: "video/*",
                                  url: "",
                                  storageKey: resourceStorageKey(reference.resourceId!),
                                  role: reference.role,
                              })),
                          referenceAudios: readyReferences
                              .filter((reference) => reference.kind === "audio")
                              .map((reference) => ({
                                  id: reference.id,
                                  name: reference.name,
                                  type: "audio/*",
                                  url: "",
                                  storageKey: resourceStorageKey(reference.resourceId!),
                                  role: reference.role,
                              })),
                          metadata: {
                              source: "workbench",
                              workbenchKind: kind,
                              ...(videoOperation ? { videoEditOperation: videoOperation } : {}),
                              ...Object.fromEntries(
                                  readyReferences
                                      .filter((reference) => reference.role === "first_frame" || reference.role === "last_frame")
                                      .map((reference) => [reference.role === "first_frame" ? "videoStartFrameNodeId" : "videoEndFrameNodeId", reference.id]),
                              ),
                              workbench: { kind, parameters, references: referenceSnapshot },
                          },
                      }).then((taskInput) => createGenerationTask({ ...taskInput, ...(videoOperation ? { operation: videoOperation } : {}) }));
            const task = await queryGenerationTask(createdTask.id);
            setTasks((current) => [{ ...task, workbenchKind: kind }, ...current.filter((item) => item.id !== task.id)]);
            if (revision === workbenchRevisionRef.current) {
                setResultHidden(false);
                setActiveTask(task);
                setMobileTab("result");
            }
            message.success("生成任务已提交");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务提交失败");
        } finally {
            submitInFlightRef.current = false;
            setBusy(false);
        }
    };

    const cancelTask = async (task: GenerationTask) => {
        setTaskBusyId(task.id);
        try {
            const next = await cancelGenerationTask(task.id);
            setTasks((current) => current.map((item) => (item.id === task.id ? { ...next, workbenchKind: item.workbenchKind } : item)));
            if (activeTask?.id === task.id) setActiveTask(next);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "取消任务失败");
        } finally {
            setTaskBusyId("");
        }
    };

    const restoreTaskToComposer = async (task: GenerationTask, notify = true) => {
        const snapshot = workbenchTaskSnapshot(task);
        if (!snapshot) {
            if (notify) message.warning("该任务没有可恢复的工作台参数");
            return false;
        }
        const parameters = snapshot.parameters;
        if (snapshot.kind !== kind) {
            setKind(snapshot.kind);
        }
        if (snapshot.kind === "image") {
            const restoredRatio = typeof parameters.size === "string" ? parameters.size : ratio;
            const restoredQuality = typeof parameters.quality === "string" ? parameters.quality : quality;
            const restoredResolution = typeof parameters.imageResolution === "string" ? parameters.imageResolution : imageResolution;
            const restoredCount = parameters.count != null ? String(parameters.count) : count;
            setRatio(restoredRatio);
            setQuality(restoredQuality);
            setImageResolution(restoredResolution);
            setCount(restoredCount);
            rememberImageSettings({ ratio: restoredRatio, quality: restoredQuality, imageResolution: restoredResolution, count: restoredCount });
        } else {
            const restoredSeconds = parameters.seconds != null ? String(parameters.seconds) : seconds;
            const restoredRatio = typeof parameters.ratio === "string" ? parameters.ratio : ratio;
            const restoredQuality = typeof parameters.resolution === "string" ? parameters.resolution.replace(/p$/i, "") : videoQuality;
            setSeconds(restoredSeconds);
            setRatio(restoredRatio);
            setVideoQuality(restoredQuality);
            rememberVideoSettings({ seconds: restoredSeconds, ratio: restoredRatio, videoQuality: restoredQuality });
            if (typeof parameters.generateAudio === "boolean") updateConfig("videoGenerateAudio", String(parameters.generateAudio));
            if (typeof parameters.watermark === "boolean") updateConfig("videoWatermark", String(parameters.watermark));
        }
        const targetModels = selectableModelsByCapability(config, snapshot.kind);
        const restoredModel = task.model ? targetModels.find((item) => item === task.model || modelOptionName(item) === task.model) : undefined;
        if (restoredModel) {
            updateConfig(snapshot.kind === "image" ? "imageModel" : "videoModel", restoredModel);
            updateConfig("model", restoredModel);
        }
        setPrompt(task.prompt || "");
        referencesRef.current.forEach(revokeReferencePreview);
        setReferences([]);
        const restoredReferences = await Promise.all(
            snapshot.references.map(async (reference, index): Promise<WorkbenchReference> => ({
                id: crypto.randomUUID(),
                name: `${reference.kind === "image" ? "图片" : reference.kind === "video" ? "视频" : "音频"} ${index + 1}`,
                kind: reference.kind,
                resourceId: reference.resourceId,
                previewUrl: (await resolveWorkbenchResourceURL(reference.resourceId, "original")) || "",
                progress: 100,
                uploading: false,
                role: reference.role || "reference",
            })),
        );
        setReferences(restoredReferences);
        const params = new URLSearchParams(searchParams);
        params.set("mode", snapshot.kind);
        params.delete("tool");
        params.delete("preset");
        setSearchParams(params, { replace: true });
        setActiveTask(task);
        setResultHidden(false);
        setMobileTab("generate");
        setDetailTask(null);
        if (notify) message.success("任务配置已载入编辑器");
        return true;
    };

    const retryTask = async (task: GenerationTask) => {
        setTaskBusyId(task.id);
        try {
            let restoreSource = task;
            if (!restoreSource.inputJson) {
                try {
                    restoreSource = await queryGenerationTask(task.id);
                } catch {
                    // The retry response also contains the safe restore snapshot.
                }
            }
            const restored = await restoreTaskToComposer(restoreSource, false);
            const next = await retryGenerationTask(task.id);
            if (!restored) await restoreTaskToComposer(next, false);
            setTasks((current) => [{ ...next, workbenchKind: workbenchTaskSnapshot(next)?.kind || workbenchTaskSnapshot(task)?.kind || kind }, ...current.filter((item) => item.id !== next.id)]);
            setActiveTask(next);
            message.success("任务已重新提交");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重试任务失败");
        } finally {
            setTaskBusyId("");
        }
    };

    const openDetail = async (task: GenerationTask) => {
        const requestId = ++detailRequestRef.current;
        setDetailTask(task);
        setDetailLoading(true);
        try {
            const detail = await queryGenerationTask(task.id);
            if (requestId === detailRequestRef.current) setDetailTask(detail);
        } catch (error) {
            if (requestId === detailRequestRef.current) message.error(error instanceof Error ? error.message : "任务详情加载失败");
        } finally {
            if (requestId === detailRequestRef.current) setDetailLoading(false);
        }
    };

    const estimateLabel = !creditsEnabled
        ? ""
        : estimateCredits !== null
          ? `${estimateEstimated || estimateTone !== "quote" ? "预估" : "预计"} ${estimateCredits.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分`
          : estimateTone === "loading"
            ? "正在计算积分"
            : estimateTone === "usage"
              ? "按实际用量结算"
              : "报价暂不可用";
    const taskModelLabel = (task: GenerationTask) => {
        const rawModel = task.model?.trim() || "";
        if (!rawModel) return (tasks.find((item) => item.id === task.id)?.workbenchKind || task.previewKind || kind) === "image" ? "图片生成" : "视频生成";
        const configuredModel = models.find((item) => item === rawModel || modelOptionName(item) === rawModel);
        const display = configuredModel ? modelDisplayName(config, configuredModel) : rawModel;
        return isModelIdLike(display) || display === "未分类" ? (task.previewKind === "video" ? "视频生成" : "图片生成") : display;
    };
    const resultTask = resultHidden ? null : activeTask || tasks[0] || null;
    const resultKind = resultTask ? tasks.find((task) => task.id === resultTask.id)?.workbenchKind || workbenchTaskSnapshot(resultTask)?.kind || resultTask.previewKind || kind : kind;
    const resultUrl = resultTask ? taskPreview(resultTask) : "";
    const settingsPanel =
        kind === "image" && imageProfile ? (
            <div className="workbench-settings-content">
                <ImageSizePicker profile={imageProfile} size={ratio} quality={quality} imageResolution={imageResolution} onChange={updateImageSettings} />
                {imageProfile.quality.supported && !imageResolutionUsesQuality(imageProfile) ? (
                    <label className="workbench-setting-row">
                        <span>图片质量</span>
                        <Select
                            value={quality}
                            onChange={(value) => {
                                setQuality(value);
                                rememberImageSettings({ quality: value });
                            }}
                            options={imageProfile.quality.values.map((value) => ({ value, label: imageQualityLabel(value) }))}
                        />
                    </label>
                ) : null}
                <CountPicker
                    value={count}
                    max={imageProfile.maxOutputs}
                    onChange={(value) => {
                        setCount(value);
                        rememberImageSettings({ count: value });
                    }}
                />
            </div>
        ) : videoProfile ? (
            <div className="workbench-settings-content">
                <ParameterChips
                    label="视频时长"
                    value={seconds}
                    options={(videoProfile.duration.selection === "enum"
                        ? videoProfile.duration.values || []
                        : Array.from(
                              { length: Math.floor(((videoProfile.duration.max || 15) - (videoProfile.duration.min || 1)) / (videoProfile.duration.step || 1)) + 1 },
                              (_, index) => (videoProfile.duration.min || 1) + index * (videoProfile.duration.step || 1),
                          )
                    ).map((value) => ({ value: String(value), label: `${value} 秒` }))}
                    onChange={(value) => {
                        setSeconds(value);
                        rememberVideoSettings({ seconds: value });
                    }}
                />
                <ParameterChips
                    label="画面比例"
                    value={ratio}
                    options={videoProfile.ratios.map((value) => ({ value, label: value === "adaptive" ? "自适应" : value }))}
                    onChange={(value) => {
                        setRatio(value);
                        rememberVideoSettings({ ratio: value });
                    }}
                />
                <ParameterChips
                    label="清晰度"
                    value={videoQuality}
                    options={videoProfile.resolutions.map((value) => ({ value: value.replace(/p$/i, ""), label: value }))}
                    onChange={(value) => {
                        setVideoQuality(value);
                        rememberVideoSettings({ videoQuality: value });
                    }}
                />
                {videoProfile.generateAudio.supported || videoProfile.watermark.supported ? (
                    <div className="workbench-switch-row">
                        {videoProfile.generateAudio.supported ? (
                            <label>
                                <span>生成音频</span>
                                <Switch checked={config.videoGenerateAudio === "true"} onChange={(value) => updateConfig("videoGenerateAudio", String(value))} />
                            </label>
                        ) : null}
                        {videoProfile.watermark.supported ? (
                            <label>
                                <span>添加水印</span>
                                <Switch checked={config.videoWatermark === "true"} onChange={(value) => updateConfig("videoWatermark", String(value))} />
                            </label>
                        ) : null}
                    </div>
                ) : null}
            </div>
        ) : (
            <p className="workbench-list-empty">选择模型后，这里会显示该模型真正支持的参数。</p>
        );

    const unifiedLayout = (
        <div className="workbench-shell workbench-video-shell" data-kind={kind}>
            <div className="workbench-video-layout">
                <aside className="workbench-video-queue" aria-label="图片和视频任务队列">
                    <div className="workbench-section-heading">
                        <div>
                            <h2>任务队列</h2>
                            <span>{tasks.length} 项任务 · 可并发创作</span>
                        </div>
                        <Tooltip title="刷新任务">
                            <button type="button" aria-label="刷新生成任务" onClick={() => void loadTasks()}><History /></button>
                        </Tooltip>
                    </div>
                    <div className="workbench-video-task-filters" role="group" aria-label="筛选任务类型">
                        {([{ value: "all", label: "全部" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }] as const).map((option) => (
                            <button key={option.value} type="button" aria-pressed={taskFilter === option.value} onClick={() => {
                                setTaskFilter(option.value);
                                if (option.value === "all") setResultHidden(false);
                                else if (!resultTask || resultKind !== option.value) {
                                    const next = tasks.find((task) => task.workbenchKind === option.value) || null;
                                    setActiveTask(next);
                                    setResultHidden(!next);
                                }
                            }}>{option.label}</button>
                        ))}
                    </div>
                    <Input aria-label="搜索生成任务" prefix={<Search className="size-3.5" />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词" allowClear />
                    <div className="workbench-video-queue-content">
                        <section>
                            <h3>进行中 <span>{visibleActiveTasks.length}</span></h3>
                            {visibleActiveTasks.length ? visibleActiveTasks.filter((task) => !query.trim() || task.prompt.toLowerCase().includes(query.trim().toLowerCase())).map((task) => (
                                <TaskRow key={task.id} task={task} kind={task.workbenchKind} modelLabel={taskModelLabel(task)} busy={taskBusyId === task.id} selected={resultTask?.id === task.id}
                                    onOpen={() => { setActiveTask(task); setResultHidden(false); }} onCancel={() => void cancelTask(task)} />
                            )) : <p className="workbench-list-empty">暂无进行中的任务</p>}
                        </section>
                        <section>
                            <div className="workbench-video-history-heading"><h3>历史生成 <span>{visibleHistoryTasks.length}</span></h3></div>
                            {tasksLoading ? <Spin size="small" /> : visibleHistoryTasks.filter((task) => !query.trim() || task.prompt.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50).map((task) => (
                                <TaskRow key={task.id} task={task} kind={task.workbenchKind} modelLabel={taskModelLabel(task)} busy={taskBusyId === task.id} selected={resultTask?.id === task.id}
                                    onOpen={() => { setActiveTask(task); setResultHidden(false); }} onRetry={task.status === "failed" || task.status === "cancelled" ? () => void retryTask(task) : undefined} />
                            ))}
                            {!tasksLoading && !visibleHistoryTasks.length ? <p className="workbench-list-empty">完成的作品会保留在这里</p> : null}
                        </section>
                    </div>
                </aside>

                <main className="workbench-video-main" aria-label="当前作品与创作输入">
                    <section className="workbench-video-stage" aria-label="选中任务的作品">
                        <div className="workbench-section-heading">
                            <div><h2>{resultTask ? taskModelLabel(resultTask) : kind === "video" ? "生成视频" : "生成图片"}</h2><span>{resultTask ? displayTaskState(resultTask) : "选择左侧任务查看作品"}</span></div>
                            {resultTask ? <Button size="small" onClick={() => void openDetail(resultTask)}>任务详情</Button> : null}
                        </div>
                        {!resultTask ? (
                            <div className="workbench-empty-result"><div className="workbench-stage-frame" aria-hidden><span className="workbench-empty-mark">{kind === "video" ? <Video /> : <Images />}</span></div><strong>{kind === "video" ? "视频" : "图片"}会显示在这里</strong><span>在下方描述画面并开始创作。</span></div>
                        ) : resultTask.status === "queued" || resultTask.status === "running" ? (
                            <div className="workbench-generating"><div className="workbench-flow-skeleton"><span /><span /><span /></div><strong>{displayTaskState(resultTask)}</strong><span>任务完成后，作品会自动显示在这里</span><Progress percent={resultTask.progress || 8} showInfo={false} /></div>
                        ) : resultTask.status === "succeeded" && resultUrl ? (
                            <div className="workbench-result-media">{resultKind === "video" ? <video key={resultTask.id} src={resultUrl} controls playsInline /> : <MediaPreview src={resultUrl} kind="image" alt="生成图片" className="size-full object-contain" fallbackLabel="图片暂不可用" />}<div className="workbench-result-caption"><span>{taskModelLabel(resultTask)}</span><span>{elapsedLabel(resultTask)}</span></div></div>
                        ) : (
                            <div className="workbench-result-error"><div className="workbench-video-error-card"><span className="workbench-video-error-icon"><CircleAlert /></span><strong>本次生成未完成</strong><span>{displayTaskState(resultTask)}</span><Button onClick={() => void openDetail(resultTask)}>查看任务详情</Button></div></div>
                        )}
                    </section>

                    <section className="workbench-video-composer" aria-label="创作新作品">
                        <div className="workbench-video-composer-heading"><span>{kind === "video" ? "视频创作" : "图片创作"}</span><span>描述你的画面，随时开启下一项任务</span></div>
                        <CanvasResourceMentionTextarea
                            aria-label="生成提示词，可输入 @ 引用参考素材"
                            className="workbench-video-prompt"
                            containerClassName="workbench-video-prompt-container"
                            value={prompt}
                            references={promptReferences}
                            onChange={setPrompt}
                            onSubmit={() => void submit()}
                            sendOnEnter={false}
                            style={{ color: "var(--wb-text)" }}
                            placeholder={kind === "video" ? "描述镜头内容、运动、光线与节奏" : "描述画面主体、构图、风格与光线"}
                            maxLength={kind === "video" ? videoProfile?.references.promptMaxChars || 8000 : imageProfile?.references.promptMaxChars || 32000}
                        />
                        {references.length ? <div className="workbench-video-reference-strip" aria-label="当前创作参考素材">{references.map((reference) => <span key={reference.id}>{reference.kind === "image" ? <Images /> : reference.kind === "video" ? <Video /> : <Mic />}{reference.name}</span>)}</div> : null}
                        <div className="workbench-video-composer-controls">
                            <div className="workbench-video-controls-start">
                            <div className="workbench-video-mode" role="group" aria-label="创作类型"><button type="button" aria-pressed={kind === "video"} disabled={!videoWorkbenchEnabled} onClick={() => switchMode("video")}><Video />视频</button><button type="button" aria-pressed={kind === "image"} disabled={!imageWorkbenchEnabled} onClick={() => switchMode("image")}><Images />图片</button><Link to="/create">文本</Link></div>
                            <Popover trigger="click" placement="topLeft" content={<div className="workbench-video-reference-popover">
                                {references.map((reference) => <ReferenceCard key={reference.id} reference={reference} kind={kind} onRemove={removeReference} onRoleChange={(role) => setReferences((current) => current.map((item) => item.id === reference.id ? { ...item, role } : item))} />)}
                                <Button size="small" icon={<Plus />} onClick={() => fileRef.current?.click()}>添加参考素材</Button>
                            </div>}>
                                <button type="button" className="workbench-video-control"><Plus />参考内容{references.length ? ` ${references.length}` : ""}</button>
                            </Popover>
                            <VoiceRecordingButton className="workbench-video-voice" disabled={busy} onTranscribed={(text) => setPrompt((current) => current.trim() ? `${current} ${text}` : text)} />
                            </div>
                            <div className="workbench-video-controls-settings">
                            {models.length ? <ModelPicker config={config} value={selectedModel} capability={kind} requirements={quoteRequirements} variant="creation" className="creation-model-picker workbench-video-model-picker" showSelectedPrice={false} showOptionPrices onChange={(value) => { updateConfig(kind === "video" ? "videoModel" : "imageModel", value); updateConfig("model", value); }} placeholder={`选择${kind === "video" ? "视频" : "图片"}模型`} /> : <span className="workbench-model-empty">暂无可用{kind === "video" ? "视频" : "图片"}模型</span>}
                            <Popover trigger="click" placement="top" content={settingsPanel}><button type="button" className="workbench-video-control"><span>{kind === "video" ? `${ratio} · ${videoQuality}P` : `${ratio} · ${imageResolution}`}</span><ChevronDown /></button></Popover>
                            <Popover trigger="click" placement="top" content={settingsPanel}><button type="button" className="workbench-video-control"><span>{kind === "video" ? `${seconds}s` : `${count} 张`}</span><ChevronDown /></button></Popover>
                            </div>
                            <div className="workbench-video-controls-action">
                            <span className="workbench-video-cost" aria-live="polite">{estimateLabel}</span>
                            <Button className="workbench-video-submit" type="primary" loading={busy} disabled={!prompt.trim() || !selectedModel || references.some((reference) => reference.uploading || Boolean(reference.error))} onClick={() => void submit()}>开始创作</Button>
                            </div>
                        </div>
                        <input ref={fileRef} type="file" className="sr-only" accept={kind === "video" ? "image/*,video/*,audio/*" : "image/*"} multiple onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.currentTarget.value = ""; }} />
                    </section>
                </main>

                <WorkbenchVideoContext task={resultTask} />
            </div>
        </div>
    );

    return (
        <WorkspacePage fluid scroll={false} className="workbench-page">
            {unifiedLayout}

            <Modal
                title={detailTask ? ((tasks.find((task) => task.id === detailTask.id)?.workbenchKind || workbenchTaskSnapshot(detailTask)?.kind || detailTask.previewKind) === "video" ? "视频任务详情" : "图片任务详情") : "任务详情"}
                open={Boolean(detailTask)}
                onCancel={() => {
                    detailRequestRef.current += 1;
                    setDetailLoading(false);
                    setDetailTask(null);
                }}
                footer={null}
                width={960}
                className="workbench-detail-modal"
            >
                {detailTask ? (
                    <div className="workbench-detail-grid">
                        <div className="workbench-detail-media">
                            {taskPreview(detailTask) ? (
                                (tasks.find((task) => task.id === detailTask.id)?.workbenchKind || workbenchTaskSnapshot(detailTask)?.kind || detailTask.previewKind) === "video" ? (
                                    <video src={taskPreview(detailTask)} controls playsInline />
                                ) : (
                                    <MediaPreview src={taskPreview(detailTask)} kind="image" alt="生成结果" className="size-full object-contain" />
                                )
                            ) : (
                                <div className="workbench-guide-empty">{displayTaskState(detailTask)}</div>
                            )}
                        </div>
                        <div className="workbench-detail-info">
                            <span className={`workbench-status is-${detailTask.status}`}>{displayTaskState(detailTask)}</span>
                            <h3>{taskModelLabel(detailTask)}</h3>
                            <label>提示词</label>
                            <p className="workbench-detail-prompt">{detailTask.prompt}</p>
                            <label>参数</label>
                            <pre>{detailLoading ? "正在加载任务参数…" : JSON.stringify(workbenchTaskSnapshot(detailTask)?.parameters || {}, null, 2)}</pre>
                            <dl>
                                <div>
                                    <dt>耗时</dt>
                                    <dd>{elapsedLabel(detailTask)}</dd>
                                </div>
                                <div>
                                    <dt>积分</dt>
                                    <dd>{detailTask.billing ? `${formatCredits(detailTask.billing.amountMicrocredits)} · ${detailTask.billing.status}` : "--"}</dd>
                                </div>
                                <div>
                                    <dt>创建时间</dt>
                                    <dd>{new Date(detailTask.createdAt).toLocaleString()}</dd>
                                </div>
                            </dl>
                            <div className="workbench-detail-actions">
                                <Button disabled={detailLoading} onClick={() => void restoreTaskToComposer(detailTask)}>
                                    载入到编辑器
                                </Button>
                                {detailTask.status === "failed" || detailTask.status === "cancelled" ? (
                                    <Button type="primary" loading={taskBusyId === detailTask.id} disabled={detailLoading} onClick={() => void retryTask(detailTask)}>
                                        重新生成
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}
            </Modal>

        </WorkspacePage>
    );
}

function CountPicker({ value, max, onChange }: { value: string; max: number; onChange: (value: string) => void }) {
    const limit = Math.min(10, Math.max(1, max || 1));
    const current = Math.min(limit, Math.max(1, Math.floor(Number(value) || 1)));
    return (
        <div className="workbench-count-picker">
            <span>生成数量</span>
            <div>
                {Array.from({ length: limit }, (_, index) => index + 1).map((item) => (
                    <button key={item} type="button" aria-pressed={current === item} className={current === item ? "is-active" : ""} onClick={() => onChange(String(item))}>
                        {item}
                    </button>
                ))}
                <InputNumber min={1} max={limit} precision={0} value={current} aria-label="输入生成数量" onChange={(next) => onChange(String(Math.min(limit, Math.max(1, Number(next) || 1))))} />
            </div>
        </div>
    );
}

function ParameterChips({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
    if (options.length > 7) {
        return (
            <label className="workbench-setting-row">
                <span>{label}</span>
                <Select aria-label={label} value={value} onChange={onChange} options={options} />
            </label>
        );
    }
    return (
        <div className="workbench-chip-field">
            <span>{label}</span>
            <div role="radiogroup" aria-label={label}>
                {options.map((option) => (
                    <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "is-active" : ""} onClick={() => onChange(option.value)}>
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}


function ReferenceCard({ reference, kind, onRemove, onRoleChange }: { reference: WorkbenchReference; kind: WorkbenchKind; onRemove: (reference: WorkbenchReference) => void; onRoleChange: (role: WorkbenchReference["role"]) => void }) {
    return (
        <div className="workbench-reference">
            {reference.kind === "video" ? (
                <video src={reference.previewUrl} muted />
            ) : reference.kind === "audio" ? (
                <span className="workbench-audio-reference">
                    <Mic />
                </span>
            ) : (
                <img src={reference.previewUrl} alt={reference.name} />
            )}
            {reference.uploading ? <Progress type="circle" percent={Math.round(reference.progress)} size={34} /> : null}
            {reference.error ? (
                <span className="workbench-reference-error" title={reference.error}>
                    上传失败
                </span>
            ) : null}
            <button type="button" aria-label={`移除${reference.name}`} onClick={() => onRemove(reference)}>
                <X />
            </button>
            {kind === "video" && reference.kind === "image" ? (
                <Select
                    size="small"
                    value={reference.role}
                    onChange={onRoleChange}
                    options={[
                        { label: "参考图", value: "reference" },
                        { label: "首帧", value: "first_frame" },
                        { label: "尾帧", value: "last_frame" },
                    ]}
                />
            ) : null}
        </div>
    );
}

function TaskRow({ task, kind, modelLabel, busy, selected = false, onOpen, onCancel, onRetry }: { task: GenerationTask; kind: WorkbenchKind; modelLabel: string; busy: boolean; selected?: boolean; onOpen: () => void; onCancel?: () => void; onRetry?: () => void }) {
    const url = taskPreview(task);
    return (
        <article className={`workbench-task-row ${selected ? "is-selected" : ""}`}>
            <button type="button" className="workbench-task-main" aria-pressed={selected} onClick={onOpen}>
                <span className="workbench-task-thumb">{url && task.previewKind !== "video" ? <MediaPreview src={url} kind="image" alt="" className="size-full object-cover" /> : kind === "video" ? <Video /> : <FileImage />}</span>
                <span className="workbench-task-copy">
                    <strong>{modelLabel}</strong>
                    <small>{task.prompt}</small>
                    <em>
                        {kind === "image" ? "图片" : "视频"} · {displayTaskState(task)} · {elapsedLabel(task)}
                    </em>
                </span>
            </button>
            {onCancel ? (
                <Tooltip title="取消任务">
                    <Button type="text" aria-label="取消任务" icon={<X className="size-3.5" />} loading={busy} onClick={onCancel} />
                </Tooltip>
            ) : null}
            {onRetry ? (
                <Tooltip title="重试任务">
                    <Button type="text" aria-label="重试任务" icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} disabled={busy} onClick={onRetry} />
                </Tooltip>
            ) : null}
        </article>
    );
}

function WorkbenchVideoContext({ task }: { task: GenerationTask | null }) {
    const { message } = App.useApp();
    const [detail, setDetail] = useState<GenerationTask | null>(null);
    const [referenceUrls, setReferenceUrls] = useState<Array<string | undefined>>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!task) {
            setDetail(null);
            setReferenceUrls([]);
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        setDetail(task);
        setReferenceUrls([]);
        setLoading(true);
        void (async () => {
            try {
                const loaded = await queryGenerationTask(task.id, { signal: controller.signal });
                const snapshot = workbenchTaskSnapshot(loaded);
                const urls = await Promise.all(snapshot?.references.map((reference) => resolveWorkbenchResourceURL(reference.resourceId)) || []);
                if (!controller.signal.aborted) {
                    setDetail(loaded);
                    setReferenceUrls(urls);
                }
            } catch {
                // The queue item still contains the prompt when task details cannot be loaded.
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [task?.id]);

    const shownTask = detail?.id === task?.id ? detail : task;
    const references = shownTask ? workbenchTaskSnapshot(shownTask)?.references || [] : [];
    const roleLabel = (reference: WorkbenchTaskReferenceSnapshot) => reference.role === "first_frame" ? "首帧" : reference.role === "last_frame" ? "尾帧" : reference.kind === "video" ? "参考视频" : reference.kind === "audio" ? "参考音频" : "参考图";

    return (
        <aside className="workbench-video-context" aria-label="当前作品的提示词和参考素材">
            <div className="workbench-section-heading"><div><h2>创作信息</h2><span>跟随中间选中的作品切换</span></div></div>
            {!task ? <p className="workbench-list-empty">从左侧选择任务，查看提示词和参考素材</p> : (
                <div className="workbench-video-context-content">
                    <section>
                        <div className="workbench-video-context-heading"><h3>生成提示词</h3><Tooltip title="复制提示词"><button type="button" aria-label="复制生成提示词" onClick={() => void navigator.clipboard.writeText(shownTask?.prompt || "").then(() => message.success("提示词已复制"), () => message.error("复制失败"))}><Copy /></button></Tooltip></div>
                        <p className="workbench-video-context-prompt">{shownTask?.prompt || "未填写提示词"}</p>
                    </section>
                    <section>
                        <div className="workbench-video-context-heading"><h3>参考素材</h3><span>{loading ? "加载中" : `${references.length} 项`}</span></div>
                        {references.length ? <div className="workbench-video-context-references">{references.map((reference, index) => (
                            <div className="workbench-video-context-reference" key={`${reference.resourceId}-${index}`}>
                                {referenceUrls[index] ? reference.kind === "image" ? <img src={referenceUrls[index]} alt={roleLabel(reference)} /> : reference.kind === "video" ? <video src={referenceUrls[index]} controls preload="metadata" /> : <audio src={referenceUrls[index]} controls preload="none" /> : <span className="workbench-video-context-placeholder">{reference.kind === "image" ? <Images /> : reference.kind === "video" ? <Video /> : <Mic />}</span>}
                                <span>{roleLabel(reference)}</span>
                            </div>
                        ))}</div> : !loading ? <p className="workbench-list-empty">这项任务没有参考素材</p> : null}
                    </section>
                </div>
            )}
        </aside>
    );
}

export default function ImageWorkbenchPage() {
    return <WorkbenchPage initialKind="image" />;
}

export function VideoWorkbenchPage() {
    return <WorkbenchPage initialKind="video" />;
}
