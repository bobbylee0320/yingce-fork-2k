import type { ReactNode } from "react";
import { App } from "antd";
import type { AppProps } from "antd";

import { installMessageDedupe } from "@/lib/message-dedupe";

/** Toast 全站统一：message 顶部居中 3 秒、最多 3 条；notification 右上 4.5 秒、最多 3 条。 */
export const APP_MESSAGE_CONFIG: AppProps["message"] = { duration: 3, maxCount: 3, top: 16 };
export const APP_NOTIFICATION_CONFIG: AppProps["notification"] = { duration: 4.5, maxCount: 3, placement: "topRight" };

/** 同一 App 实例下的 message 在子组件首次调用前完成去重包装（渲染期执行、幂等）。 */
function MessageDedupe({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    installMessageDedupe(message);
    return children;
}

/** antd App 的唯一入口：用户端与后台共用同一套 Toast 位置、时长与去重规则。 */
export function AppFeedbackProvider({ children }: { children: ReactNode }) {
    return (
        <App message={APP_MESSAGE_CONFIG} notification={APP_NOTIFICATION_CONFIG}>
            <MessageDedupe>{children}</MessageDedupe>
        </App>
    );
}
