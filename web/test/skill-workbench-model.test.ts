import { describe, expect, test } from "bun:test";

import { buildFileTree, buildSaveOperations, collectFolders, flattenTree, fuzzyScore, isEntryDirty, isTextEditablePath, pathConflict, validateSkillPath, type WorkbenchEntry } from "../src/lib/skills/skill-workbench-model";

describe("技能工作台文件树", () => {
    const paths = ["SKILL.md", "references/camera.md", "references/zeta/deep.md", "scripts/check.py", "README.md"];

    test("文件夹在前、SKILL.md 置顶，按展开状态拍平", () => {
        const tree = buildFileTree(paths, ["empty"]);
        expect(tree.map((node) => node.path)).toEqual(["empty", "references", "scripts", "SKILL.md", "README.md"]);
        const collapsed = flattenTree(tree, new Set());
        expect(collapsed.map((row) => row.path)).toEqual(["empty", "references", "scripts", "SKILL.md", "README.md"]);
        const expanded = flattenTree(tree, new Set(["references", "references/zeta"]));
        expect(expanded.map((row) => `${row.depth}:${row.path}`)).toEqual(["0:empty", "0:references", "1:references/zeta", "2:references/zeta/deep.md", "1:references/camera.md", "0:scripts", "0:SKILL.md", "0:README.md"]);
        expect(expanded.find((row) => row.path === "references/camera.md")?.parent).toBe("references");
    });

    test("筛选只保留命中文件及其祖先并强制展开", () => {
        const rows = flattenTree(buildFileTree(paths), new Set(), "deep");
        expect(rows.map((row) => row.path)).toEqual(["references", "references/zeta", "references/zeta/deep.md"]);
        expect(rows.every((row) => row.type === "file" || row.expanded)).toBe(true);
    });

    test("文件与文件夹不能重名", () => {
        const files = new Set(paths);
        const folders = collectFolders(files, ["empty"]);
        expect(pathConflict("references", files, folders)).not.toBeNull();
        expect(pathConflict("SKILL.md/child.md", files, folders)).not.toBeNull();
        expect(pathConflict("empty/new.md", files, folders)).toBeNull();
        expect(pathConflict("README.md", files, folders, (path) => path === "README.md")).toBeNull();
    });
});

describe("技能路径校验与后端一致", () => {
    test.each([["../x.md"], ["/abs.md"], ["a//b.md"], ["./a.md"], ["a\\b.md"], [".git/config"], ["__MACOSX/a"], ["a/.DS_Store"], ["1/2/3/4/5/6/7/8/9.md"], [" padded.md"], ["tab\tname.md"]])("拒绝 %p", (path) => {
        expect(validateSkillPath(path)).not.toBeNull();
    });

    test("接受规范化的中文与嵌套路径", () => {
        expect(validateSkillPath("参考/镜头语言.md")).toBeNull();
        expect(validateSkillPath("1/2/3/4/5/6/7/8.md")).toBeNull();
    });

    test("新建文件只允许文本类型", () => {
        expect(isTextEditablePath("notes.md")).toBe(true);
        expect(isTextEditablePath("LICENSE")).toBe(true);
        expect(isTextEditablePath("cover.png")).toBe(false);
    });
});

describe("保存操作折叠", () => {
    const basePaths = ["SKILL.md", "a.md", "b.md", "old.md", "logo.png"];
    const baseContents = new Map([
        ["SKILL.md", "# skill"],
        ["a.md", "A"],
        ["b.md", "B"],
    ]);

    test("顺序为删除 → 改名 → 写入，未改动文件不提交", () => {
        const entries: WorkbenchEntry[] = [
            { path: "SKILL.md", origin: "SKILL.md" },
            { path: "a.md", origin: "a.md" },
            { path: "docs/b.md", origin: "b.md" },
            { path: "assets/logo.png", origin: "logo.png" },
            { path: "new.md", origin: null },
        ];
        const buffers = new Map([
            ["SKILL.md", "# skill v2"],
            ["a.md", "A"],
            ["docs/b.md", "B2"],
        ]);
        expect(buildSaveOperations({ basePaths, entries, buffers, baseContents })).toEqual([
            { op: "delete", path: "old.md" },
            { op: "rename", path: "b.md", to: "docs/b.md" },
            { op: "rename", path: "logo.png", to: "assets/logo.png" },
            { op: "write", path: "SKILL.md", content: "# skill v2" },
            { op: "write", path: "docs/b.md", content: "B2" },
            { op: "write", path: "new.md", content: "" },
        ]);
        expect(isEntryDirty(entries[1], buffers, baseContents)).toBe(false);
        expect(isEntryDirty(entries[2], buffers, baseContents)).toBe(true);
    });

    test("互换文件名时借助临时路径，不覆盖彼此", () => {
        const entries: WorkbenchEntry[] = [
            { path: "SKILL.md", origin: "SKILL.md" },
            { path: "b.md", origin: "a.md" },
            { path: "a.md", origin: "b.md" },
        ];
        const operations = buildSaveOperations({ basePaths: ["SKILL.md", "a.md", "b.md"], entries, buffers: new Map(), baseContents });
        // 在内存中重放，结果必须与工作副本一致。
        const files = new Map([
            ["SKILL.md", "S"],
            ["a.md", "A"],
            ["b.md", "B"],
        ]);
        for (const operation of operations) {
            if (operation.op !== "rename") throw new Error("unexpected op");
            expect(files.has(operation.to)).toBe(false);
            files.set(operation.to, files.get(operation.path)!);
            files.delete(operation.path);
        }
        expect(Object.fromEntries(files)).toEqual({ "SKILL.md": "S", "b.md": "A", "a.md": "B" });
    });

    test("删除后在原路径新建文件", () => {
        const entries: WorkbenchEntry[] = [
            { path: "SKILL.md", origin: "SKILL.md" },
            { path: "a.md", origin: null },
        ];
        expect(buildSaveOperations({ basePaths: ["SKILL.md", "a.md"], entries, buffers: new Map([["a.md", "fresh"]]), baseContents })).toEqual([
            { op: "delete", path: "a.md" },
            { op: "write", path: "a.md", content: "fresh" },
        ]);
    });
});

test("快速打开优先文件名连续命中", () => {
    expect(fuzzyScore("references/camera.md", "cam")).toBeGreaterThan(fuzzyScore("scripts/check-a-move.py", "cam"));
    expect(fuzzyScore("SKILL.md", "xyz")).toBe(-1);
});

test("技能工作台路由已注册且样式不使用左侧竖条", async () => {
    const router = await Bun.file(new URL("../src/router.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/pages/skills/workbench/skill-workbench.css", import.meta.url)).text();
    expect(router).toContain('path: "/skills/:skillId/edit"');
    expect(css).not.toMatch(/border-left\s*:|inset\s+\d+px\s+0\s+0\s+[a-z(]/);
    expect(css).toContain("prefers-reduced-motion");
});
