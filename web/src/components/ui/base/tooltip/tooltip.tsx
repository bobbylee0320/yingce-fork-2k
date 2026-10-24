import { Fragment, isValidElement, useRef, type ComponentProps, type ReactNode } from "react";
import { Focusable, Tooltip as RACTooltip, TooltipTrigger, type Placement } from "react-aria-components";

import { cn } from "@/lib/utils";

/**
 * Tooltip — 气泡提示（自研，react-aria-components overlay）。
 *
 * - API 对齐 AntD Tooltip（title/placement/children），title 为空时不渲染浮层。
 * - 浮层定位、进出场、焦点管理由 RAC 承担（ADR-0008：复杂浮层以 RAC 为无障碍地基）。
 * - 样式只吃语义 token：bg-surface-strong（light #fff / dark #2a2a2a）+ text-foreground +
 *   border-border hairline，无裸色；motion 走 RAC 动画类 + motion-reduce 关停。
 * - 启用的控件直接接收 RAC 事件、ref 和描述；非交互/禁用内容用 span 接收悬停。
 * - placement 映射 AntD → RAC（topLeft→top left …）。
 * 对标：AntD Tooltip；boardui base/tooltip。
 */

export type TooltipPlacement = "top" | "topLeft" | "topRight" | "bottom" | "bottomLeft" | "bottomRight" | "left" | "right";

const PLACEMENT_MAP: Record<TooltipPlacement, Placement> = {
    top: "top",
    topLeft: "top left",
    topRight: "top right",
    bottom: "bottom",
    bottomLeft: "bottom left",
    bottomRight: "bottom right",
    left: "left",
    right: "right",
};

export interface TooltipProps {
    title?: ReactNode;
    placement?: TooltipPlacement;
    /** 悬停延迟 ms（默认 350，贴近 AntD mouseEnterDelay） */
    delay?: number;
    className?: string;
    children: ReactNode;
}

export function Tooltip({ title, placement = "top", delay = 350, className, children }: TooltipProps) {
    if (!title) return <>{children}</>;

    const triggerRef = useRef<HTMLSpanElement>(null);
    const child = isValidElement<{ disabled?: boolean; loading?: boolean; tabIndex?: number }>(children) ? children : null;
    const directTrigger =
        child && child.type !== Fragment && !child.props.disabled && !child.props.loading && (typeof child.type !== "string" || ["button", "a", "input", "select", "textarea", "summary"].includes(child.type) || child.props.tabIndex !== undefined);

    return (
        <TooltipTrigger delay={delay}>
            {/*
             * RAC 1.21 的 TooltipTrigger 通过 context 下发 hover/focus 处理与 triggerRef，
             * 但外层包装元素或子元素重新渲染时容易丢失内部 ref 引用，导致浮层回退到 (0, 0)。
             * 这里给外层 span 绑定稳定的 triggerRef 并直接透传给 RACTooltip，
             * 确保气泡定位始终锚定在控件正上方，绝不飞至屏幕左上角。
             */}
            <span ref={triggerRef} className="inline-flex">
                {directTrigger ? (
                    <Focusable>{child as ComponentProps<typeof Focusable>["children"]}</Focusable>
                ) : (
                    <Focusable excludeFromTabOrder>
                        <span className="inline-flex">{children}</span>
                    </Focusable>
                )}
            </span>
            <RACTooltip
                triggerRef={triggerRef}
                placement={PLACEMENT_MAP[placement]}
                offset={6}
                className={cn("z-50 max-w-64 rounded-md border border-border bg-surface-strong px-2 py-1 text-xs leading-relaxed text-foreground shadow-md", "ra-pop-in", className)}
            >
                {title}
            </RACTooltip>
        </TooltipTrigger>
    );
}
