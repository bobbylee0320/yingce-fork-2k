import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
    new URL("../src/components/layout/workspace-account-card.tsx", import.meta.url),
    "utf8",
);
const sidebarSource = readFileSync(
    new URL("../src/components/layout/workspace-sidebar-nav.tsx", import.meta.url),
    "utf8",
);

describe("workspace account navigation", () => {
    test("uses the stable fixed menu restored from the pre-update implementation", () => {
        expect(sidebarSource).toContain('className="workspace-sidebar-account-menu"');
        expect(sidebarSource).toContain("createPortal(");
        expect(sidebarSource).toContain("aria-expanded={menuOpen}");
        expect(sidebarSource).not.toContain('placement="topLeft"');
    });

    test("lets router links navigate before closing the account menu", () => {
        expect(source).toContain("const handleNavigation = () => queueMicrotask(onNavigate);");
        expect(source).toContain('<Link to="/settings" onClick={handleNavigation}>');
        expect(source).toContain('<Link to="/admin" onClick={handleNavigation}>');
    });
});
