package workbench

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"github.com/google/uuid"
)

// This resource-free snapshot comes from scripts/workbench-catalog-seed.ts.
// Keep keys stable; display text and ordering are not part of record identity.
//
//go:embed seed/catalog.json
var builtinCatalogJSON []byte

type builtinToolSeed struct {
	Key        string `json:"key"`
	Kind       string `json:"kind"`
	CategoryID string `json:"categoryId"`
	Name       string `json:"name"`
	Focus      string `json:"focus"`
	InputOne   string `json:"inputOne"`
	InputTwo   string `json:"inputTwo"`
}

// EnsureBuiltinCatalog seeds missing records without changing administrator
// edits, versions, timestamps, or publication state of existing records.
func (s *Service) EnsureBuiltinCatalog() error {
	tools, presets, err := builtinCatalog()
	if err != nil {
		return fmt.Errorf("prepare builtin workbench catalog: %w", err)
	}
	return s.repo.Transaction(func(repo *repository.Repository) error {
		for index := range tools {
			if err := repo.CreateWorkbenchToolIfMissing(&tools[index]); err != nil {
				return fmt.Errorf("seed workbench tool %s: %w", tools[index].ID, err)
			}
		}
		for index := range presets {
			if err := repo.CreateWorkbenchPresetIfMissing(&presets[index]); err != nil {
				return fmt.Errorf("seed workbench preset %s: %w", presets[index].ID, err)
			}
		}
		return nil
	})
}

func builtinCatalog() ([]model.WorkbenchTool, []model.WorkbenchPreset, error) {
	var entries []builtinToolSeed
	if err := json.Unmarshal(builtinCatalogJSON, &entries); err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, fmt.Errorf("empty catalog")
	}
	tools := make([]model.WorkbenchTool, 0, len(entries))
	presets := make([]model.WorkbenchPreset, 0, len(entries)*3)
	seen := map[string]bool{}
	now := time.Now().UTC()
	for index, entry := range entries {
		if entry.Key == "" || seen[entry.Key] || strings.TrimSpace(entry.Focus) == "" || strings.TrimSpace(entry.InputOne) == "" {
			return nil, nil, fmt.Errorf("invalid or duplicate catalog key %q", entry.Key)
		}
		seen[entry.Key] = true
		capability, guide, err := builtinToolConfig(entry, index)
		if err != nil {
			return nil, nil, err
		}
		tool, err := normalizeTool(ToolInput{
			Kind: entry.Kind, CategoryID: entry.CategoryID, Name: entry.Name, Subtitle: entry.Focus,
			Description: entry.Focus + "。具体画幅、时长与参考素材支持以所选模型能力为准，生成细节需人工验收。",
			SortOrder:   1000 + index*10, Capability: capability, Guide: guide, Enabled: true,
		})
		if err != nil {
			return nil, nil, fmt.Errorf("tool %s: %w", entry.Key, err)
		}
		tool.ID = builtinCatalogID("tool/" + entry.Key)
		tool.Version, tool.CreatedAt, tool.UpdatedAt = 1, now, now
		tools = append(tools, *tool)
		for _, variant := range builtinPromptVariants(entry) {
			preset, err := normalizePreset(PresetInput{ToolID: tool.ID, Name: variant.name, Summary: variant.summary, PromptTemplate: variant.prompt, SortOrder: variant.order, Enabled: true})
			if err != nil {
				return nil, nil, fmt.Errorf("preset %s/%s: %w", entry.Key, variant.key, err)
			}
			preset.ID = builtinCatalogID("preset/" + entry.Key + "/" + variant.key)
			preset.Version, preset.CreatedAt, preset.UpdatedAt = 1, now, now
			presets = append(presets, *preset)
		}
	}
	return tools, presets, nil
}

func builtinCatalogID(key string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("yingce/workbench/"+key)).String()
}

func builtinToolConfig(entry builtinToolSeed, index int) (json.RawMessage, json.RawMessage, error) {
	contract := InputContract{PromptRequired: true, Slots: []ReferenceSlot{}}
	for i, name := range []string{entry.InputOne, entry.InputTwo} {
		if name == "" || builtinTextInput(name) {
			continue // Script/shot descriptions belong in the prompt, not an image upload slot.
		}
		key, minCount := "reference-main", 1
		if i == 1 {
			key, minCount = "reference-support", 0
		}
		mediaType := KindImage
		if strings.Contains(name, "视频") {
			mediaType = KindVideo
		}
		contract.Slots = append(contract.Slots, ReferenceSlot{Key: key, Name: name, MediaTypes: []string{mediaType}, ResourceKind: "asset", MinCount: minCount, MaxCount: 4, Required: i == 0})
	}
	capability, err := json.Marshal(map[string]any{
		"supportedModes": []string{entry.Kind}, "searchKeywords": []string{entry.Name, entry.CategoryID, entry.Focus},
		"surfaces": []string{"workbench"}, "recommended": index < 12 || entry.Key == "product-hero-motion", "recommendationOrder": index + 1,
		"inputContract": contract,
	})
	if err != nil {
		return nil, nil, err
	}
	inputs := entry.InputOne
	if entry.InputTwo != "" {
		inputs += "；可补充" + entry.InputTwo
	}
	guide, err := json.Marshal(map[string]any{
		"inputHint": inputs + "。" + entry.Focus,
		"lines": []string{
			"准备：提供" + inputs + "。文字描述填写在提示词中，图像或视频作为参考素材上传。",
			"生成：" + entry.Focus + "。每次只改一个变量；涉及同一商品、角色或场景时，复用相同参考与身份锚点。",
			"验收：检查主体轮廓、颜色、服装、道具、比例、视线、空间轴线与光影连续性；未确认的规格、卖点和文字留给后期核实。",
		},
	})
	return capability, guide, err
}

func builtinTextInput(name string) bool {
	switch name {
	case "剧本/分镜文字", "镜头描述", "剧本片段", "分镜脚本", "角色/音色说明":
		return true
	default:
		return false
	}
}

type builtinPromptVariant struct {
	key, name, summary, prompt string
	order                      int
}

func builtinPromptVariants(entry builtinToolSeed) []builtinPromptVariant {
	if entry.Kind == KindVideo {
		prompt := "单镜头短片，" + entry.Focus + "。" + entry.InputOne + "决定主体身份与首帧构图；若有第二参考，只用于对应动作或风格。按“起始状态→一个清晰动作→稳定结束状态”连续演完，镜头运动克制且明确，主体脸、服装、商品结构、道具手别、空间轴线与光源方向全程一致。动作幅度真实，背景不跳变，不新增人物、物件或文字，不发生形变、闪烁或瞬移；结尾停留约1秒，便于剪辑。"
		return []builtinPromptVariant{
			{"standard", "标准单镜头", "一个主体动作 + 一种机位运动 + 稳定尾帧", prompt, 0},
			{"emotion", "情绪强化", "增强表演节奏与光线，不增加动作", prompt + " 情绪方向：从克制开始，在动作完成时出现清楚但不过度的情绪变化；使用单一色温与柔和层次光，避免快速剪切。", 1},
			{"continuity", "干净产品/连续性版", "优先保真与稳定，降低背景运动", prompt + " 保真优先：镜头固定或极慢推进，背景保持静止，主体占画面主要区域，所有标签、服装和道具细节清晰可核对。", 2},
		}
	}
	anchor := "以参考图1为主体外观与身份的唯一依据，"
	if builtinTextInput(entry.InputOne) {
		anchor = "以提供的" + entry.InputOne + "和角色、场景设定为依据，"
	}
	prompt := anchor + entry.Focus + "。保持主体结构、颜色、比例、材质和可见细节稳定；辅助参考仅用于其对应的场景、姿态或风格，不得覆盖主体特征。采用清晰的主体层级、可信透视、自然光影与真实接触关系。画面不生成文字、价格、水印、虚构品牌或未提供的产品信息；输出干净、可用于商业创作的视觉画面。"
	return []builtinPromptVariant{
		{"standard", "标准主视觉", "主体保真，按核心用途生成", prompt, 0},
		{"composition", "构图变化", "锁定主体，只调整机位和留白", prompt + " 构图变体：采用轻微三分法机位，将主体放在画面一侧，另一侧留出干净负空间；主体仍完整可辨，画面层次简洁。", 1},
		{"detail", "细节优先", "适合材质、五金、表情与连续性检查", prompt + " 细节版：镜头略近，优先表现真实纹理、边缘、手部与面部自然结构及接触阴影；不锐化出虚假纹理，不改变主体身份。", 2},
	}
}
