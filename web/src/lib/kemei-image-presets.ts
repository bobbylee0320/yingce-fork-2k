import type { ImageResolutionOption, ImageResolutionTier } from "./image-resolution-tiers";

// Seedream 5.0 官方像素表；不能按通用像素阈值把 2K 横屏误分为 4K。
export function kemeiSeedreamPresets(): ImageResolutionOption[] {
    const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
    const tiers: [ImageResolutionTier, string[]][] = [
        ["1k", ["1024x1024", "1152x864", "864x1152", "1424x800", "800x1424", "1248x832", "832x1248", "1568x672"]],
        ["1.5k", ["1536x1536", "1792x1344", "1344x1792", "2048x1152", "1152x2048", "1872x1248", "1248x1872", "2352x1008"]],
        ["2k", ["2048x2048", "2368x1776", "1776x2368", "2816x1584", "1584x2816", "2496x1664", "1664x2496", "3136x1344"]],
    ];
    return tiers.flatMap(([tier, sizes]) =>
        sizes.map((size, index) => {
            const [width, height] = size.split("x").map(Number);
            return { tier, ratio: ratios[index], width, height, size };
        }),
    );
}
