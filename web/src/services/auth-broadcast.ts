// 跨标签页的登出通知：只传递“已退出”信号，不携带任何账号数据。
const CHANNEL_NAME = "yingce-auth";
const LOGOUT_MESSAGE = "logout";

let channel: BroadcastChannel | null | undefined;

function authChannel() {
    if (channel !== undefined) return channel;
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
    return channel;
}

export function announceAuthLogout() {
    try {
        authChannel()?.postMessage(LOGOUT_MESSAGE);
    } catch {
        // 不支持或通道已关闭时只影响其他标签页的即时同步；它们会在下一次 401 时自行确认会话。
    }
}

export function onAuthLogout(listener: () => void) {
    const current = authChannel();
    if (!current) return () => undefined;
    const handle = (event: MessageEvent) => {
        if (event.data === LOGOUT_MESSAGE) listener();
    };
    current.addEventListener("message", handle);
    return () => current.removeEventListener("message", handle);
}
