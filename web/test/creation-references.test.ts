import { describe, expect, test } from "bun:test";

import { canvasResourceMentionToken } from "../src/lib/canvas/canvas-resource-references";
import { creationAttachmentFromAsset, creationAttachmentFromImage, creationAttachmentKind, creationFileAccepted, creationMediaAspectRatio, creationUploadAccept, type CreationAttachment } from "../src/pages/create/creation-assets";
import {
    buildCreationMentionReferences,
    displayCreationPrompt,
    expandCreationPrompt,
    reconcileCreationAttachmentLimit,
    reconcileCreationAttachmentLimits,
    removeCreationReferenceTokens,
    replaceCreationAttachmentReference,
    selectedCreationReferences,
} from "../src/pages/create/creation-references";

function imageAttachment(id: string): CreationAttachment {
    return {
        id,
        name: `${id}.png`,
        type: "image/png",
        dataUrl: `data:image/png;base64,${id}`,
        previewUrl: `data:image/png;base64,${id}`,
    };
}

function mediaAttachment(id: string, type: string): CreationAttachment {
    return { id, name: id, type, url: `blob:${id}`, storageKey: `${id}:key`, previewUrl: "" };
}

describe("creation references", () => {
    test("removes attachments and prompt tokens beyond the current model limit", () => {
        const attachments = [imageAttachment("first"), imageAttachment("second"), imageAttachment("third")];
        const references = buildCreationMentionReferences([], attachments);
        const result = reconcileCreationAttachmentLimit(attachments, references, 1);
        const prompt = references.map(canvasResourceMentionToken).join(" ");
        const nextPrompt = removeCreationReferenceTokens(prompt, result.removedReferences);

        expect(result.attachments).toEqual([attachments[0]]);
        expect(result.removedReferences.map((reference) => reference.attachmentId)).toEqual(["second", "third"]);
        expect(nextPrompt).toContain(canvasResourceMentionToken(references[0]));
        expect(nextPrompt).not.toContain(canvasResourceMentionToken(references[1]));
        expect(nextPrompt).not.toContain(canvasResourceMentionToken(references[2]));
    });

    test("returns the original attachment list when it is already within the limit", () => {
        const attachments = [imageAttachment("first")];
        const result = reconcileCreationAttachmentLimit(attachments, buildCreationMentionReferences([], attachments), 1);

        expect(result.attachments).toBe(attachments);
        expect(result.removedReferences).toEqual([]);
    });

    test("视频参考内容分别遵守图片、视频和音频上限", () => {
        const attachments = [imageAttachment("image-1"), mediaAttachment("video-1", "video/mp4"), imageAttachment("image-2"), mediaAttachment("audio-1", "audio/mpeg"), mediaAttachment("video-2", "video/mp4")];
        const references = buildCreationMentionReferences([], attachments);
        const result = reconcileCreationAttachmentLimits(attachments, references, { maxImages: 1, maxVideos: 2, maxAudios: 0 });

        expect(result.attachments.map((attachment) => attachment.id)).toEqual(["image-1", "video-1", "video-2"]);
        expect(result.removedReferences.map((reference) => reference.attachmentId)).toEqual(["image-2", "audio-1"]);
    });

    test("视频参考内容在各类型均未超限时保留原数组", () => {
        const attachments = [imageAttachment("image"), mediaAttachment("video", "video/mp4"), mediaAttachment("audio", "audio/mpeg")];
        const result = reconcileCreationAttachmentLimits(attachments, buildCreationMentionReferences([], attachments), { maxImages: 1, maxVideos: 1, maxAudios: 1 });

        expect(result.attachments).toBe(attachments);
        expect(result.removedReferences).toEqual([]);
    });

    test("文本创作允许媒体和常用文档，图片创作仍只接受图片", () => {
        expect(creationFileAccepted("text", { name: "story.pdf", type: "application/pdf" })).toBe(true);
        expect(creationFileAccepted("text", { name: "clip.mp4", type: "video/mp4" })).toBe(true);
        expect(creationFileAccepted("image", { name: "story.pdf", type: "application/pdf" })).toBe(false);
        expect(creationUploadAccept("text")).toContain(".docx");
    });

    test("文档附件会作为文本资源参与引用", () => {
        const attachment: CreationAttachment = { id: "document", name: "script.pdf", type: "application/pdf", url: "https://example.com/script.pdf", storageKey: "resource:document", bytes: 1024, previewUrl: "" };
        const [reference] = buildCreationMentionReferences([], [attachment]);

        expect(creationAttachmentKind(attachment)).toBe("file");
        expect(reference.kind).toBe("text");
        expect(reference.label).toBe("文件1");
    });

    test("图片和音频引用直接显示文件名", () => {
        const audio: CreationAttachment = { id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "blob:audio", storageKey: "audio:key", previewUrl: "" };
        const references = buildCreationMentionReferences([], [imageAttachment("first"), audio, imageAttachment("second")]);

        expect(references.map((reference) => reference.label)).toEqual(["first.png", "audio.mp3", "second.png"]);
        expect(references[1].mediaUrl).toBe("blob:audio");
        expect(references[1].storageKey).toBe("audio:key");
        expect(displayCreationPrompt("@[attachment:audio]", references)).toBe("@audio.mp3");
        expect(expandCreationPrompt("@[attachment:audio]", references, [audio])).toContain("@audio.mp3：参考音频 1");
    });

    test("上传图片使用原文件名，素材库图片使用素材名称", () => {
        const uploaded = { url: "blob:portrait", storageKey: "resource:portrait", width: 640, height: 480, bytes: 128, mimeType: "image/png" };
        const local = creationAttachmentFromImage(new File([], "赢渊 三视图.png", { type: "image/png" }), uploaded);
        const library = creationAttachmentFromAsset({ id: "palace", kind: "image", title: "质子府暗室", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "blob:palace", width: 640, height: 480, bytes: 128, mimeType: "image/png" } });
        const references = buildCreationMentionReferences([], [local, library]);
        expect(references.map((reference) => reference.label)).toEqual(["赢渊 三视图.png", "质子府暗室"]);
        expect(references.map((reference) => reference.title)).toEqual(["赢渊 三视图.png", "质子府暗室"]);
        const prompt = references.map(canvasResourceMentionToken).join(" ");
        expect(displayCreationPrompt(prompt, references)).toBe("@赢渊 三视图.png @质子府暗室");
        expect(expandCreationPrompt(prompt, references, [local, library])).toContain("@质子府暗室：参考图片 2");
    });

    test("同名图片按附件 ID 独立引用，重排或删除不会串图", () => {
        const attachments = ["first", "second"].map((id) => ({ ...imageAttachment(id), name: "角色.png" }));
        const references = buildCreationMentionReferences([], attachments);
        const prompt = references.map(canvasResourceMentionToken).join(" ");
        const reordered = buildCreationMentionReferences([], [...attachments].reverse());
        expect(selectedCreationReferences(prompt, reordered)).toHaveLength(2);
        const remaining = removeCreationReferenceTokens(prompt, [references[0]]);
        expect(selectedCreationReferences(remaining, reordered).map((reference) => reference.attachmentId)).toEqual(["second"]);
    });

    test("无文件名时明确标记未命名图片，不重新生成图片编号", () => {
        const [reference] = buildCreationMentionReferences([], [{ ...imageAttachment("empty"), name: " " }]);
        expect(reference.label).toBe("未命名图片");
    });

    test("同名音频保留独立引用，删除一个不会移除另一个", () => {
        const attachments = ["first", "second"].map((id) => ({ ...mediaAttachment(id, "audio/mpeg"), name: "角色 声音.mp3" }));
        const references = buildCreationMentionReferences([], attachments);
        const prompt = references.map(canvasResourceMentionToken).join(" ");

        expect(selectedCreationReferences(prompt, references)).toHaveLength(2);
        const remaining = removeCreationReferenceTokens(prompt, [references[0]]);
        expect(selectedCreationReferences(remaining, references).map((reference) => reference.attachmentId)).toEqual(["second"]);
        expect(displayCreationPrompt(remaining, references).trim()).toBe("@角色 声音.mp3");
    });

    test("媒体占位按本次选择的画幅展示并为异常值提供模式回退", () => {
        expect(creationMediaAspectRatio("16:9", "video")).toBe("16 / 9");
        expect(creationMediaAspectRatio("1:1", "image")).toBe("1 / 1");
        expect(creationMediaAspectRatio("1920x1080", "image")).toBe("1920 / 1080");
        expect(creationMediaAspectRatio("auto", "video")).toBe("16 / 9");
        expect(creationMediaAspectRatio("auto", "image")).toBe("1 / 1");
    });

    test("替换图片时保留目标位置且提示词无需修改", () => {
        const attachments = [imageAttachment("first"), imageAttachment("second"), imageAttachment("third")];
        const references = buildCreationMentionReferences([], attachments);
        const oldToken = canvasResourceMentionToken(references[1]);
        const replacement = imageAttachment("replacement");

        const result = replaceCreationAttachmentReference(`让 ${oldToken} 靠近 ${oldToken}`, attachments, "second", replacement);
        const nextReferences = buildCreationMentionReferences([], result.attachments);
        const replacementReference = nextReferences.find((reference) => reference.attachmentId === replacement.id)!;
        const replacementToken = canvasResourceMentionToken(replacementReference);

        expect(result.attachments.map((attachment) => attachment.id)).toEqual(["first", "replacement", "third"]);
        expect(replacementReference.label).toBe("replacement.png");
        expect(result.prompt).toBe(`让 ${replacementToken} 靠近 ${replacementToken}`);
        expect(result.prompt).not.toContain(oldToken);
        expect(displayCreationPrompt(result.prompt, nextReferences)).toBe("让 @replacement.png 靠近 @replacement.png");
    });

    test("删除中间附件后只移除该附件引用，后续附件仍按稳定身份保留", () => {
        const attachments = ["first", "second", "third", "fourth", "fifth"].map(imageAttachment);
        const references = buildCreationMentionReferences([], attachments);
        const third = references[2];
        const fifth = references[4];
        const prompt = `删除前比较 ${canvasResourceMentionToken(third)} 和 ${canvasResourceMentionToken(fifth)}`;
        const remaining = attachments.filter((attachment) => attachment.id !== "third");
        const nextPrompt = removeCreationReferenceTokens(prompt, [third]);
        const nextReferences = buildCreationMentionReferences([], remaining);

        expect(nextPrompt).not.toContain(canvasResourceMentionToken(third));
        expect(nextPrompt).toContain(canvasResourceMentionToken(fifth));
        expect(selectedCreationReferences(nextPrompt, nextReferences).map((reference) => reference.attachmentId)).toEqual(["fifth"]);
        expect(displayCreationPrompt(nextPrompt, nextReferences)).toBe("删除前比较  和 @fifth.png");
    });

    test("替换会归一化可见标签并去除已存在的重复附件", () => {
        const attachments = [imageAttachment("source"), imageAttachment("target"), imageAttachment("third")];
        const result = replaceCreationAttachmentReference("让 @target.png 参考 @target.png。", attachments, "target", attachments[0]);
        const references = buildCreationMentionReferences([], result.attachments);
        const sourceReference = references.find((reference) => reference.attachmentId === "source")!;

        expect(result.attachments.map((attachment) => attachment.id)).toEqual(["third", "source"]);
        expect(sourceReference.label).toBe("source.png");
        expect(result.prompt).toBe(`让 ${canvasResourceMentionToken(sourceReference)} 参考 ${canvasResourceMentionToken(sourceReference)}。`);
    });

    test("目标附件不存在时拒绝替换", () => {
        expect(() => replaceCreationAttachmentReference("", [imageAttachment("first")], "missing", imageAttachment("next"))).toThrow("要替换的参考内容不存在");
    });
});
