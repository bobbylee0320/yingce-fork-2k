import { useGlobalAgentStore } from "@/stores/use-global-agent-store";

/** 画布内的 Agent 开合直接读写平台级状态：从其他页面打开后进入画布，面板保持展开。 */
export function useCanvasAssistantVisibility() {
    const assistantOpen = useGlobalAgentStore((state) => state.open);
    const openAgent = useGlobalAgentStore((state) => state.openAgent);
    const closeAgent = useGlobalAgentStore((state) => state.closeAgent);

    return {
        assistantClosing: false,
        assistantMounted: true,
        assistantOpen,
        closeAgent,
        openAgent,
    };
}
