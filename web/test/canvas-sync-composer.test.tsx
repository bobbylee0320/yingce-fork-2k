import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChatComposer } from "../src/components/canvas/canvas-cloud-agent-composer";
import { canvasThemes } from "../src/lib/canvas-theme";
import { CanvasSyncStatus } from "../src/pages/canvas/canvas-sync-status";
import { useSyncProgressStore } from "../src/stores/use-sync-progress-store";

test("unconfirmed sync prevents sending without disabling the real Agent input", () => {
    const markup = renderToStaticMarkup(<AgentChatComposer prompt="Keep this draft" submitDisabled placeholder="Compose" theme={canvasThemes.dark} onPromptChange={() => {}} onSubmit={() => {}} />);
    const sendButton = markup.match(/<button[^>]*aria-label="发送"[^>]*>/)?.[0];
    expect(sendButton).toBeDefined();
    expect(sendButton).toContain("disabled");
    expect(markup).toContain('aria-label="Agent 输入"');
    expect(markup).not.toContain('contenteditable="false"');
});

test("real sync status has no recovery card, buttons or alternate-canvas actions", () => {
    useSyncProgressStore.getState().setProjectProgress("status-test", { phase: "pending", errorKind: "network", message: "画布同步失败：连接中断" });
    try {
        const markup = renderToStaticMarkup(<CanvasSyncStatus projectId="status-test" />);
        expect(markup).toContain('role="status"');
        expect(markup).not.toContain("<button");
        expect(markup).not.toContain("采用云端");
        expect(markup).not.toContain("另存");
        expect(markup).not.toContain("导出");
    } finally {
        useSyncProgressStore.getState().setProjectProgress("status-test", null);
    }
});
