import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { getResourceAccess, resolveResourceAccessURL, resourceFileUrl, type ResourceAccessVariant } from "@/services/api/resources";
import type { DramaCastKind, DramaEpisodeRow, DramaEpisodeStage, DramaMediaMode, DramaMediaStatus, DramaStatus } from "@/services/api/drama";

export const PIPELINE_STEPS: Array<{ key: Exclude<DramaEpisodeStage, "queued" | "review" | "done">; label: string }> = [
    { key: "script", label: "剧本" },
    { key: "prompts", label: "段提示词" },
    { key: "video", label: "视频" },
    { key: "render", label: "成片" },
];

const STAGE_INDEX: Record<DramaEpisodeStage, number> = { queued: -1, script: 0, prompts: 1, review: 2, video: 2, render: 3, done: 4 };

export const STAGE_LABEL: Record<DramaEpisodeStage, string> = {
    queued: "排队中",
    script: "改编剧本",
    prompts: "撰写段提示词",
    review: "等待审阅",
    video: "生成视频",
    render: "合成成片",
    done: "已完成",
};

export const STATUS_LABEL: Record<DramaStatus, string> = {
    draft: "未开始",
    running: "制作中",
    paused: "已暂停",
    completed: "已完成",
};

export const CAST_KIND_LABEL: Record<DramaCastKind, string> = { character: "角色", prop: "道具", scene: "场景" };

/** 生成节奏的文案：新建页与设置页共用。 */
export const MEDIA_MODE_LABEL: Record<DramaMediaMode, { title: string; detail: string }> = {
    manual: { title: "先出剧本与提示词，手动生成", detail: "只跑文本：作品圣经、分集、剧本、分镜、设定与各段视频提示词。确认后再逐集或全部生成参考图与视频" },
    auto: { title: "全自动出片", detail: "剧本写好后直接生成参考图和带原声的段视频，一路跑到成片" },
};

export type EpisodeTone = "done" | "active" | "review" | "error" | "idle" | "ready";

export function episodeTone(episode: DramaEpisodeRow): EpisodeTone {
    if (episode.error || episode.stats.failed > 0) return "error";
    if (episode.awaitingMedia) return "ready";
    if (episode.stage === "review") return "review";
    if (episode.stage === "done" && !episode.finalStale) return "done";
    if (episode.stage === "queued") return "idle";
    return "active";
}

export function episodeStatusText(episode: DramaEpisodeRow) {
    if (episode.error) return "需要处理";
    if (episode.awaitingMedia) return `剧本就绪 · ${episode.shotCount} 镜 · 待生成画面`;
    if (episode.stage === "done" && episode.finalStale) return "已修改 · 待重新合成";
    const { stats } = episode;
    switch (episode.stage) {
        case "prompts":
            return stats.segments ? `提示词 ${stats.promptReady}/${stats.segments}` : STAGE_LABEL.prompts;
        case "video":
            return stats.segments ? `视频 ${stats.videoReady}/${stats.segments}` : STAGE_LABEL.video;
        case "done":
            return `已完成 · ${formatDuration(episode.durationMs)}`;
    }
    return STAGE_LABEL[episode.stage];
}

/** 每个流水线步骤的完成度：0 未开始、0-1 进行中、1 完成。 */
export function stepProgress(episode: DramaEpisodeRow, step: (typeof PIPELINE_STEPS)[number]["key"]) {
    const current = STAGE_INDEX[episode.stage];
    const index = PIPELINE_STEPS.findIndex((item) => item.key === step);
    if (episode.stage === "done" && !episode.finalStale) return 1;
    if (current > index) return 1;
    if (current < index) return 0;
    const total = Math.max(episode.stats.segments, 1);
    if (step === "prompts") return Math.max(0.08, episode.stats.promptReady / total);
    if (step === "video") return Math.max(0.08, episode.stats.videoReady / total);
    return 0.35;
}

export function StagePips({ episode, size = "sm" }: { episode: DramaEpisodeRow; size?: "sm" | "md" }) {
    const tone = episodeTone(episode);
    return (
        <span className={`drama-pips is-${size} is-${tone}`} aria-hidden>
            {PIPELINE_STEPS.map((step) => {
                const progress = stepProgress(episode, step.key);
                return (
                    <span key={step.key} className="drama-pip" title={step.label}>
                        <span className="drama-pip-fill" style={{ "--pip": progress } as CSSProperties} />
                    </span>
                );
            })}
        </span>
    );
}

export function formatDuration(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}分${String(seconds % 60).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function formatClock(ms: number) {
    const seconds = Math.max(0, ms / 1000);
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export function formatCredits(microcredits: number) {
    const credits = microcredits / 1_000_000;
    if (credits >= 10_000) return `${(credits / 10_000).toFixed(credits >= 100_000 ? 0 : 1)}万`;
    return credits.toLocaleString("zh-CN", { maximumFractionDigits: credits >= 100 ? 0 : 2 });
}

export function formatCount(value: number) {
    if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
    return value.toLocaleString("zh-CN");
}

export function aspectRatioValue(aspect: string) {
    const [width, height] = aspect.split(":").map(Number);
    return width && height ? `${width} / ${height}` : "9 / 16";
}

export function resourceUrl(id?: string) {
    return id ? resourceFileUrl(id) : "";
}

/** 加载失败后的自动重试间隔：访问地址过期、缩略图尚未生成或解码排队超时多是暂时的。 */
const THUMB_RETRY_DELAYS_MS = [1500, 5000];

/**
 * 资源缩略图。加载失败会自动重试两次，之后显示 failed（缺省为 fallback）；
 * loading 是加载中的占位（缺省为 fallback）。
 */
export function MediaThumb({ resourceId, alt, className, fallback, loading, failed }: { resourceId?: string; alt: string; className?: string; fallback?: ReactNode; loading?: ReactNode; failed?: ReactNode }) {
    const [retry, setRetry] = useState({ resourceId, attempt: 0 });
    const attempt = retry.resourceId === resourceId ? retry.attempt : 0;
    if (!resourceId) return <>{fallback ?? null}</>;
    const pending = loading ?? fallback ?? null;
    const delay = THUMB_RETRY_DELAYS_MS[attempt];
    const failure =
        delay === undefined ? (
            (failed ?? fallback ?? null)
        ) : (
            <ThumbRetry delayMs={delay} onRetry={() => setRetry({ resourceId, attempt: attempt + 1 })}>
                {pending}
            </ThumbRetry>
        );
    return <CachedResourceImage key={`${resourceId}:${attempt}`} storageKey={`resource:${resourceId}`} alt={alt} className={className} variant="thumbnail" fallback={failure} loadingFallback={pending} draggable={false} />;
}

function ThumbRetry({ delayMs, onRetry, children }: { delayMs: number; onRetry: () => void; children: ReactNode }) {
    const [handler] = useState(() => onRetry);
    useEffect(() => {
        const timer = window.setTimeout(handler, delayMs);
        return () => window.clearTimeout(timer);
    }, [delayMs, handler]);
    return <>{children}</>;
}

export function mediaBusy(status: DramaMediaStatus) {
    return status === "queued" || status === "running";
}

export function parseList(raw: string | undefined): string[] {
    try {
        const value: unknown = JSON.parse(raw || "[]");
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

/** 把 SRT 转成浏览器 <track> 需要的 WebVTT。 */
export function srtToVtt(srt: string) {
    return `WEBVTT\n\n${srt.replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

/** 解析资源的授权播放地址；视频优先使用浏览器兼容的播放副本。 */
export function useResourceMediaUrl(resourceId: string | undefined, variant: ResourceAccessVariant = "original") {
    const [url, setUrl] = useState("");
    useEffect(() => {
        setUrl("");
        if (!resourceId) return;
        let active = true;
        void getResourceAccess(`resource:${resourceId}`, "display", variant)
            .catch(() => getResourceAccess(`resource:${resourceId}`, "display", "original"))
            .then((access) => {
                if (active) setUrl(resolveResourceAccessURL(access.url));
            })
            .catch(() => {
                if (active) setUrl(resourceUrl(resourceId));
            });
        return () => {
            active = false;
        };
    }, [resourceId, variant]);
    return url;
}

export async function downloadResource(resourceId: string, fileName: string) {
    const access = await getResourceAccess(`resource:${resourceId}`, "download", "original", fileName);
    const anchor = document.createElement("a");
    anchor.href = resolveResourceAccessURL(access.url);
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

export function downloadText(content: string, fileName: string, mime = "text/plain") {
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
