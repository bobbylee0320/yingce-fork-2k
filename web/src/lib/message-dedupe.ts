import type { MessageInstance } from "antd/es/message/interface";

const MESSAGE_TYPES = ["info", "success", "error", "warning", "loading"] as const;
const patched = new WeakSet<object>();

/**
 * 同一条提示不重复堆叠：调用方没有指定 key 时，用「类型 + 文本」作为 key，
 * 相同文本的新提示会替换旧提示并重新计时，而不是再弹一条。
 * 只处理纯文本内容；传入对象（带 key、onClose 等）或 React 节点时保持调用方原意。
 */
export function installMessageDedupe(api: MessageInstance) {
    if (patched.has(api)) return;
    patched.add(api);
    for (const type of MESSAGE_TYPES) {
        const original = api[type].bind(api);
        api[type] = ((content, duration, onClose) => {
            if (typeof content !== "string" && typeof content !== "number") return original(content, duration, onClose);
            const args = { content, key: `${type}:${content}`, ...(typeof duration === "number" ? { duration } : {}), onClose: typeof duration === "function" ? duration : onClose };
            return original(args);
        }) as MessageInstance[typeof type];
    }
}
