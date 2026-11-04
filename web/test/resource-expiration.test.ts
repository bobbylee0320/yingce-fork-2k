import { describe, expect, test } from "bun:test";

import { apiClient } from "../src/services/api/request";
import { clearResourceAccessCache, getResourceAccess, ResourceExpiredError } from "../src/services/api/resources";

describe("expired generated resources", () => {
    test("turns a batched resource_expired response into a stable client error", async () => {
        const adapter = apiClient.defaults.adapter;
        clearResourceAccessCache();
        apiClient.defaults.adapter = async (config) => ({
            config,
            headers: {},
            status: 200,
            statusText: "OK",
            data: {
                code: 0,
                data: { items: [{ resourceId: "expired-resource", error: { reason: "resource_expired", msg: "资源已过期" } }] },
            },
        });
        try {
            await expect(getResourceAccess("resource:expired-resource")).rejects.toBeInstanceOf(ResourceExpiredError);
        } finally {
            apiClient.defaults.adapter = adapter;
            clearResourceAccessCache();
        }
    });
});
