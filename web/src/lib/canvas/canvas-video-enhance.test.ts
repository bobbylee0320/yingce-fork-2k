import assert from "node:assert/strict";
import test from "node:test";

import { videoEnhanceFpsBand, videoEnhanceResolutionShortEdge, videoEnhanceSourceError } from "./canvas-video-enhance";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function videoNode(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "v1", type: CanvasNodeType.Video, title: "源视频", position: { x: 0, y: 0 }, width: 400, height: 300, metadata };
}

test("帧率映射到火山计费档位", () => {
    assert.equal(videoEnhanceFpsBand(undefined), "le30");
    assert.equal(videoEnhanceFpsBand(30), "le30");
    assert.equal(videoEnhanceFpsBand(60), "le60");
    assert.equal(videoEnhanceFpsBand(120), "le120");
});

test("分辨率档位换算为短边像素", () => {
    assert.equal(videoEnhanceResolutionShortEdge("720p"), 720);
    assert.equal(videoEnhanceResolutionShortEdge("1080P"), 1080);
    assert.equal(videoEnhanceResolutionShortEdge("2k"), 1440);
    assert.equal(videoEnhanceResolutionShortEdge("4k"), 2160);
});

test("源视频前置校验：时长与规格", () => {
    assert.equal(videoEnhanceSourceError(videoNode({ storageKey: "resource:a", durationMs: 10_000, naturalWidth: 1280, naturalHeight: 720 }), 180), "");
    assert.match(videoEnhanceSourceError(videoNode({ storageKey: "resource:a", durationMs: 181_000 }), 180), /180 秒/);
    assert.match(videoEnhanceSourceError(videoNode({ storageKey: "resource:a", naturalWidth: 3840, naturalHeight: 2160 }), 180), /不受支持/);
    assert.match(videoEnhanceSourceError(videoNode({ storageKey: "resource:a", naturalWidth: 640, naturalHeight: 320 }), 180), /不受支持/);
    assert.match(videoEnhanceSourceError(videoNode({}), 180), /为空/);
});
