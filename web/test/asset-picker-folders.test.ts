import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("参考素材弹窗的真实分类与远端分页回归", async () => {
    const child = Bun.spawn([process.execPath, "test", "./test/fixtures/asset-picker-folders.harness.tsx"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
}, 30000);
