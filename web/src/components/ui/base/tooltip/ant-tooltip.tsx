import { Tooltip as AntdTooltip, type TooltipProps } from "antd";
import { forwardRef, type ComponentRef } from "react";

/** 首次悬停 500ms 再出现，与 base Tooltip 一致；antd 默认 100ms 会在扫过工具栏时连续闪现。 */
export const TOOLTIP_ENTER_DELAY_SECONDS = 0.5;

/**
 * 需要 antd Tooltip 能力（styles、受控 open、包裹禁用按钮）时的唯一入口，统一首次悬停延迟。
 * 调用方显式传入 mouseEnterDelay 时仍以调用方为准。
 */
export const AntTooltip = forwardRef<ComponentRef<typeof AntdTooltip>, TooltipProps>(function AntTooltip({ mouseEnterDelay = TOOLTIP_ENTER_DELAY_SECONDS, ...props }, ref) {
    return <AntdTooltip ref={ref} mouseEnterDelay={mouseEnterDelay} {...props} />;
});
