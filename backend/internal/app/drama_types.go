package app

import (
	"encoding/json"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

// DramaModelChoice 是一条可在服务端独立执行的模型选择：逻辑模型或系统渠道模型二选一。
// 自定义渠道的密钥只存在浏览器，无法驱动无人值守的流水线，因此不在这里出现。
type DramaModelChoice struct {
	LogicalModelID string `json:"logicalModelId,omitempty"`
	ChannelID      string `json:"channelId,omitempty"`
	ModelKey       string `json:"modelKey,omitempty"`
	Label          string `json:"label,omitempty"`
	PriceLabel     string `json:"priceLabel,omitempty"`
}

func (c DramaModelChoice) Empty() bool {
	return strings.TrimSpace(c.LogicalModelID) == "" && (strings.TrimSpace(c.ChannelID) == "" || strings.TrimSpace(c.ModelKey) == "")
}

// DramaModels 是制作用到的三类模型：文本（改编、分镜、视频提示词）、图片（角色/道具/场景参考图）、
// 视频（按剧情段生成带对白与音效的视频）。
type DramaModels struct {
	Text  DramaModelChoice `json:"text"`
	Image DramaModelChoice `json:"image"`
	Video DramaModelChoice `json:"video"`
}

func (m DramaModels) choice(capability string) DramaModelChoice {
	switch capability {
	case "text":
		return m.Text
	case "image":
		return m.Image
	case "video":
		return m.Video
	}
	return DramaModelChoice{}
}

// 生成节奏：manual 先只跑文本（作品圣经、分集、剧本、分镜与视频提示词），用户确认后再生成参考图与视频；
// auto 一路跑到成片。
const (
	DramaMediaManual = "manual"
	DramaMediaAuto   = "auto"
)

// 审阅方式：sample 先完整做出第 1 集样片，确认后其余集才生成视频；every 每集生成视频前确认视频提示词；auto 不打断。
const (
	DramaReviewSample = "sample"
	DramaReviewEvery  = "every"
	DramaReviewAuto   = "auto"
)

// DramaSkillRef 指向用户技能库里的一个技能文件，用作剧情段视频提示词的写作方法。
type DramaSkillRef struct {
	SkillID   string `json:"skillId"`
	SkillName string `json:"skillName"`
	Path      string `json:"path"`
}

type DramaSettings struct {
	production.Settings
	// PromptSkill 为空时按内置格式撰写段视频提示词。
	PromptSkill *DramaSkillRef `json:"promptSkill,omitempty"`
	ReviewMode  string         `json:"reviewMode"`
	MediaMode   string         `json:"mediaMode"`
	Concurrency int            `json:"concurrency"`
	Models      DramaModels    `json:"models"`
}

func (s DramaSettings) normalized() DramaSettings {
	s.Settings = s.Settings.Normalized()
	switch s.ReviewMode {
	case DramaReviewSample, DramaReviewEvery, DramaReviewAuto:
	default:
		s.ReviewMode = DramaReviewSample
	}
	if s.MediaMode != DramaMediaManual {
		// 早于该设置创建的作品一直是全自动，保持原行为；新建作品由 CreateDrama 默认 manual。
		s.MediaMode = DramaMediaAuto
	}
	if s.PromptSkill != nil {
		ref := DramaSkillRef{SkillID: truncateRunes(strings.TrimSpace(s.PromptSkill.SkillID), 64), SkillName: truncateRunes(strings.TrimSpace(s.PromptSkill.SkillName), 120), Path: truncateRunes(strings.TrimSpace(s.PromptSkill.Path), 300)}
		s.PromptSkill = nil
		if ref.SkillID != "" {
			if ref.Path == "" {
				ref.Path = "SKILL.md"
			}
			s.PromptSkill = &ref
		}
	}
	if s.Concurrency <= 0 {
		s.Concurrency = 4
	}
	if s.Concurrency > 16 {
		s.Concurrency = 16
	}
	return s
}

func parseDramaSettings(raw string) DramaSettings {
	var settings DramaSettings
	_ = json.Unmarshal([]byte(raw), &settings)
	return settings.normalized()
}

func encodeDramaSettings(settings DramaSettings) string {
	encoded, _ := json.Marshal(settings.normalized())
	return string(encoded)
}

type dramaBibleMeta struct {
	Logline     string `json:"logline"`
	Tone        string `json:"tone"`
	VisualRules string `json:"visualRules"`
}

func parseDramaBibleMeta(raw string) dramaBibleMeta {
	var meta dramaBibleMeta
	_ = json.Unmarshal([]byte(raw), &meta)
	return meta
}

type DramaChapterInput struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

type CreateDramaRequest struct {
	Name               string              `json:"name"`
	Chapters           []DramaChapterInput `json:"chapters"`
	Settings           DramaSettings       `json:"settings"`
	BudgetMicrocredits int64               `json:"budgetMicrocredits"`
	Start              bool                `json:"start"`
}

type UpdateDramaSettingsRequest struct {
	Settings           *DramaSettings `json:"settings"`
	BudgetMicrocredits *int64         `json:"budgetMicrocredits"`
}

type DramaProductionView struct {
	Status             string        `json:"status"`
	Stage              string        `json:"stage"`
	PauseReason        string        `json:"pauseReason"`
	Settings           DramaSettings `json:"settings"`
	BudgetMicrocredits int64         `json:"budgetMicrocredits"`
	SpentMicrocredits  int64         `json:"spentMicrocredits"`
	PlanDone           bool          `json:"planDone"`
	PlanCursor         int           `json:"planCursor"`
	SampleApproved     bool          `json:"sampleApproved"`
	AssetsReleased     bool          `json:"assetsReleased"`
	Logline            string        `json:"logline"`
	Tone               string        `json:"tone"`
	ChapterCount       int           `json:"chapterCount"`
	WordCount          int           `json:"wordCount"`
}

// DramaEpisodeStats 按剧情段统计进度：视频提示词写好几段、视频生成几段、失败几段。
type DramaEpisodeStats struct {
	Segments    int64 `json:"segments"`
	PromptReady int64 `json:"promptReady"`
	VideoReady  int64 `json:"videoReady"`
	Failed      int64 `json:"failed"`
}

type DramaEpisodeRow struct {
	ID              string            `json:"id"`
	Number          int               `json:"number"`
	Title           string            `json:"title"`
	Synopsis        string            `json:"synopsis"`
	Stage           string            `json:"stage"`
	Error           string            `json:"error"`
	ShotCount       int               `json:"shotCount"`
	DurationMs      int64             `json:"durationMs"`
	Approved        bool              `json:"approved"`
	MediaReleased   bool              `json:"mediaReleased"`
	AwaitingMedia   bool              `json:"awaitingMedia"`
	FinalResourceID string            `json:"finalResourceId,omitempty"`
	FinalStale      bool              `json:"finalStale"`
	Stats           DramaEpisodeStats `json:"stats"`
}

type DramaInboxItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Severity  string `json:"severity"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	EpisodeID string `json:"episodeId,omitempty"`
	CastID    string `json:"castId,omitempty"`
	// 以下字段供前端把同类问题折叠成组：角色/道具/场景、所在集、段号与失败环节（prompt 提示词 / video 视频）。
	CastKind      string `json:"castKind,omitempty"`
	EpisodeNumber int    `json:"episodeNumber,omitempty"`
	SegmentIndex  int    `json:"segmentIndex"`
	Media         string `json:"media,omitempty"`
}

type DramaJobView struct {
	ID               string `json:"id"`
	Kind             string `json:"kind"`
	Status           string `json:"status"`
	Label            string `json:"label"`
	Error            string `json:"error,omitempty"`
	EpisodeID        string `json:"episodeId,omitempty"`
	ShotID           string `json:"shotId,omitempty"`
	TaskID           string `json:"taskId,omitempty"`
	CostMicrocredits int64  `json:"costMicrocredits"`
	Attempt          int    `json:"attempt"`
	CreatedAt        string `json:"createdAt"`
	StartedAt        string `json:"startedAt,omitempty"`
	FinishedAt       string `json:"finishedAt,omitempty"`
	UpdatedAt        string `json:"updatedAt"`
}

// DramaJobAttempt 是工作的一次提交记录；status 为任务状态，或 rejected（提交时被准入拒绝）。
type DramaJobAttempt struct {
	TaskID           string `json:"taskId,omitempty"`
	Status           string `json:"status"`
	Error            string `json:"error,omitempty"`
	CostMicrocredits int64  `json:"costMicrocredits"`
	At               string `json:"at"`
}

// DramaJobTaskView 是队列详情里展示的任务快照：只暴露请求参数白名单，不回显渠道配置。
type DramaJobTaskView struct {
	ID          string            `json:"id"`
	Status      string            `json:"status"`
	Stage       string            `json:"stage,omitempty"`
	Operation   string            `json:"operation,omitempty"`
	Model       string            `json:"model"`
	ModelLabel  string            `json:"modelLabel"`
	Prompt      string            `json:"prompt"`
	Params      map[string]string `json:"params"`
	Error       string            `json:"error,omitempty"`
	MediaStage  string            `json:"mediaStage,omitempty"`
	CreatedAt   string            `json:"createdAt"`
	StartedAt   string            `json:"startedAt,omitempty"`
	CompletedAt string            `json:"completedAt,omitempty"`
	ResultMode  string            `json:"resultMode,omitempty"`
	ResultText  string            `json:"resultText,omitempty"`
	ResourceIDs []string          `json:"resourceIds,omitempty"`
}

type DramaJobAttemptView struct {
	DramaJobAttempt
	Task *DramaJobTaskView `json:"task,omitempty"`
}

type DramaJobDetail struct {
	Job      DramaJobView          `json:"job"`
	Target   string                `json:"target"`
	Attempts []DramaJobAttemptView `json:"attempts"`
}

type DramaSummary struct {
	Project    model.Project       `json:"project"`
	Production DramaProductionView `json:"production"`
	Episodes   []DramaEpisodeRow   `json:"episodes"`
	JobCounts  map[string]int64    `json:"jobCounts"`
	Inbox      []DramaInboxItem    `json:"inbox"`
	CastCount  int                 `json:"castCount"`
}

type DramaChapterRef struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Position  int    `json:"position"`
	WordCount int    `json:"wordCount"`
}

type DramaEpisodeDetail struct {
	Episode  model.DramaEpisode `json:"episode"`
	Shots    []model.DramaShot  `json:"shots"`
	Segments []DramaSegmentView `json:"segments"`
	Chapters []DramaChapterRef  `json:"chapters"`
	Jobs     []DramaJobView     `json:"jobs"`
	// ScriptJob 是本集最近一次改编剧本的调度工作，可查看改编提示词与模型返回。
	ScriptJob *DramaJobView `json:"scriptJob,omitempty"`
}

// DramaSegmentView 是一个剧情段：视频提示词、参考图、生成方式与视频结果。
type DramaSegmentView struct {
	ID         string   `json:"id"`
	Index      int      `json:"index"`
	Title      string   `json:"title"`
	ShotIDs    []string `json:"shotIds"`
	DurationMs int64    `json:"durationMs"`
	// VideoPrompt 为生效内容：手动改写优先，其次是模型撰写的 Generated。
	VideoPrompt string `json:"videoPrompt"`
	Generated   string `json:"generated"`
	Custom      bool   `json:"custom"`
	// PromptStatus：none 无记录、queued 待撰写、running 撰写中、ready 完成、stale 镜头已改动、failed 失败。
	PromptStatus string `json:"promptStatus"`
	PromptError  string `json:"promptError,omitempty"`
	// VideoStatus：空串待生成、running、ready、stale（提示词或上一段已变）、failed。
	VideoStatus         string `json:"videoStatus"`
	VideoResourceID     string `json:"videoResourceId,omitempty"`
	TailFrameResourceID string `json:"tailFrameResourceId,omitempty"`
	VideoError          string `json:"videoError,omitempty"`
	// VideoReprocessable：视频已生成并入库，只是结果回写（如抽尾帧）失败；可重新处理已有视频，不重新生成。
	VideoReprocessable bool             `json:"videoReprocessable,omitempty"`
	VideoModel         DramaModelChoice `json:"videoModel"`
	// Request 是生成本段视频时实际会发送的内容：生成方式、首帧、参考图、秒数与追加在提示词前的参考图说明。
	Request   DramaSegmentRequest `json:"request"`
	PromptJob *DramaJobView       `json:"promptJob,omitempty"`
	VideoJob  *DramaJobView       `json:"videoJob,omitempty"`
	// VideoWait 只在视频已请求（queued）但尚未提交时出现：调度实际卡住的原因，例如等待上一段或参考图。
	VideoWait string `json:"videoWait,omitempty"`
}

// DramaSegmentRequest 是一段视频请求的预演，与提交时同一函数计算。
type DramaSegmentRequest struct {
	// Operation：image_to_video（上一段最后一帧作首帧）、reference_to_video（参考图）、text_to_video。
	Operation       string `json:"operation"`
	Seconds         int    `json:"seconds"`
	MaxVideoSeconds int    `json:"maxVideoSeconds"`
	// FirstFrame 是上一段视频的最后一帧；第一段为空。FirstFramePending 表示上一段还没生成，生成后才能提交本段。
	FirstFrameResourceID string                  `json:"firstFrameResourceId,omitempty"`
	FirstFramePending    bool                    `json:"firstFramePending"`
	References           []DramaSegmentReference `json:"references"`
	// Header 是提交时放在提示词最前面的参考图对应说明，让模型知道每张图是谁。
	Header string `json:"header"`
	// Warning 说明请求的限制，例如模型不支持参考图、参考图超出模型上限。
	Warning string `json:"warning,omitempty"`
}

type DramaSegmentReference struct {
	ResourceID string `json:"resourceId,omitempty"`
	CastID     string `json:"castId"`
	Label      string `json:"label"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	// Sent 表示这张参考图会随请求发送；未生成或超过模型参考图上限时为 false。
	Sent bool `json:"sent"`
}

type UpdateDramaSegmentRequest struct {
	// VideoPromptOverride 传空串表示恢复模型撰写的版本。
	VideoPromptOverride *string `json:"videoPromptOverride"`
}

// UpdateDramaShotRequest 修改镜头的剧本内容；镜头只是撰写视频提示词的素材，修改后本段提示词标记过期。
type UpdateDramaShotRequest struct {
	Speaker     *string `json:"speaker"`
	Dialogue    *string `json:"dialogue"`
	Action      *string `json:"action"`
	ShotSize    *string `json:"shotSize"`
	Camera      *string `json:"camera"`
	ImagePrompt *string `json:"imagePrompt"`
	VideoPrompt *string `json:"videoPrompt"`
	// Transition 是进入本镜头的转场；DurationSeconds 手动设置镜头时长。
	Transition      *string  `json:"transition"`
	DurationSeconds *float64 `json:"durationSeconds"`
}

type UpdateDramaCastRequest struct {
	Name              *string   `json:"name"`
	Aliases           *[]string `json:"aliases"`
	Appearance        *string   `json:"appearance"`
	Description       *string   `json:"description"`
	VoiceInstructions *string   `json:"voiceInstructions"`
	Locked            *bool     `json:"locked"`
}

type DramaListItem struct {
	Project         model.Project `json:"project"`
	Status          string        `json:"status"`
	Stage           string        `json:"stage"`
	PauseReason     string        `json:"pauseReason"`
	EpisodeCount    int64         `json:"episodeCount"`
	DoneCount       int64         `json:"doneCount"`
	CoverResourceID string        `json:"coverResourceId,omitempty"`
	// CoverResourceIDs 是前几张角色参考图，卡片拼成封面；CoverResourceID 保留第一张。
	CoverResourceIDs  []string `json:"coverResourceIds,omitempty"`
	AspectRatio       string   `json:"aspectRatio"`
	StyleName         string   `json:"styleName,omitempty"`
	SpentMicrocredits int64    `json:"spentMicrocredits"`
	UpdatedAt         string   `json:"updatedAt"`
}

type DramaModelOption struct {
	Choice     DramaModelChoice `json:"choice"`
	Capability string           `json:"capability"`
	Label      string           `json:"label"`
	PriceLabel string           `json:"priceLabel"`
	// MaxVideoSeconds 仅视频模型：单次最长生成秒数，0 表示未声明。
	MaxVideoSeconds int `json:"maxVideoSeconds,omitempty"`
}

// DramaModelUnavailable 是平台目录里有、但短剧流水线无法使用的模型及原因，前端置灰展示而不是隐藏。
type DramaModelUnavailable struct {
	Choice DramaModelChoice `json:"choice"`
	Reason string           `json:"reason"`
}

type DramaModelCatalog struct {
	Defaults    DramaModels                        `json:"defaults"`
	Options     map[string][]DramaModelOption      `json:"options"`
	Unavailable map[string][]DramaModelUnavailable `json:"unavailable"`
}

type DramaEstimateRequest struct {
	ChapterCount int           `json:"chapterCount"`
	WordCount    int           `json:"wordCount"`
	Settings     DramaSettings `json:"settings"`
}

// DramaEstimate 的 Videos 是剧情段数（一段一次视频调用），Images 是参考图数。
type DramaEstimate struct {
	Episodes          int    `json:"episodes"`
	Shots             int    `json:"shots"`
	Images            int    `json:"images"`
	Videos            int    `json:"videos"`
	TextCalls         int    `json:"textCalls"`
	MinMicrocredits   int64  `json:"minMicrocredits"`
	MaxMicrocredits   int64  `json:"maxMicrocredits"`
	SampleMicrocredit int64  `json:"sampleMicrocredits"`
	Priced            bool   `json:"priced"`
	Note              string `json:"note"`
	DurationMinutes   int    `json:"durationMinutes"`
}

// ReleaseDramaMediaRequest 在手动模式下放行生成：assets 只放行参考图，episodes 放行指定集，all 放行全部。
type ReleaseDramaMediaRequest struct {
	Target     string   `json:"target"`
	EpisodeIDs []string `json:"episodeIds"`
}
