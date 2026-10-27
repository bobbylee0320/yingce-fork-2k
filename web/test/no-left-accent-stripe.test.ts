import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// 设计原则「组件左侧不能有竖杠」：卡片、行、引用块和激活项不使用左侧强调条。
// 允许 1px 的栏间/单元格分隔线；短剧页面同样适用。
const root = resolve(import.meta.dir, "../src");
const skipped = [/^styles\/(globals|admin-ui)-\d+\.css$/];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.(css|tsx)$/.test(name) ? [path] : [];
    });
}

const stripePatterns: Array<[string, RegExp]> = [
    ["border-left 2px+", /border-(?:left|inline-start)(?:-width)?\s*:\s*(?:[2-9]|\d{2,})(?:\.\d+)?px/],
    ["inset left shadow", /inset\s+[1-9]\d*(?:\.\d+)?px\s+0(?:px)?\s+0/],
    ["tailwind border-l-N", /(?:^|[\s"'`:])border-[ls]-(?:[2-9]|\[)/],
    ["tailwind inset left shadow", /shadow-\[inset_[1-9]/],
    ["blockquote left border", /blockquote[^{]*\{[^}]*border-left\s*:\s*(?!0|none)/],
];

test("组件左侧不使用竖向强调条", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
        const rel = relative(root, file).replaceAll("\\", "/");
        if (skipped.some((pattern) => pattern.test(rel))) continue;
        const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const [label, pattern] of stripePatterns) if (pattern.test(source)) offenders.push(`${rel}: ${label}`);
    }
    expect(offenders).toEqual([]);
});

test("用户工作台卡片 hover 只换表面，不位移", () => {
    const globals = readFileSync(resolve(root, "styles/globals.css"), "utf8");
    const product = readFileSync(resolve(root, "styles/workspace-product.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(globals).toContain("--library-hover-offset: 0px;");
    const cardHover = [...product.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /product-collection-card:hover|task-record-row:hover/.test(selector));
    expect(cardHover.length).toBeGreaterThan(0);
    for (const [, selector, body] of cardHover) if (!selector.includes("prefers-reduced-motion")) expect(body).not.toMatch(/translate(?:X|Y)?\(\s*-?[1-9]/);
});
