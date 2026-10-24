/**
 * 快速创作结果的展示地址。
 *
 * 历史消息里的 resultUrls 只是短期 hint（平台代理地址或旧签名地址），真正的身份是 storageKey。
 * 展示地址按 storageKey 保存：续签、素材库更新导致的重新解析不会先退回 hint 再换新地址，
 * 结果块也以 storageKey 作为 React key，签名地址变化时不会被整个卸载重建。
 */

export type CreationResultEntry = { key: string; url: string };

/** 签名已过期的 hint 不再交给 <img>/<video>，否则首帧就是 403 空白。 */
export function usableResultUrl(url: string | undefined, now = Date.now()) {
    if (!url) return "";
    const expires = /[?&]expires=(\d+)/.exec(url);
    return !expires || Number(expires[1]) * 1000 > now ? url : "";
}

export function creationResultEntries({
    storageKeys,
    storedUrls,
    resolvedByKey,
    failedByKey,
    isVideo,
    isRemoteKey,
    now = Date.now(),
}: {
    storageKeys: string[];
    storedUrls: string[];
    resolvedByKey: Record<string, string>;
    failedByKey: Record<string, boolean>;
    isVideo: boolean;
    isRemoteKey: (storageKey: string) => boolean;
    now?: number;
}): { entries: CreationResultEntry[]; resolving: boolean } {
    if (!storageKeys.length) {
        const entries = storedUrls.map((url, index) => ({ key: url || String(index), url: usableResultUrl(url, now) })).filter((entry) => entry.url);
        return { entries, resolving: false };
    }
    let resolving = false;
    const entries = storageKeys.map((storageKey, index) => {
        const resolved = resolvedByKey[storageKey];
        if (resolved) return { key: storageKey, url: resolved };
        const remote = isRemoteKey(storageKey);
        if (remote && !failedByKey[storageKey]) resolving = true;
        // 远端视频不先挂 hint：换成签名地址时 <video> 会中断重载、闪黑并重复下载。
        // 图片同一个 <img> 换 src 时浏览器保留旧图，hint 可以先顶上。
        const hint = usableResultUrl(storedUrls[index], now);
        return { key: storageKey, url: remote && isVideo && !failedByKey[storageKey] ? "" : hint };
    });
    return { entries: entries.filter((entry) => entry.url), resolving };
}
