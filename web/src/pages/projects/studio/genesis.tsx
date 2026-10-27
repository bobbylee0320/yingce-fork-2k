import { CheckCircle2, Circle, Loader2, PauseCircle } from "lucide-react";

import type { DramaSummary } from "@/services/api/drama";

import { formatCount } from "../drama-shared";

/** 全剧第一集出现前的状态：让用户知道流水线在做什么，而不是面对空白页。 */
export function StudioGenesis({ summary }: { summary: DramaSummary }) {
    const { production } = summary;
    const bibleDone = production.stage !== "bible";
    const paused = production.status !== "running";
    const steps = [
        { label: `读取小说 · ${formatCount(production.chapterCount)} 章 ${formatCount(production.wordCount)} 字`, done: true },
        { label: "建立作品圣经：角色、道具、场景与画面规则", done: bibleDone, active: !bibleDone },
        { label: "分集改编：每集开场钩子与结尾悬念", done: summary.episodes.length > 0, active: bibleDone && !summary.episodes.length },
        { label: "第 1 集样片：剧本、段提示词与段视频", done: false, active: false },
    ];
    return (
        <div className="drama-genesis">
            <div className="drama-genesis-card">
                {paused ? <PauseCircle className="mx-auto mb-5 size-16 text-[var(--status-warning)]" /> : <div className="drama-genesis-orb" aria-hidden />}
                <h2>{paused ? (production.status === "draft" ? "准备好就可以开始" : "制作已暂停") : "正在把小说改编成短剧"}</h2>
                <p>{paused ? `${production.pauseReason || "系统会自动完成改编、建档、分镜与成片。"}点击右上角“${production.status === "draft" ? "开始制作" : "继续制作"}”。` : "这一步通常需要一两分钟。你可以离开页面，进度会在服务端继续。"}</p>
                <div className="drama-genesis-steps">
                    {steps.map((step) => (
                        <div key={step.label} className={`drama-genesis-step ${step.done ? "is-done" : step.active && !paused ? "is-active" : ""}`}>
                            {step.done ? <CheckCircle2 className="size-4 text-[var(--status-success)]" /> : step.active && !paused ? <Loader2 className="size-4 animate-spin text-[var(--workspace-accent)]" /> : <Circle className="size-4 opacity-35" />}
                            {step.label}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
