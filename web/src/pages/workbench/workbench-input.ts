export function workbenchVideoOperation(references: ReadonlyArray<{ kind: string; role?: string }>) {
    if (references.some((reference) => reference.kind === "video" || (reference.kind === "image" && reference.role !== "first_frame" && reference.role !== "last_frame"))) return "reference_to_video";
    if (references.some((reference) => reference.kind === "image")) return "image_to_video";
    if (references.some((reference) => reference.kind === "audio")) return "audio_to_video";
    return "text_to_video";
}
