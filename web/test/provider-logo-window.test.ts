import { expect, test } from "bun:test";
import { createModelLogoResolver } from "../src/lib/model-logo-id";
import { formatWindow, promotionExpiry } from "../src/pages/admin/channels/provider-catalog-pricing";

test("logo IDs resolve irrespective of case without changing stored IDs", () => {
    const resolve = createModelLogoResolver(["Minimax", "OpenAI"]);
    expect(resolve("minimax")).toBe("Minimax");
    expect(resolve(" Minimax ")).toBe("Minimax");
    expect(resolve("unknown")).toBeUndefined();
});
test("promotion dates show year and permanent placement is explicit", () => {
    const period = { startsAt: "2026-10-16T12:00:00+08:00", endsAt: "2027-10-16T12:00:00+08:00" };
    expect(formatWindow(period)).toBe("2026-10-16 至 2027-10-16");
    expect(promotionExpiry(period, Date.parse(period.startsAt))).toContain("剩余 365 天");
    expect(formatWindow({ ...period, permanent: true })).toBe("长期推广 · 无到期日");
});
