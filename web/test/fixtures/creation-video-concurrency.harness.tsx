import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { CreationMessage, CreationConversation } from "../../src/pages/create/creation-types";
import type { CreationAttachment } from "../../src/pages/create/creation-assets";
import type { GenerationTask } from "../../src/services/api/task-center";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, SVGElement: dom.SVGElement, getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const empty = () => null;
let composer: any;
const messageProps = new Map<string, any>();
const notices: string[] = [];
const feedback = { success: (text: string) => notices.push(text), warning: (text: string) => notices.push(text), error: (text: string) => notices.push(text) };
const antd = await import("antd");
mock.module("antd", () => ({ ...antd, App: { useApp: () => ({ message: feedback, modal: {} }) }, Spin: empty }));
mock.module("react-router", () => ({ useNavigate: () => () => {} }));
mock.module("../../src/components/ui/base/tooltip", () => ({ Tooltip: ({ children }: any) => children }));
mock.module("../../src/pages/create/creation-workspace", () => ({
    CreationComposer: (props: any) => { composer = props; return null; },
    CreationMessageView: (props: any) => { messageProps.set(props.item.id, props); return null; },
    CreationEmptySuggest: empty, CreationHistoryDrawer: empty, CreationModeTabs: empty, CreationWorkspaceToolbar: empty, creationAssetCategoryLabels: {},
}));
mock.module("../../src/pages/create/creation-agent-entry", () => ({ CreationAgentEntry: empty }));
mock.module("../../src/pages/create/creation-login-dialog", () => ({ CreationLoginDialog: empty }));
mock.module("../../src/pages/create/creation-recent-canvases", () => ({ CreationRecentCanvases: empty }));
mock.module("../../src/hooks/use-external-asset-sources", () => ({ useExternalAssetSources: () => ({ items: [], folders: [] }) }));

const conversationStore = await import("../../src/services/creation-conversation-store");
let saved: CreationConversation[] = [];
mock.module("../../src/services/creation-conversation-store", () => ({
    ...conversationStore,
    loadCreationConversations: async () => null,
    saveCreationConversations: async (value: CreationConversation[]) => { saved = structuredClone(value); },
}));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const requests: Array<{ options: any; result: ReturnType<typeof deferred<any>> }> = [];
let prepareWait: ReturnType<typeof deferred<void>> | undefined;
const lifecycle = await import("../../src/services/generation-consumer-lifecycle");
mock.module("../../src/pages/create/creation-runtime", () => ({
    ...lifecycle,
    skillRuntime: { prepare: async ({ prompt }: { prompt: string }) => { await prepareWait?.promise; return { prompt, metadata: {} }; } },
    runGenerationOperationOnce: (_id: string, operation: () => unknown) => operation(),
    runBackendGenerationTask: (options: any) => {
        const result = deferred<any>();
        requests.push({ options, result });
        return result.promise;
    },
    isGenerationTaskCancelled: (error: Error) => error.name === "AbortError",
    projectGenerationTaskResult: (task: GenerationTask, result: any) => ({ ...task, result }),
    consumeGenerationTaskMessage: async (task: any, _id: string, consume: any) => {
        const result = { resultUrls: [task.result.video.dataUrl], resultStorageKeys: [task.result.video.storageKey] };
        await consume({ ...result, effectKey: task.id });
        return result;
    },
    generationTaskMaterializedUrls: (result: any) => result.resultUrls,
    applyGenerationConsumerEffect: (item: CreationMessage, _key: string, update: any) => ({ value: update(item) }),
    subscribeGenerationTasks: () => () => {},
}));

const { useUserStore } = await import("../../src/stores/use-user-store");
const { defaultConfig, useConfigStore } = await import("../../src/stores/use-config-store");
const { useCreationPreferencesStore } = await import("../../src/stores/use-creation-preferences-store");
const { defaultModelCapabilityConfig } = await import("../../src/lib/model-capabilities");
const { buildCreationMentionReferences, expandCreationPrompt } = await import("../../src/pages/create/creation-references");
const profile = defaultModelCapabilityConfig();
profile.video!.references = { ...profile.video!.references, maxImages: 3, maxVideos: 1, maxAudios: 1 };
useUserStore.setState({ hydrated: true, user: { id: "test", username: "test", displayName: "test", role: "user", status: "active" } });
useConfigStore.setState({ config: { ...defaultConfig, videoModel: "test::video", channels: [{ id: "test", name: "test", scope: "system", baseUrl: "/api", apiKey: "", apiFormat: "openai", models: ["video"], modelCosts: [{ model: "video", capability: "video", capabilityConfig: profile }] }] } });
useCreationPreferencesStore.setState({ hydrated: true, preferences: { mode: "video", video: { ratio: "16:9", seconds: "6", videoQuality: "720" } } });
const { default: CreatePage } = await import("../../src/pages/create/index");
const root = createRoot(document.body.appendChild(document.createElement("div")));
afterAll(async () => { await act(async () => root.unmount()); dom.happyDOM.abort(); });
const flush = async (action: () => unknown = () => {}) => act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const messages = () => saved[0].messages;
const task = (id: string): GenerationTask => ({ id, type: "canvas_video", status: "running", prompt: id, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test("创建返回前可提交下一镜，重复触发不重复提交，乱序结束只更新对应消息", async () => {
    await flush(() => root.render(<CreatePage />));
    expect(composer.mode).toBe("video");
    const attachments: CreationAttachment[] = [{ id: "image-a", name: "角色.png", type: "image/png", dataUrl: "", previewUrl: "", storageKey: "resource:image-a" }, { id: "audio-a", name: "对白.mp3", type: "audio/mpeg", url: "", previewUrl: "", storageKey: "resource:audio-a" }];
    await flush(() => { composer.onReorderAttachments(attachments); composer.setPrompt("第一镜 @[attachment:image-a] @[attachment:audio-a]"); });
    await flush(() => { composer.onSubmit(); composer.onSubmit(); });
    expect(requests).toHaveLength(1);
    expect(composer.busy).toBe(false);
    expect(composer.generationActive).toBe(true);
    expect(composer.prompt).toBe("");
    expect(messages()).toHaveLength(2);
    const firstUser = messages()[0];
    expect(firstUser.attachments).toEqual(attachments);
    expect(firstUser.references).toHaveLength(2);

    await flush(() => { composer.setPrompt("第二镜"); });
    await flush(() => composer.onSubmit());
    expect(requests).toHaveLength(2);
    expect(messages()).toHaveLength(4);
    expect(requests[0].options.referenceImages[0].id).toBe("image-a");
    expect(requests[1].options.referenceImages).toEqual([]);
    expect(requests[0].options.metadata.messageId).not.toBe(requests[1].options.metadata.messageId);

    await flush(() => { requests[1].options.onTaskUpdate(task("second")); requests[0].options.onTaskUpdate(task("first")); });
    await flush(() => requests[1].result.resolve({ video: { dataUrl: "https://example.com/second.mp4", storageKey: "resource:second" } }));
    expect(messages()[3].status).toBe("done");
    expect(messages()[1].status).toBe("pending");
    expect(messages()[1].taskIds).toEqual(["first"]);
    expect(messages()[3].resultStorageKeys).toEqual(["resource:second"]);

    prepareWait = deferred<void>();
    await flush(() => composer.setPrompt("第三镜"));
    await flush(() => composer.onSubmit());
    expect(composer.busy).toBe(true);
    await flush(() => requests[0].result.reject(new Error("第一镜失败")));
    expect(messages()[1].status).toBe("error");
    expect(messages()[3].status).toBe("done");
    expect(composer.busy).toBe(true);
    await flush(() => prepareWait!.resolve());
    prepareWait = undefined;
    expect(requests).toHaveLength(3);
    expect(composer.busy).toBe(false);

    await flush(() => messageProps.get(firstUser.id).onEditUserMessage(firstUser));
    expect(composer.prompt).toBe(firstUser.content);
    expect(composer.attachments).toEqual(attachments);
    expect(composer.model).toBe(firstUser.model);
    expect(composer.seconds).toBe(firstUser.settings!.seconds);
    expect(composer.references.filter((item: any) => item.attachmentId).map((item: any) => item.mentionToken)).toEqual(["@[attachment:image-a]", "@[attachment:audio-a]"]);
    expect(expandCreationPrompt(composer.prompt, composer.references, composer.attachments)).toContain("@图片1：参考图片 1");
    expect(buildCreationMentionReferences([], attachments)).toHaveLength(2);
    // 复用仅回填，确认发送前不创建收费任务。
    expect(requests).toHaveLength(3);
    await flush(() => composer.onSubmit());
    expect(requests).toHaveLength(4);
    expect(requests[3].options.prompt).toBe(requests[0].options.prompt);
    expect(requests[3].options.referenceImages).toEqual(requests[0].options.referenceImages);
    expect(requests[3].options.referenceAudios).toEqual(requests[0].options.referenceAudios);
    await flush(() => { requests[2].result.reject(new Error("结束模拟任务")); requests[3].result.reject(new Error("结束模拟任务")); });
});

test("准备失败后可继续提交，旧请求的创建通知不解锁新准备", async () => {
    const count = requests.length;
    const before = messages().length;
    prepareWait = deferred<void>();
    await flush(() => composer.setPrompt("准备失败保留草稿"));
    await flush(() => composer.onSubmit());
    expect(composer.busy).toBe(true);
    await flush(() => requests[0].options.onTaskUpdate(task("first")));
    expect(composer.busy).toBe(true);
    await flush(() => prepareWait!.reject(new Error("技能准备失败")));
    prepareWait = undefined;
    expect(composer.busy).toBe(false);
    expect(composer.prompt).toBe("准备失败保留草稿");
    expect(requests).toHaveLength(count);
    expect(messages()).toHaveLength(before);
    await flush(() => composer.onSubmit());
    expect(requests).toHaveLength(count + 1);
    await flush(() => requests[count].result.reject(new Error("结束模拟任务")));
});
