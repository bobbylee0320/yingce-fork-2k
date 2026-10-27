import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(new URL("../src/styles/workspace-product.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ICON_BUTTON = "button:has(> svg):not(:has(> span))";
const MOTION = /(^|[\s;])(transform|translate|scale)\s*:/;

function rules(selectorSuffix: string) {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].includes(`.app-product-workspace ${ICON_BUTTON}${selectorSuffix}`));
}

// 工作台按钮只做颜色反馈：悬浮上移、按压缩放会让每次点击和下拉触发器“回弹”，
// 还会覆盖靠 translateY(-50%) 居中的图标按钮定位。
test("图标按钮悬浮只改颜色，不做位移", () => {
    const hover = rules(":not(:disabled):hover");
    expect(hover.length).toBe(1);
    expect(hover[0][2]).not.toMatch(MOTION);
});

test("图标按钮按压不缩放", () => {
    expect(rules(":not(:disabled):active").length).toBe(0);
    expect(rules(":not(.ant-btn-icon-only)")[0]?.[2] ?? "").not.toMatch(/\b(translate|scale|transform) var/);
});

test("工作台不再挂载全局点击回弹动画", () => {
    const layout = readFileSync(resolve(import.meta.dir, "../src/layouts/user-layout.tsx"), "utf8");
    expect(layout).not.toContain("useWorkspaceButtonFeedback");
    const productActive = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => /\.ant-btn[^{]*:active/.test(match[1]));
    for (const [, , body] of productActive) expect(body).not.toMatch(MOTION);
});
