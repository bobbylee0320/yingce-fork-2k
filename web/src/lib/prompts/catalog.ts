import type { SrtEntry } from "@/types/timeline";

export const IMAGE_PROMPT_REVERSE = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

export function workflowStarterPrompt(kind: "character_cards" | "character_three_view" | "storyboard_video", title: string, workflowTitle: string) {
    if (kind === "character_cards") return `请基于「${workflowTitle}」拆分主要角色，并为每个角色生成可用于后续创作的角色图片卡片：外观、服饰、身份、性格和视觉辨识点。`;
    if (kind === "character_three_view") return `请基于上游角色卡片生成「${title}」：同一角色的正面、侧面、背面三视图，保持服饰、发型、道具和比例一致。`;
    return `请基于上游角色三视图，为「${workflowTitle}」制作分镜剧情视频方案：包含镜头顺序、景别、动作、节奏和画面连续性。`;
}

export function buildTextRewritePrompt(sourceText: string, instruction: string) {
    return `请根据要求修改以下文本。\n\n原文：\n${sourceText}\n\n修改要求：\n${instruction}`;
}

export function buildVideoOperationPrompt(operation: string, prompt: string, operationLabel: string) {
    if (operation === "compare_versions") return `请对以下视频结果版本做对比分析，输出推荐版本、差异点和修改建议：\n${prompt}`;
    return `视频编辑任务：${operationLabel}\n创作要求：${prompt}`;
}

export function buildSubtitleHighlightSystemPrompt() {
    return `你是一个视频字幕关键词高亮助手。请输出严格 JSON。

任务目标：
- 为每条字幕判断是否需要高亮
- 每条字幕最多高亮 1 段
- 只返回最值得高亮的一个关键词或短语
- start 和 end 使用 JavaScript 字符串下标
- end 为 exclusive
- 没有明确重点时返回 shouldHighlight=false

高亮标准：
- 优先高亮结论词、数字、身份词、首次/突破词、强反差词
- 不要高亮虚词、口头语、整句长短语

边界约束：
- 不负责颜色、字号、位置、动效
- 只返回 highlights 数组
- highlightText 必须严格等于原字幕文本切片结果`;
}

export function buildSubtitleHighlightUserMessage(entries: SrtEntry[]) {
    const lines = entries.map((entry) => {
        return `entryIndex=${entry.index} | startMs=${entry.startMs} | endMs=${entry.endMs} | text=${entry.text}`;
    });
    return `请根据以下字幕和上下文，为每条字幕判断是否需要高亮，并返回 JSON：

{
  "highlights": [
    {
      "entryIndex": 1,
      "shouldHighlight": true,
      "highlightText": "示例",
      "start": 0,
      "end": 2
    }
  ]
}

字幕列表：
${lines.join("\n")}`;
}
