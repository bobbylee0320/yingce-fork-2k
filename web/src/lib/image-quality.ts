const IMAGE_QUALITY_LABELS: Record<string, string> = {
    auto: "自动",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最高",
    "1k": "1K",
    "2k": "2K",
    "4k": "4K",
};

export function imageQualityLabel(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    return IMAGE_QUALITY_LABELS[normalized] || value;
}

export function imageQualityDescription(value: string) {
    switch (String(value || "").trim().toLowerCase()) {
        case "auto":
            return "由模型决定";
        case "low":
            return "更快生成";
        case "medium":
            return "均衡模式";
        case "high":
            return "优先速度";
        case "xhigh":
            return "优先质量";
        case "max":
            return "优先细节";
        case "1k":
            return "标准清晰度";
        case "2k":
            return "更高清晰度";
        case "4k":
            return "最高清晰度";
        default:
            return "模型支持的质量/分辨率";
    }
}

export function isImageResolutionTier(value: string) {
    return ["1k", "2k", "4k"].includes(String(value || "").trim().toLowerCase());
}
