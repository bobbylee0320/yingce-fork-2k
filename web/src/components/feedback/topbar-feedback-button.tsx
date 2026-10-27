import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";

import { useUserFeedbackEnabled } from "@/lib/plugins/builtin/user-feedback";
import { FeedbackModal } from "./feedback-modal";

/** 顶栏固定反馈入口：与积分胶囊同一行，不再悬浮遮挡页面内容。 */
export function TopbarFeedbackButton() {
    const enabled = useUserFeedbackEnabled();
    const [open, setOpen] = useState(false);

    if (!enabled) return null;

    return (
        <>
            <button type="button" className="app-workspace-topbar-feedback-pill" aria-label="意见与问题反馈" title="反馈问题或提议新功能" onClick={() => setOpen(true)}>
                <MessageSquarePlus aria-hidden="true" />
                <span>反馈</span>
            </button>
            <FeedbackModal open={open} onClose={() => setOpen(false)} />
        </>
    );
}
