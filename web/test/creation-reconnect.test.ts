import { expect, test } from "bun:test";
import { reconcileCreationTaskMessages } from "../src/pages/create/creation-conversations";
import type { CreationConversation } from "../src/pages/create/creation-types";
import type * as Runtime from "../src/pages/create/creation-runtime";
import type { GenerationTask } from "../src/services/api/task-center";
import { createGenerationTask, resolveGenerationTaskSubmissions, TaskSubmissionUncertainError } from "../src/services/api/task-center";
import { apiClient, ApiError } from "../src/services/api/request";

const runtime = {} as typeof Runtime;
const conversation: CreationConversation = { id: "chat", title: "fixture", updatedAt: "2026-10-18", messages: [{ id: "message", role: "assistant", mode: "video", content: "生成失败", status: "error", error: "后端服务暂时不可用", createdAt: "2026-10-18", taskIds: ["original"] }] };
const running: GenerationTask = { id: "original", type: "canvas_video", status: "running", prompt: "fixture", attempts: 1, createdAt: "2026-10-18", updatedAt: "2026-10-18" };

test("historical false failure returns to pending when original task is still running", () => {
    const result = reconcileCreationTaskMessages(runtime, [conversation], [running]);
    expect(result[0].messages[0].status).toBe("pending");
    expect(result[0].messages[0].error).toBeUndefined();
    expect(result[0].messages[0].taskIds).toEqual(["original"]);
});

test("original completed video replaces a historical transport failure", () => {
    const result = reconcileCreationTaskMessages(runtime, [conversation], [{ ...running, status: "succeeded", creationResultStorageKeys: ["resource:video"] }]);
    expect(result[0].messages[0].status).toBe("done");
    expect(result[0].messages[0].resultStorageKeys).toEqual(["resource:video"]);
});

test("a partial batch is not marked complete while another task is unresolved", () => {
    const batch: CreationConversation = { ...conversation, messages: [{ ...conversation.messages[0], mode: "image", status: "pending", submissionOperationIds: ["operation:0", "operation:1"], taskIds: ["original", "second"] }] };
    const result = reconcileCreationTaskMessages(runtime, [batch], [{ ...running, status: "succeeded", creationResultStorageKeys: ["resource:image"] }]);
    expect(result[0].messages[0].status).toBe("pending");
    expect(result[0]).toBe(batch);
});

test("lost creation response exposes a stable operation identity and resolving it never creates a task", async () => {
    const adapter = apiClient.defaults.adapter;
    const requests: string[] = [];
    try {
        apiClient.defaults.adapter = async (config) => {
            requests.push(String(config.url));
            if (config.url === "/tasks") {
                const body = JSON.parse(String(config.data));
                expect(body.input.metadata.clientOperationId).toBe("stable-operation");
                throw new ApiError("unavailable", { status: 502 });
            }
            expect(JSON.parse(String(config.data))).toEqual({ operationIds: ["stable-operation"] });
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: [{ ...running, inputJson: JSON.stringify({ metadata: { clientOperationId: "stable-operation", conversationId: "chat", messageId: "message" } }) }], msg: "ok" } };
        };
        await expect(createGenerationTask({ prompt: "fixture", input: { metadata: { clientOperationId: "stable-operation" } } })).rejects.toBeInstanceOf(TaskSubmissionUncertainError);
        const tasks = await resolveGenerationTaskSubmissions(["stable-operation"]);
        expect(tasks[0].id).toBe("original");
        expect(tasks[0].clientContext?.messageId).toBe("message");
        expect(requests).toEqual(["/tasks", "/tasks/resolve-submissions"]);
    } finally { apiClient.defaults.adapter = adapter; }
});
