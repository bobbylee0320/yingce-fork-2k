import { splitTextIntoChapters } from "@/lib/canvas/canvas-document";

// 小说导入只在浏览器内做结构化预览：拆章、清理网文平台噪音、标出需要人工确认的异常。
// 改编、拆集和建档全部交给服务端流水线。

export type ParsedChapter = { title: string; text: string; words: number };

export type NovelIssue = { kind: "no_heading" | "split_long" | "empty" | "duplicate" | "noise" | "short"; message: string };

export type NovelAnalysis = {
    chapters: ParsedChapter[];
    issues: NovelIssue[];
    words: number;
    removedNoiseLines: number;
};

export const MAX_CHAPTER_WORDS = 60_000;
const FALLBACK_CHUNK_WORDS = 3_000;
const SHORT_CHAPTER_WORDS = 300;

// 网文站点常见的插入语：网址、求票、作者有话说、广告等，只匹配整行。
const NOISE_PATTERNS = [
    /^\s*(?:https?:\/\/|www\.)\S+\s*$/i,
    /(?:求|跪求)(?:月票|推荐票|订阅|收藏|打赏)/,
    /^\s*(?:本章完|未完待续|（?本章未完.*）?)\s*$/,
    /^\s*(?:作者有话说|PS[:：]|ps[:：])/,
    /(?:手机阅读|最新章节|首发|笔趣阁|起点中文网|纵横中文网|免费阅读)/,
];

export function wordCount(text: string) {
    return Array.from(text.replace(/\s+/g, "")).length;
}

function stripNoise(text: string) {
    let removed = 0;
    const lines = text.split("\n").filter((line) => {
        const noisy = line.trim().length < 80 && NOISE_PATTERNS.some((pattern) => pattern.test(line));
        if (noisy) removed++;
        return !noisy;
    });
    return {
        text: lines
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        removed,
    };
}

/** 在段落边界把长文本切成约 target 字的块。 */
function chunkByParagraph(text: string, target: number) {
    const paragraphs = text.split(/\n+/);
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const paragraph of paragraphs) {
        const length = wordCount(paragraph);
        if (size > 0 && size + length > target) {
            chunks.push(current.join("\n"));
            current = [];
            size = 0;
        }
        current.push(paragraph);
        size += length;
    }
    if (current.length) chunks.push(current.join("\n"));
    return chunks.filter((chunk) => chunk.trim());
}

export function analyzeNovel(raw: string): NovelAnalysis {
    const normalized = raw
        .replace(/\r\n?/g, "\n")
        .replace(/\u3000/g, "  ")
        .trim();
    const issues: NovelIssue[] = [];
    const cleaned = stripNoise(normalized);
    if (cleaned.removed > 0) issues.push({ kind: "noise", message: `已移除 ${cleaned.removed} 行网址、求票等平台插入语` });

    let sections = splitTextIntoChapters(cleaned.text).map((section) => ({ title: section.title, text: section.plainText }));
    const detectedHeading = sections.length > 1 || (sections[0] && sections[0].title !== "第 1 章");
    if (!detectedHeading && wordCount(cleaned.text) > FALLBACK_CHUNK_WORDS * 1.5) {
        sections = chunkByParagraph(cleaned.text, FALLBACK_CHUNK_WORDS).map((text, index) => ({ title: `第 ${index + 1} 段`, text }));
        issues.push({ kind: "no_heading", message: `没有识别到章节标题，已按段落切成 ${sections.length} 段，改编时会自动合并成集` });
    }

    const chapters: ParsedChapter[] = [];
    let splitCount = 0;
    for (const section of sections) {
        const words = wordCount(section.text);
        if (words > MAX_CHAPTER_WORDS) {
            const parts = chunkByParagraph(section.text, Math.floor(MAX_CHAPTER_WORDS * 0.8));
            parts.forEach((text, index) => chapters.push({ title: `${section.title}（${index + 1}/${parts.length}）`, text, words: wordCount(text) }));
            splitCount++;
            continue;
        }
        chapters.push({ title: section.title, text: section.text, words });
    }
    if (splitCount) issues.push({ kind: "split_long", message: `${splitCount} 个超长章节已在段落处拆开` });

    const empty = chapters.filter((chapter) => chapter.words === 0).length;
    if (empty) issues.push({ kind: "empty", message: `${empty} 个章节没有正文，已跳过` });
    const nonEmpty = chapters.filter((chapter) => chapter.words > 0);

    const seen = new Map<string, number>();
    for (const chapter of nonEmpty) seen.set(chapter.title, (seen.get(chapter.title) || 0) + 1);
    const duplicated = [...seen.values()].filter((count) => count > 1).length;
    if (duplicated) issues.push({ kind: "duplicate", message: `${duplicated} 个章节标题重复，可能是重复粘贴，请确认` });

    const merged = mergeShortChapters(nonEmpty);
    if (merged.count) issues.push({ kind: "short", message: `${merged.count} 个不足 ${SHORT_CHAPTER_WORDS} 字的短章（如序章、楔子）已并入相邻章节` });

    return { chapters: merged.chapters, issues, words: merged.chapters.reduce((sum, chapter) => sum + chapter.words, 0), removedNoiseLines: cleaned.removed };
}

/**
 * 序章、楔子、作者的话这类短章单独成章没有改编价值，还会让分集过碎：
 * 并入下一章开头（最后一章则并入上一章），标题保留为“序章 + 第一章”。
 */
function mergeShortChapters(chapters: ParsedChapter[]) {
    if (chapters.length < 2) return { chapters, count: 0 };
    const result: ParsedChapter[] = [];
    let carry: ParsedChapter | null = null;
    let count = 0;
    for (const chapter of chapters) {
        const current: ParsedChapter = carry ? { title: `${carry.title} · ${chapter.title}`, text: `${carry.text}\n\n${chapter.text}`, words: carry.words + chapter.words } : chapter;
        carry = null;
        if (current.words < SHORT_CHAPTER_WORDS) {
            carry = current;
            count++;
            continue;
        }
        result.push(current);
    }
    if (carry) {
        const last = result.pop();
        result.push(last ? { title: last.title, text: `${last.text}\n\n${carry.text}`, words: last.words + carry.words } : carry);
    }
    return { chapters: result, count };
}

/** 从文件名推导作品名：去掉扩展名与常见的“全本/完结/TXT”后缀。 */
export function titleFromFileName(name: string) {
    return name
        .replace(/\.[^.]+$/, "")
        .replace(/[（(【[]?(?:全本|全集|完结|完本|精校|txt|TXT)[)）】\]]?/g, "")
        .replace(/[_\-\s]+$/g, "")
        .trim()
        .slice(0, 40);
}
