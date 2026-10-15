import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSettingsPanel } from "../src/components/image-settings-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";
import { priceTierToForm, skuSelectorFromForm } from "../src/pages/admin/components/channel-model-price-tier-form";
import type { AiConfig } from "../src/stores/use-config-store";

function seedreamConfig(model: string): AiConfig {
    return {
        imageModel: model,
        model,
        size: "2048x2048",
        transparentBackground: "false",
        channels: [
            {
                id: "ch-seedream",
                scope: "system",
                enabled: true,
                name: "可美",
                baseUrl: "/api/ai/system/CHANNEL",
                apiFormat: "openai",
                concurrencyLimit: 0,
                models: [model],
                modelCosts: [{ model, protocol: "km-kemei-seedream", capability: "image", priceConfigured: true }],
                hasApiKey: true,
                hasSecretKey: false,
                createdAt: "",
                updatedAt: "",
            },
        ],
    } as unknown as AiConfig;
}

describe("ImageSettingsPanel with km-kemei-seedream", () => {
    test("Pro/Flash 只显示 1K / 1.5K / 2K，不显示 4K，且分辨率分段只有一处", () => {
        for (const model of ["doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915"]) {
            const html = renderToStaticMarkup(<ImageSettingsPanel config={seedreamConfig(model)} onConfigChange={() => {}} theme={canvasThemes.dark} />);
            expect((html.match(/分辨率/g) || []).length).toBe(1);
            expect(html).toContain("1K");
            expect(html).toContain("1.5K");
            expect(html).toContain("2K");
            expect(html).not.toContain("4K");
        }
    });

    test("存量 Seedream 价格档 quality=1k/1.5k/2k 安全迁移为 imageResolution，无冲突", () => {
        const profile = defaultImageCapabilityConfig("km-kemei-seedream", "doubao-seedream-5-0-pro-260628");
        expect(profile.resolution).toEqual({ supported: true, values: ["1k", "1.5k", "2k"], default: "2k" });

        const rawTiers = [
            { id: "t1", selector: { quality: "1k" }, billingMode: "fixed_request", unitPriceMicrocredits: 20000000, priceConfigured: true, enabled: true },
            { id: "t2", selector: { quality: "1.5k" }, billingMode: "fixed_request", unitPriceMicrocredits: 40000000, priceConfigured: true, enabled: true },
            { id: "t3", selector: { quality: "2k" }, billingMode: "fixed_request", unitPriceMicrocredits: 40000000, priceConfigured: true, enabled: true },
        ];

        const formValues = rawTiers.map((tier) => priceTierToForm(tier, profile, "km-kemei-seedream"));
        expect(formValues[0].imageResolution).toBe("1k");
        expect(formValues[1].imageResolution).toBe("1.5k");
        expect(formValues[2].imageResolution).toBe("2k");

        const selectors = formValues.map((values) => skuSelectorFromForm("image", values, { image: profile }));
        expect(selectors[0]).toEqual({ imageResolution: "1k" });
        expect(selectors[1]).toEqual({ imageResolution: "1.5k" });
        expect(selectors[2]).toEqual({ imageResolution: "2k" });
        expect(new Set(selectors.map((selector) => JSON.stringify(selector))).size).toBe(3);
    });
});
