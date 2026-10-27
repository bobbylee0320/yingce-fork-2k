// 分镜规则与单集时长的纯函数：与后端 production/storyboard.go 同一套默认值与夹取规则。
import type { DramaSegmentMode, DramaStoryboardSettings, DramaTransition } from "@/services/api/drama";

export const MIN_SEGMENT_SECONDS = 4;
export const MAX_SEGMENT_SECONDS = 60;
export const MIN_EPISODE_SECONDS = 30;
export const MAX_EPISODE_SECONDS = 1200;

export const DEFAULT_STORYBOARD: DramaStoryboardSettings = { segmentMode: "auto", segmentSeconds: 10, segmentMinSeconds: 8, segmentMaxSeconds: 15, pacing: "standard", dialogue: "standard", transition: "auto", transitionMs: 400 };

export const EPISODE_PRESETS = [60, 90, 120, 180, 300, 600];

export const TRANSITION_LABEL: Record<DramaTransition, string> = { cut: "硬切", fadeblack: "黑场过渡", fadewhite: "闪白" };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function normalizeStoryboard(input?: Partial<DramaStoryboardSettings>): DramaStoryboardSettings {
    const value = { ...DEFAULT_STORYBOARD, ...input };
    const seconds = (raw: number, fallback: number) => clamp(Math.round(raw || fallback), MIN_SEGMENT_SECONDS, MAX_SEGMENT_SECONDS);
    const low = seconds(value.segmentMinSeconds, DEFAULT_STORYBOARD.segmentMinSeconds);
    const high = seconds(value.segmentMaxSeconds, DEFAULT_STORYBOARD.segmentMaxSeconds);
    return {
        segmentMode: (["fixed", "range"] as DramaSegmentMode[]).includes(value.segmentMode) ? value.segmentMode : "auto",
        segmentSeconds: seconds(value.segmentSeconds, DEFAULT_STORYBOARD.segmentSeconds),
        segmentMinSeconds: Math.min(low, high),
        segmentMaxSeconds: Math.max(low, high),
        pacing: ["fast", "slow"].includes(value.pacing) ? value.pacing : "standard",
        dialogue: ["dense", "sparse"].includes(value.dialogue) ? value.dialogue : "standard",
        transition: ["cut", "fadeblack", "fadewhite"].includes(value.transition) ? value.transition : "auto",
        transitionMs: clamp(Math.round(value.transitionMs || 400), 150, 1500),
    };
}

export function averageShotSeconds(settings: DramaStoryboardSettings) {
    const { pacing } = normalizeStoryboard(settings);
    return pacing === "fast" ? 2.5 : pacing === "slow" ? 5.5 : 3.5;
}

/** 对白密度：平均每隔多少秒至少一句台词或旁白。 */
export function lineEverySeconds(settings: DramaStoryboardSettings) {
    const { dialogue } = normalizeStoryboard(settings);
    return dialogue === "dense" ? 3 : dialogue === "sparse" ? 7 : 4.5;
}

export type SegmentLimits = { mode: DramaSegmentMode; min: number; max: number };

/** 剧情段实际约束（秒）：与后端 SegmentLimits 一致，任何模式都不超过视频模型单次上限；智能模式且模型未声明上限时 max 为 0。 */
export function segmentLimits(settings: DramaStoryboardSettings, modelMaxSeconds?: number): SegmentLimits {
    const rules = normalizeStoryboard(settings);
    const capped = (seconds: number) => (modelMaxSeconds && seconds > modelMaxSeconds ? modelMaxSeconds : seconds);
    if (rules.segmentMode === "fixed") return { mode: "fixed", min: capped(rules.segmentSeconds), max: capped(rules.segmentSeconds) };
    if (rules.segmentMode === "range") {
        const max = capped(rules.segmentMaxSeconds);
        return { mode: "range", min: Math.min(capped(rules.segmentMinSeconds), max), max };
    }
    return { mode: "auto", min: 0, max: modelMaxSeconds || 0 };
}

/** 一段的典型时长，用于估算段数：范围取中值，智能按模型上限（段数下限）。 */
export function segmentTargetSeconds(limits: SegmentLimits) {
    return limits.mode === "range" ? Math.floor((limits.min + limits.max) / 2) : limits.max;
}

export function shotTarget(settings: DramaStoryboardSettings, episodeSeconds: number) {
    return clamp(Math.round(episodeSeconds / averageShotSeconds(settings)), 4, 240);
}

export function lineTarget(settings: DramaStoryboardSettings, episodeSeconds: number) {
    return Math.max(1, Math.round(episodeSeconds / lineEverySeconds(settings)));
}

export function formatEpisodeSeconds(seconds: number) {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** 解析“90”“5分钟”“5min”“2:30”“1分30秒”等写法为秒；无法识别返回 null。 */
export function parseEpisodeSeconds(raw: string): number | null {
    const text = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (!text) return null;
    const clock = text.match(/^(\d+):(\d{1,2})$/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    const mixed = text.match(/^(\d+(?:\.\d+)?)(?:分钟?|min|m)(?:(\d+)(?:秒|s)?)?$/);
    if (mixed) return Math.round(Number(mixed[1]) * 60 + Number(mixed[2] || 0));
    const seconds = text.match(/^(\d+(?:\.\d+)?)(?:秒|s|sec)?$/);
    if (seconds) return Math.round(Number(seconds[1]));
    return null;
}

export function clampEpisodeSeconds(seconds: number) {
    return clamp(Math.round(seconds), MIN_EPISODE_SECONDS, MAX_EPISODE_SECONDS);
}
