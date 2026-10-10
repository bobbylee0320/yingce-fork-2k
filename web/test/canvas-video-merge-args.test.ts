import { describe, expect, test } from "bun:test";

import { buildRecordingTranscodeArgs } from "../src/lib/canvas/canvas-video-merge-args";

describe("buildRecordingTranscodeArgs", () => {
    test("奇数画布先裁成偶数，并且不要求音轨", () => {
        const args = buildRecordingTranscodeArgs("recording.webm", "recording-transcoded.mp4");
        expect(args).toContain("-an");
        expect(args).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
        expect(args).not.toContain("-c:a");
        expect(args.indexOf("-vf")).toBeGreaterThan(args.indexOf("-i"));
        expect(args.indexOf("-vf")).toBeLessThan(args.indexOf("recording-transcoded.mp4"));
        expect(args).toEqual(["-i", "recording.webm", "-an", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", "1", "recording-transcoded.mp4"]);
    });
});
