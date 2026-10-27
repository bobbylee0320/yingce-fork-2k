import type { CSSProperties } from "react";

/**
 * 进度条填充只对 transform 做过渡，不对 width 做动画（避免每帧重排）。
 * 填充元素本身占满轨道（width: 100%），用 translateX 向左藏起未完成部分；轨道必须 overflow: hidden。
 */
export function progressFillStyle(percent: number, extra?: CSSProperties): CSSProperties {
    const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    return { ...extra, width: "100%", transform: `translateX(${value - 100}%)` };
}
