import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeNovel, MAX_CHAPTER_WORDS, titleFromFileName } from "./novel-parse";

const body = (text: string) => text.repeat(60);

test("splits chapters and strips platform noise lines", () => {
    const text = ["第一章 陨落的天才", body("萧炎站在广场上。"), "求月票！", "www.example.com", "第二章 退婚", body("纳兰嫣然来了。")].join("\n");
    const result = analyzeNovel(text);
    assert.equal(result.chapters.length, 2);
    assert.equal(result.chapters[0].title, "第一章 陨落的天才");
    assert.equal(result.removedNoiseLines, 2);
    assert.ok(!result.chapters[0].text.includes("月票"));
    assert.ok(result.issues.some((issue) => issue.kind === "noise"));
});

test("chunks headingless text by paragraphs", () => {
    const paragraph = "这是一段没有章节标题的正文。".repeat(40);
    const result = analyzeNovel(Array.from({ length: 30 }, () => paragraph).join("\n"));
    assert.ok(result.chapters.length > 1);
    assert.ok(result.issues.some((issue) => issue.kind === "no_heading"));
});

test("splits chapters above the server limit", () => {
    const paragraph = "字".repeat(1000);
    const body = Array.from({ length: 80 }, () => paragraph).join("\n");
    const result = analyzeNovel(`第一章 长\n${body}`);
    assert.ok(result.chapters.length >= 2);
    assert.ok(result.chapters.every((chapter) => chapter.words <= MAX_CHAPTER_WORDS));
});

test("merges tiny chapters such as a short prologue into the next chapter", () => {
    const result = analyzeNovel(["序章", "穿越了。", "第一章 零悟性", body("测试石碑毫无反应。"), "第二章 扫茅厕", body("夜里系统响起。")].join("\n"));
    assert.equal(result.chapters.length, 2);
    assert.equal(result.chapters[0].title, "序章 · 第一章 零悟性");
    assert.ok(result.chapters[0].text.startsWith("穿越了。"));
    assert.ok(result.issues.some((issue) => issue.kind === "short"));
});

test("flags duplicated chapter titles", () => {
    const result = analyzeNovel(`第一章 开端\n${body("甲乙丙")}\n第一章 开端\n${body("丁戊己")}`);
    assert.ok(result.issues.some((issue) => issue.kind === "duplicate"));
});

test("derives a clean title from the file name", () => {
    assert.equal(titleFromFileName("斗破苍穹（全本）.txt"), "斗破苍穹");
    assert.equal(titleFromFileName("my_novel.md"), "my_novel");
});
