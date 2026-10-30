import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { getAuthSession, type AuthSessionPayload } from "@/services/api/auth";
import { ApiError } from "@/services/api/request";
import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { useUserStore } from "@/stores/use-user-store";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { installSessionExpiryWatcher } from "@/services/session-expiry";

const SESSION_RETRY_BASE_MS = 2_000;
const SESSION_RETRY_MAX_MS = 30_000;

export function AuthSessionHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const [retryAttempt, setRetryAttempt] = useState(0);

    useEffect(() => {
        installSessionExpiryWatcher();
        let cancelled = false;
        let retryTimer: number | undefined;
        let attempt = 0;
        const startedAt = performance.now();
        recordDiagnosticEvent({ category: "navigation", level: "info", code: "startup.auth_session_started", message: "开始恢复认证会话" });
        const restore = () => {
            getAuthSession()
                .then(async (payload) => {
                    if (cancelled) return;
                    recordDiagnosticEvent({
                        category: "navigation",
                        level: "info",
                        code: "startup.auth_session_ready",
                        message: payload.user ? "认证会话已恢复" : "匿名会话已确认",
                        durationMs: performance.now() - startedAt,
                    });
                    if (!payload.user) {
                        await applyAnonymousSession(payload);
                        recordDiagnosticEvent({
                            category: "navigation",
                            level: "info",
                            code: "startup.anonymous_ready",
                            message: "匿名页面已解除启动阻塞",
                            durationMs: performance.now() - startedAt,
                        });
                        return;
                    }
                    // 账号数据、画布和素材持久化只属于已登录工作区，登录页不下载这些模块。
                    const { applyUserSession } = await import("@/lib/user-session");
                    if (cancelled) return;
                    await applyUserSession(payload);
                    recordDiagnosticEvent({
                        category: "navigation",
                        level: "info",
                        code: "startup.workspace_ready",
                        message: "登录工作区已解除启动阻塞",
                        durationMs: performance.now() - startedAt,
                    });
                    preloadWorkspaceRoute(window.location.pathname);
                })
                .catch(async (error: unknown) => {
                    if (cancelled) return;
                    if (!isRetryableSessionError(error)) {
                        await applyAnonymousSession({ user: null });
                        recordDiagnosticEvent({
                            category: "navigation",
                            level: "warning",
                            code: "startup.auth_session_failed",
                            message: "认证会话恢复失败，已降级为匿名页面",
                            durationMs: performance.now() - startedAt,
                        });
                        return;
                    }
                    // 部署重启、网关超时或数据库暂时不可用：保持登录态并自动重试，
                    // 不能把已登录用户当成匿名送到登录页。
                    attempt += 1;
                    setRetryAttempt(attempt);
                    recordDiagnosticEvent({
                        category: "navigation",
                        level: "warning",
                        code: "startup.auth_session_retry",
                        message: `认证会话暂时无法读取，第 ${attempt} 次自动重试`,
                        durationMs: performance.now() - startedAt,
                    });
                    retryTimer = window.setTimeout(restore, Math.min(SESSION_RETRY_MAX_MS, SESSION_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 4)));
                });
        };
        restore();
        return () => {
            cancelled = true;
            if (retryTimer) window.clearTimeout(retryTimer);
        };
    }, []);

    if (hydrated) return children;
    if (retryAttempt > 0) return <FullScreenLoader label="暂时连不上服务" detail={`正在自动重试（第 ${retryAttempt} 次），恢复后会直接进入`} />;
    return <FullScreenLoader />;
}

/**
 * 会话接口没有 HTTP 响应（断网、超时）、5xx、408、429 视为暂时性故障并重试；
 * 其余 4xx 与非接口错误按原逻辑降级为匿名，避免未知错误让启动页一直重试。
 */
function isRetryableSessionError(error: unknown) {
    if (!(error instanceof ApiError)) return false;
    return error.status === undefined || error.retryable;
}

async function applyAnonymousSession(payload: AuthSessionPayload) {
    const { applyUserSession } = await import("@/lib/user-session");
    await applyUserSession({ ...payload, user: null });
}
