import { registerPlugin } from "../plugin-registry";
import { PLUGIN_API_VERSION, type RegisteredPlugin } from "../plugin-types";
import { usePluginStore } from "@/stores/use-plugin-store";

export const USER_FEEDBACK_PLUGIN_ID = "user-feedback";

export const userFeedbackPlugin: RegisteredPlugin = {
    manifest: {
        id: USER_FEEDBACK_PLUGIN_ID,
        name: "意见与问题反馈",
        version: "1.0.0",
        publishedAt: "2026-10-20",
        updatedAt: "2026-10-20",
        apiVersion: PLUGIN_API_VERSION,
        description: "在工作台首页右下角提供便捷的反馈按钮，支持提交 Bug 反馈、功能提议并附带图片/视频附件，支持用户与管理员收件箱式跟进查看。",
        author: "影策社区",
        surfaces: ["hybrid"],
        permissions: ["canvas.read"],
        trusted: true,
        contributes: { usageObservers: ["user-feedback"] },
    },
};

registerPlugin(userFeedbackPlugin);

export function useUserFeedbackEnabled(): boolean {
    return usePluginStore((state) => {
        const pluginState = state.pluginStates[USER_FEEDBACK_PLUGIN_ID];
        if (pluginState && typeof pluginState.effectiveEnabled === "boolean") {
            return pluginState.effectiveEnabled;
        }
        const installation = state.installations.find((item) => item.manifest.id === USER_FEEDBACK_PLUGIN_ID);
        if (installation && typeof installation.enabled === "boolean") {
            return installation.enabled;
        }
        return true;
    });
}
