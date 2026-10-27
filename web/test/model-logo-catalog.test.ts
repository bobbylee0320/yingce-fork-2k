import { describe, expect, test } from "bun:test";
import { toc } from "@lobehub/icons/es/toc";
import { createModelLogoOption, getModelLogoCatalogIssues, MODEL_LOGO_CATEGORIES, MODEL_LOGO_FEATURED } from "../src/lib/model-logo-catalog";

const catalog = toc.filter((item) => ["model", "provider", "application"].includes(item.group));
const options = catalog.map(createModelLogoOption);
const option = (id: string) => options.find((item) => item.id === id)!;

describe("模型 Logo 用途目录", () => {
    test("库升级后新增图标须分类，删除或改名的图标须清理分类、名称、别名和推荐项", () => {
        expect(getModelLogoCatalogIssues(catalog)).toEqual({ unclassifiedIds: [], staleIds: [] });
    });

    test("检测新增和失效 ID，未知图标只留在全部目录且不根据库分组猜用途", () => {
        const changedCatalog = catalog.filter((item) => item.id !== "OpenAI");
        const futureIcon = { id: "FutureModel", title: "Future Model", group: "model" };
        const futureProvider = { ...futureIcon, group: "provider" };
        expect(getModelLogoCatalogIssues([...changedCatalog, futureIcon])).toEqual({ unclassifiedIds: ["FutureModel"], staleIds: ["OpenAI"] });
        expect(createModelLogoOption(futureIcon).categories).toEqual([]);
        expect(createModelLogoOption(futureProvider).categories).toEqual([]);
        expect(createModelLogoOption(futureIcon).searchText).toContain("futuremodel");
    });

    test("原目录所有图标都可从五类导航访问，常见项没有错误归类", () => {
        const categories = new Set<string>(MODEL_LOGO_CATEGORIES.map((item) => item.id));
        expect(options.length).toBeGreaterThan(300);
        for (const item of options) {
            expect(item.categories.length).toBeGreaterThan(0);
            expect(item.categories.every((category) => categories.has(category))).toBe(true);
        }
        for (const [category, ids] of Object.entries(MODEL_LOGO_FEATURED)) {
            for (const id of ids) expect(option(id)?.categories).toContain(category);
        }
    });

    test("多用途品牌可跨类，视频和音频专用图标不会混入 LLM", () => {
        expect(option("OpenAI").categories).toEqual(["image", "video", "llm", "audio", "platform"]);
        expect(option("Gemini").categories).toContain("llm");
        expect(option("Kling").categories).toEqual(["image", "video"]);
        expect(option("Sora").categories).toEqual(["video"]);
        expect(option("Suno").categories).toEqual(["audio"]);
        expect(option("DeepSeek").categories).toEqual(["llm"]);
        expect(option("OpenRouter").categories).toEqual(["platform"]);
    });

    test("中文名称和别名可搜索，展示名称不改变持久化 ID", () => {
        expect(option("Kling").label).toBe("可灵");
        expect(option("Kling").id).toBe("Kling");
        for (const [query, id] of [
            ["可灵", "Kling"],
            ["千问", "Qwen"],
            ["seedance", "Jimeng"],
            ["硅基流动", "SiliconCloud"],
            ["克劳德", "Claude"],
        ]) {
            expect(options.filter((item) => item.searchText.includes(query)).some((item) => item.id === id)).toBe(true);
        }
    });
});
