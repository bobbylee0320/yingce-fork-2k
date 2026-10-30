/**
 * 登录、注册、找回密码后的站内跳转地址。只接受同源的绝对路径：
 * 拒绝 `//host` 与含反斜杠的 `/\host`（浏览器会把反斜杠当成斜杠解析成外部地址）以及控制字符，
 * 规则与后端 safeOAuthNext 保持一致。
 */
export function safeNext(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
    try {
        const origin = window.location.origin;
        const url = new URL(value, origin);
        if (url.origin !== origin) return "/";
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return "/";
    }
}
