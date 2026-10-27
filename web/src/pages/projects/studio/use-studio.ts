import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getDrama, getDramaEpisode, listDramaCast, type DramaCast, type DramaEpisodeDetail, type DramaSummary } from "@/services/api/drama";

export const dramaKeys = {
    summary: (projectId: string) => ["drama", projectId] as const,
    episode: (projectId: string, episodeId: string) => ["drama", projectId, "episode", episodeId] as const,
    cast: (projectId: string) => ["drama", projectId, "cast"] as const,
    jobs: (projectId: string) => ["drama", projectId, "jobs"] as const,
};

function summaryActive(summary?: DramaSummary) {
    if (!summary) return false;
    return summary.production.status === "running" || (summary.jobCounts.running || 0) > 0;
}

export function useDramaSummary(projectId: string) {
    return useQuery({
        queryKey: dramaKeys.summary(projectId),
        queryFn: ({ signal }) => getDrama(projectId, signal),
        enabled: Boolean(projectId),
        refetchInterval: (query) => (summaryActive(query.state.data) ? 3_000 : 20_000),
        refetchOnWindowFocus: true,
    });
}

export function useDramaEpisode(projectId: string, episodeId: string, active: boolean) {
    return useQuery({
        queryKey: dramaKeys.episode(projectId, episodeId),
        queryFn: ({ signal }) => getDramaEpisode(projectId, episodeId, signal),
        enabled: Boolean(projectId && episodeId),
        placeholderData: (previous) => (previous?.episode.id === episodeId ? previous : undefined),
        refetchInterval: (query) => {
            const detail = query.state.data;
            if (!active || !detail) return false;
            const writing = detail.segments?.some((segment) => segment.promptStatus === "queued" || segment.promptStatus === "running");
            return detail.jobs.length || writing || detail.episode.stage !== "done" ? 2_500 : false;
        },
    });
}

export function useDramaCast(projectId: string, active: boolean) {
    const query = useQuery({
        queryKey: dramaKeys.cast(projectId),
        queryFn: ({ signal }) => listDramaCast(projectId, signal),
        enabled: Boolean(projectId),
        refetchInterval: (state) => (active && state.state.data?.cast.some((cast) => cast.imageStatus !== "ready" && cast.imageStatus !== "failed" && !cast.locked) ? 4_000 : false),
    });
    const byId = useMemo(() => new Map((query.data?.cast || []).map((cast) => [cast.id, cast] as const)), [query.data]);
    return { ...query, cast: query.data?.cast || [], byId };
}

export function useDramaInvalidate(projectId: string) {
    const queryClient = useQueryClient();
    return (episodeId?: string) => {
        void queryClient.invalidateQueries({ queryKey: dramaKeys.summary(projectId), exact: true });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.cast(projectId) });
        void queryClient.invalidateQueries({ queryKey: dramaKeys.jobs(projectId) });
        if (episodeId) void queryClient.invalidateQueries({ queryKey: dramaKeys.episode(projectId, episodeId) });
    };
}

export type StudioContext = {
    projectId: string;
    summary: DramaSummary;
    detail?: DramaEpisodeDetail;
    castById: Map<string, DramaCast>;
};

export function isTypingTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || Boolean(element.closest(".ant-select, .ant-modal, .ant-drawer, .ant-popover, .ant-dropdown, [role='dialog'], [role='listbox'], [aria-haspopup]"));
}
