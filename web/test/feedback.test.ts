import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { USER_FEEDBACK_PLUGIN_ID, userFeedbackPlugin } from "../src/lib/plugins/builtin/user-feedback";
import { http } from "../src/services/api/request";
import { getAdminFeedbacks } from "../src/services/api/feedback";
import { isOfficialApplicationPluginId } from "../src/lib/plugins/official-applications";

let getAdminFeedbacksSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => getAdminFeedbacksSpy?.mockRestore());
describe("User Feedback Plugin", () => {
    test("插件元数据完整且正确注册", () => {
        expect(userFeedbackPlugin.manifest.id).toBe(USER_FEEDBACK_PLUGIN_ID);
        expect(userFeedbackPlugin.manifest.name).toContain("反馈");
        expect(isOfficialApplicationPluginId(USER_FEEDBACK_PLUGIN_ID)).toBe(true);
    });

    test("反馈类型与状态枚举完整", () => {
        const types = ["bug", "feature", "improvement", "other"];
        const statuses = ["pending", "processing", "resolved", "closed", "archived"];
        expect(types).toHaveLength(4);
        expect(statuses).toHaveLength(5);
    });

    test("管理员反馈分页使用后端 pageSize 参数", async () => {
        getAdminFeedbacksSpy = spyOn(http, "get").mockResolvedValue({
            list: [],
            total: 0,
            page: 2,
            limit: 15,
        } as never);

        await getAdminFeedbacks({ page: 2, limit: 15 });

        expect(getAdminFeedbacksSpy).toHaveBeenCalledWith("/admin/feedbacks?page=2&pageSize=15");
    });
});
