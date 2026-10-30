const RECOVERY_QUERY = "__chunk_recovery";
const RECOVERY_KEY = "canvas:chunk-recovery";
let recovering = false;

export function installChunkRecovery() {
    window.addEventListener("vite:preloadError", handlePreloadError);
    stripRecoveryMarker();
}

/**
 * 恢复刷新后去掉地址栏里的时间戳标记，避免被复制分享。只有会话存储里已记下恢复标记时才去掉；
 * 存储不可用时 URL 标记是唯一的防循环依据，必须保留。
 */
function stripRecoveryMarker() {
    try {
        const href = window.location?.href;
        if (!href) return;
        const url = new URL(href);
        if (!url.searchParams.has(RECOVERY_QUERY)) return;
        if (sessionStorage.getItem(RECOVERY_KEY) !== "1") return;
        url.searchParams.delete(RECOVERY_QUERY);
        window.history.replaceState(window.history.state, "", url.toString());
    } catch {
        // 读不到会话存储或历史接口时保留标记，继续用它防止循环刷新。
    }
}

export function markChunkRecoverySucceeded() {
    // An entry module loading says nothing about lazy routes. Keep the guard for
    // the tab's lifetime; the URL also protects browsers with disabled storage.
}

/** Explicit user retry is allowed even after the automatic recovery was used. */
export function reloadAfterChunkFailure() {
    navigateToFreshEntry();
}

export function tryRecoverChunkFailure() {
    if (recovering) return true;
    const url = new URL(window.location.href);
    if (url.searchParams.has(RECOVERY_QUERY)) return false;
    try {
        if (sessionStorage.getItem(RECOVERY_KEY) === "1") return false;
        sessionStorage.setItem(RECOVERY_KEY, "1");
    } catch {
        // The query marker survives the reload when session storage is denied.
    }
    recovering = true;
    navigateToFreshEntry();
    return true;
}

function navigateToFreshEntry() {
    const url = new URL(window.location.href);
    url.searchParams.set(RECOVERY_QUERY, String(Date.now()));
    window.location.replace(url.toString());
}

function handlePreloadError(event: Event) {
    // On the second failure let Vite throw to the route error boundary.
    if (tryRecoverChunkFailure()) event.preventDefault();
}
