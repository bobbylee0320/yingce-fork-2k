import { expect, test } from "bun:test";
import { resolve } from "node:path";

// React DOM 的环境检测需要在独立进程中先安装 DOM，避免受其他 SSR 用例影响。
test("真实连接控制器的悬停、释放、取消及重叠节点回归", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-connection-controller.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 20000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    if (result.exitCode !== 0) throw new Error(output);
    expect(result.exitCode).toBe(0);
});
