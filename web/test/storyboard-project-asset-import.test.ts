import { describe, expect, it } from "bun:test";
import { toInsertPayload } from "@/components/canvas/canvas-project-asset-modal";
import type { ProjectAsset } from "@/services/api/projects";
import type { Asset } from "@/stores/use-asset-store";

describe("storyboard project asset import", () => {
    it("uses the project current resource rather than a stale local media copy", () => {
        const project: ProjectAsset = { id: "video", title: "项目视频", mediaType: "video", category: "material", status: "confirmed", versionCount: 2, usages: [], position: 0, storageKey: "resource:current", updatedAt: "2026-10-16" };
        const media: Asset = { id: "video", title: "本地旧视频", kind: "video", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { url: "old.mp4", storageKey: "resource:old", width: 640, height: 360, bytes: 1, mimeType: "video/mp4" } };
        const payload = toInsertPayload({ id: "video", category: "material", project, media });
        expect(payload).toMatchObject({ kind: "video", title: "项目视频", assetId: "video", storageKey: "resource:current" });
        expect(payload.kind === "video" && payload.url).toContain("current");
    });
    it("keeps dimensions and duration when the local media matches the current project resource", () => {
        const project: ProjectAsset = { id: "image", title: "竖图", mediaType: "image", category: "environment", status: "confirmed", versionCount: 1, usages: [], position: 0, storageKey: "resource:current", updatedAt: "" };
        const media: Asset = {
            id: "image",
            title: "竖图",
            kind: "image",
            coverUrl: "",
            tags: [],
            createdAt: "",
            updatedAt: "",
            data: { dataUrl: "current.jpg", storageKey: "resource:current", width: 768, height: 1024, bytes: 123, mimeType: "image/jpeg" },
        };
        expect(toInsertPayload({ id: "image", category: "environment", project, media })).toMatchObject({ kind: "image", width: 768, height: 1024, bytes: 123, mimeType: "image/jpeg" });
        expect(
            toInsertPayload({
                id: "video",
                category: "material",
                project: { ...project, id: "video", mediaType: "video", durationMs: 5000 },
                media: { ...media, id: "video", kind: "video", data: { url: "video.mp4", storageKey: "resource:current", width: 1920, height: 1080, durationMs: 5000, bytes: 234, mimeType: "video/mp4" } },
            }),
        ).toMatchObject({ kind: "video", width: 1920, height: 1080, durationMs: 5000 });
    });
});
