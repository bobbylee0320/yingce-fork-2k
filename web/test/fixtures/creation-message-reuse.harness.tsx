import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { CreationMessage } from "../../src/pages/create/creation-types";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    ShadowRoot: dom.ShadowRoot,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CreationUserMessage } = await import("../../src/pages/create/creation-workspace-messages");
const { buildCreationMentionReferences } = await import("../../src/pages/create/creation-references");
const root = createRoot(document.body.appendChild(document.createElement("div")));
afterAll(async () => {
    await act(async () => root.unmount());
    dom.happyDOM.abort();
});

test("历史消息的真实复用按钮回传原始 token、附件和参数，而不是可见标签", async () => {
    const attachments = [{ id: "voice", name: "对白.mp3", type: "audio/mpeg", url: "", previewUrl: "", storageKey: "resource:voice" }];
    const item: CreationMessage = {
        id: "user-video",
        role: "user",
        mode: "video",
        content: "跟随 @[attachment:voice] 的节奏",
        createdAt: "2026-10-18T00:00:00Z",
        attachments,
        references: buildCreationMentionReferences([], attachments),
        model: "test::video",
        settings: { ratio: "16:9", seconds: "6", quality: "auto", videoQuality: "720", count: "1" },
    };
    let reused: CreationMessage | undefined;
    await act(async () =>
        root.render(
            <CreationUserMessage
                item={item}
                shotNumber={1}
                onEditUserMessage={(message) => {
                    reused = message;
                }}
            />,
        ),
    );
    expect(document.body.textContent).toContain("跟随 @对白.mp3 的节奏");
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="复用提示词和引用"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(reused).toBe(item);
    expect(reused!.content).toContain("@[attachment:voice]");
    expect(reused!.attachments![0].storageKey).toBe("resource:voice");
    expect(reused!.settings!.seconds).toBe("6");
});
