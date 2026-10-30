import { fetchAuthSessionFresh } from "@/services/api/auth";
import { onUnauthorizedResponse } from "@/services/api/request";
import { onAuthLogout } from "@/services/auth-broadcast";
import { useUserStore } from "@/stores/use-user-store";

let installed = false;
let confirming: Promise<void> | null = null;

/**
 * 会话失效后退出工作区。业务接口返回 401 时先重新读取一次会话，只有服务端确认没有登录用户才退出；
 * “当前密码不正确”等同样返回 401，但会话仍有效，不能据此登出。其他标签页退出登录时同样走确认流程。
 */
export function installSessionExpiryWatcher() {
    if (installed) return;
    installed = true;
    onUnauthorizedResponse((url) => {
        if (!isAuthEndpoint(url)) void confirmSessionExpired();
    });
    onAuthLogout(() => void confirmSessionExpired());
}

function isAuthEndpoint(url?: string) {
    return Boolean(url && /\/auth\/(session|login|register|logout)(?:[?#]|$)/.test(url));
}

function confirmSessionExpired() {
    if (!useUserStore.getState().user) return Promise.resolve();
    confirming ??= (async () => {
        try {
            const session = await fetchAuthSessionFresh();
            if (session.user || !useUserStore.getState().user) return;
            const { applyUserSession } = await import("@/lib/user-session");
            await applyUserSession({ ...session, user: null });
        } catch {
            // 网络或服务暂时不可用时无法确认会话状态，保持当前工作区，等下一次请求再判断。
        } finally {
            confirming = null;
        }
    })();
    return confirming;
}
