import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("real collaboration layer shares its connection and projects presence through the live viewport", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/canvas-collaboration.harness.tsx"], { cwd: resolve(import.meta.dir, ".."), timeout: 15000 });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(output).toContain("5 pass");
    expect(output).toContain("0 fail");
    expect(result.exitCode).toBe(0);
});
