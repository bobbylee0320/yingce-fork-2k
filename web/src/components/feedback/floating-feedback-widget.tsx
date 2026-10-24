import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Tooltip } from "antd";

import { useUserFeedbackEnabled } from "@/lib/plugins/builtin/user-feedback";
import { FeedbackModal } from "./feedback-modal";
import { cn } from "@/lib/utils";

interface FloatingFeedbackWidgetProps {
    className?: string;
}

export function FloatingFeedbackWidget({ className }: FloatingFeedbackWidgetProps) {
    const enabled = useUserFeedbackEnabled();
    const [open, setOpen] = useState(false);

    if (!enabled) return null;

    return (
        <>
            <div className={cn("fixed bottom-6 right-6 z-40 select-none print:hidden transition-all duration-200", open ? "opacity-0 pointer-events-none scale-90" : "opacity-100 scale-100", className)}>
                <Tooltip title="反馈问题或提议新功能" placement="left" trigger={["hover"]}>
                    <button
                        type="button"
                        onClick={() => setOpen(true)}
                        className={cn(
                            "group flex items-center gap-2 rounded-full border border-border/80 bg-background/90 p-2 sm:px-3.5 sm:py-2",
                            "text-xs font-semibold text-foreground shadow-lg backdrop-blur-md transition-all duration-200",
                            "hover:border-primary/50 hover:bg-muted/80 hover:shadow-primary/10 hover:shadow-xl hover:scale-105",
                            "active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        )}
                        aria-label="意见与问题反馈"
                    >
                        <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                            <MessageSquarePlus className="size-3.5" />
                        </span>
                        <span className="hidden sm:inline-block tracking-wide">反馈建议</span>
                    </button>
                </Tooltip>
            </div>

            <FeedbackModal open={open} onClose={() => setOpen(false)} />
        </>
    );
}
