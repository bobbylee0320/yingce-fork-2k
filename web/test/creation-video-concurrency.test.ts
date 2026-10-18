import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.each(["creation-video-concurrency", "creation-message-reuse"])("工作台真实实现回归：%s", async (fixture) => {
    // 页面依赖的模拟放在独立进程，避免污染其他专项中的真实模块。
    const child = Bun.spawn([process.execPath, "test", `./test/fixtures/${fixture}.harness.tsx`], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
}, 30000);
