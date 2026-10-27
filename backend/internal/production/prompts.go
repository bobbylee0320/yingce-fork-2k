// Package production 承载短剧自动制作的纯逻辑：提示词编译、模型输出解析、
// 时长对齐和角色归并。它不访问数据库、不调用模型，便于独立测试；
// 调度与持久化由 internal/app 的组合根完成。
package production

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Chapter 是小说原文的一章，只作为改编来源。
type Chapter struct {
	ID    string
	Index int
	Title string
	Text  string
}

// Settings 是作品级制作意图；模型与审阅模式由服务端解析为具体执行参数。
type Settings struct {
	AspectRatio    string `json:"aspectRatio"`
	EpisodeSeconds int    `json:"episodeSeconds"`
	StylePrompt    string `json:"stylePrompt"`
	StyleName      string `json:"styleName"`
	Language       string `json:"language"`
	// Assets 是角色/场景参考图方案与约束提示词，开工前选定，之后可在设置里修改。
	Assets AssetSettings `json:"assets"`
	// Storyboard 是分镜规则：镜头时长、节奏与转场。
	Storyboard StoryboardSettings `json:"storyboard"`
}

// MaxEpisodeSeconds 是单集时长上限（20 分钟）；更长的内容应拆成多集。
const MaxEpisodeSeconds = 1200

func (s Settings) Normalized() Settings {
	s.Assets = s.Assets.Normalized()
	s.Storyboard = s.Storyboard.Normalized()
	if s.AspectRatio == "" {
		s.AspectRatio = "9:16"
	}
	if s.EpisodeSeconds <= 0 {
		s.EpisodeSeconds = 90
	}
	if s.EpisodeSeconds < 30 {
		s.EpisodeSeconds = 30
	}
	if s.EpisodeSeconds > MaxEpisodeSeconds {
		s.EpisodeSeconds = MaxEpisodeSeconds
	}
	if s.Language == "" {
		s.Language = "中文普通话"
	}
	// 风格基线会拼进每一次生图提示词，过长会挤占镜头本身的描述。
	s.StylePrompt = truncateRunes(strings.TrimSpace(s.StylePrompt), 1200)
	s.StyleName = truncateRunes(strings.TrimSpace(s.StyleName), 60)
	s.Language = truncateRunes(strings.TrimSpace(s.Language), 30)
	switch s.AspectRatio {
	case "9:16", "16:9", "1:1", "3:4", "4:3":
	default:
		s.AspectRatio = "9:16"
	}
	return s
}

const jsonOnly = "只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。"

// BibleSystemPrompt 约束全书设定建档的输出结构。
func BibleSystemPrompt() string {
	return "你是资深短剧总编剧与美术指导。你阅读网络小说，为改编竖屏短剧建立“作品圣经”。" + jsonOnly
}

// BiblePrompt 基于抽样后的全书文本建立角色、场景与整体风格。
func BiblePrompt(title string, settings Settings, chapters []Chapter, maxChars int) string {
	settings = settings.Normalized()
	var b strings.Builder
	fmt.Fprintf(&b, "作品：%s\n画幅：%s\n视觉风格：%s\n对白语言：%s\n章节总数：%d\n\n", title, settings.AspectRatio, firstNonEmpty(settings.StylePrompt, "写实电影感"), settings.Language, len(chapters))
	b.WriteString("请输出：\n")
	b.WriteString(`{"logline":"一句话卖点","tone":"整体基调","visualRules":"统一的画面规则（色调/光线/服化道年代）",` +
		`"characters":[{"name":"标准名","aliases":["别名/称呼"],"role":"主角/反派/配角","gender":"男/女","age":"年龄段",` +
		`"description":"性格与身份","appearance":"可直接用于生图的外貌、发型、服装描述（中文，40-80字）","voice":"音色、语速与说话方式"}],` +
		`"props":[{"name":"道具名","description":"用途与归属","appearance":"可直接用于生图的外形、材质、颜色描述"}],` +
		`"scenes":[{"name":"场景名","description":"用途","appearance":"可直接用于生图的环境描述"}]}` + "\n")
	b.WriteString("要求：角色按重要性排序，最多 24 个，只保留会在镜头中出现的人物；同一人物的不同称呼必须合并到 aliases；道具最多 20 个，只保留反复出现或推动剧情的关键物件；场景最多 16 个，只保留反复出现的地点。\n\n")
	b.WriteString("【小说原文抽样】\n")
	b.WriteString(SampleNovel(chapters, maxChars))
	return b.String()
}

// SampleNovel 把长篇小说压缩到预算内：前段完整保留（人物多在开篇登场），
// 其余章节按均匀间隔截取开头，保证后期新角色和地点也能被看到。
func SampleNovel(chapters []Chapter, maxChars int) string {
	if maxChars <= 0 {
		maxChars = 40000
	}
	headBudget := maxChars * 3 / 4
	var b strings.Builder
	used := 0
	next := 0
	for ; next < len(chapters) && used < headBudget; next++ {
		chunk := "## " + chapters[next].Title + "\n" + chapters[next].Text + "\n\n"
		if remaining := headBudget - used; utf8.RuneCountInString(chunk) > remaining {
			chunk = truncateRunes(chunk, remaining) + "\n\n"
		}
		b.WriteString(chunk)
		used += utf8.RuneCountInString(chunk)
	}
	rest := chapters[next:]
	if len(rest) == 0 {
		return b.String()
	}
	tailBudget := maxChars - used
	samples := 12
	if len(rest) < samples {
		samples = len(rest)
	}
	per := tailBudget / samples
	if per < 200 {
		return b.String()
	}
	for i := 0; i < samples; i++ {
		chapter := rest[i*len(rest)/samples]
		b.WriteString("## " + chapter.Title + "（节选）\n" + truncateRunes(chapter.Text, per) + "\n\n")
	}
	return b.String()
}

func PlanSystemPrompt() string {
	return "你是竖屏短剧分集编剧。你把小说章节改编为节奏紧凑的分集大纲：每集开场 3 秒有钩子，结尾停在悬念。" + jsonOnly
}

// PlanPrompt 规划一批章节对应的分集；章节与集是多对多关系。
func PlanPrompt(title string, settings Settings, bibleSummary string, batch []Chapter, nextEpisode int, previousCliffhanger string) string {
	settings = settings.Normalized()
	var b strings.Builder
	fmt.Fprintf(&b, "作品：%s\n单集时长：约 %d 秒\n下一集编号：%d\n", title, settings.EpisodeSeconds, nextEpisode)
	if previousCliffhanger != "" {
		fmt.Fprintf(&b, "上一集结尾悬念：%s\n", previousCliffhanger)
	}
	b.WriteString("\n【作品圣经摘要】\n" + bibleSummary + "\n\n")
	b.WriteString("请把下面的章节改编为若干集，输出：\n")
	b.WriteString(`{"episodes":[{"title":"集标题（6-12字）","chapters":[章节序号],"synopsis":"本集剧情（80-150字）","hook":"开场钩子","cliffhanger":"结尾悬念"}]}` + "\n")
	b.WriteString("规则：信息密度高的一章可拆成两集；过渡性章节与相邻章节合并；chapters 使用下方方括号里的章节序号；只覆盖本批章节，不要编造后续剧情。\n\n")
	for _, chapter := range batch {
		fmt.Fprintf(&b, "[%d] %s\n%s\n\n", chapter.Index, chapter.Title, truncateRunes(chapter.Text, 6000))
	}
	return b.String()
}

func ScriptSystemPrompt() string {
	return "你是竖屏短剧导演兼分镜师。你把单集大纲和原文拆成可直接写成视频提示词的镜头表。只保留镜头能拍到的动作和能说出口的台词，内心独白改为可见反应或台词。" + jsonOnly
}

type ScriptContext struct {
	Title         string
	Settings      Settings
	VisualRules   string
	EpisodeNumber int
	EpisodeTitle  string
	Synopsis      string
	Hook          string
	Cliffhanger   string
	CastSummary   string
	PropSummary   string
	// Segment 是剧情段切分约束，由分镜规则与视频模型单次上限共同决定。
	Segment        SegmentLimits
	SceneSummary   string
	SourceChapters []Chapter
}

func ScriptPrompt(ctx ScriptContext) string {
	settings := ctx.Settings.Normalized()
	shotTarget := settings.Storyboard.ShotTarget(settings.EpisodeSeconds)
	var b strings.Builder
	fmt.Fprintf(&b, "作品：%s\n第 %d 集《%s》\n画幅：%s · 单集约 %d 秒 · 对白语言：%s\n视觉风格：%s\n画面规则：%s\n\n", ctx.Title, ctx.EpisodeNumber, ctx.EpisodeTitle, settings.AspectRatio, settings.EpisodeSeconds, settings.Language, firstNonEmpty(settings.StylePrompt, "写实电影感"), firstNonEmpty(ctx.VisualRules, "保持全剧统一"))
	fmt.Fprintf(&b, "本集大纲：%s\n开场钩子：%s\n结尾悬念：%s\n\n", ctx.Synopsis, ctx.Hook, ctx.Cliffhanger)
	b.WriteString("【角色表】（name 必须从这里选；新出现的人物用其原文称呼）\n" + firstNonEmpty(ctx.CastSummary, "无") + "\n")
	b.WriteString("【道具表】（props 从这里选；新出现的关键道具用原文称呼）\n" + firstNonEmpty(ctx.PropSummary, "无") + "\n")
	b.WriteString("【场景表】\n" + firstNonEmpty(ctx.SceneSummary, "无") + "\n\n")
	fmt.Fprintf(&b, "输出约 %d 个镜头：\n", shotTarget)
	b.WriteString(`{"shots":[{"scene":"场景名","characters":["出镜角色名"],"props":["画面中出现的关键道具名"],"speaker":"说话人（旁白写“旁白”，无台词留空）",` +
		fmt.Sprintf(`"dialogue":"一句台词（4–%d 字，无则空）","action":"画面里发生的动作","shotSize":"特写/近景/中景/全景/远景",`, settings.Storyboard.MaxLineRunes()) +
		`"camera":"固定/推/拉/摇/跟/环绕","durationSeconds":4,"transition":"cut/fadeblack/fadewhite","imagePrompt":"本镜起幅画面：人物站位与朝向、动作、表情、构图、光线、环境",` +
		`"videoPrompt":"本镜头时长内的动作与镜头运动描述，按时间顺序写清起止","sourceQuote":"对应原文的一小句"}]}` + "\n")
	b.WriteString(settings.Storyboard.PromptRules(settings.EpisodeSeconds, ctx.Segment))
	b.WriteString("规则：第一个镜头就是钩子；每个镜头最多一句台词，对话用正反打拆成多个短镜；imagePrompt 中用角色名、道具名指代，不要重复外貌描述；最后一个镜头停在悬念。\n\n")
	b.WriteString("【对应原文】\n")
	for _, chapter := range ctx.SourceChapters {
		b.WriteString("## " + chapter.Title + "\n" + truncateRunes(chapter.Text, 12000) + "\n\n")
	}
	return b.String()
}

// CastImagePrompt 按作品的参考图方案渲染角色或场景参考图提示词，作为后续镜头的身份锚点。
func CastImagePrompt(assets AssetSettings, kind, name, appearance, stylePrompt, visualRules string) string {
	assets = assets.Normalized()
	style := firstNonEmpty(stylePrompt, "写实电影感")
	if kind == "prop" {
		return renderAssetTemplate(propPrompt, map[string]string{"道具名称": name, "道具设定": appearance, "项目画风": style, "画面规则": visualRules})
	}
	if kind == "scene" {
		return renderAssetTemplate(assets.ScenePrompt, map[string]string{"场景名称": name, "场景设定": appearance, "项目画风": style, "画面规则": visualRules})
	}
	return renderAssetTemplate(assets.CharacterPrompt, map[string]string{"角色名称": name, "角色设定": appearance, "项目画风": style, "画面规则": visualRules})
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
