package app

import (
	"strings"
	"yingce/backend/internal/model"
	"yingce/backend/internal/tools"
)

type (
	ToolListRequest     = tools.ToolListRequest
	ToolList            = tools.ToolList
	ToolItem            = tools.ToolItem
	ToolSummary         = tools.ToolSummary
	ToolMutationRequest = tools.ToolMutationRequest
)

func (s *Service) toolDomain() *tools.Service {
	if s == nil {
		return tools.New(nil)
	}
	if s.tools != nil {
		return s.tools
	}
	return tools.New(s.repo)
}

func (s *Service) Tools(userID string, req ToolListRequest) (*ToolList, error) {
	return s.toolDomain().List(userID, req)
}

func (s *Service) ToolDetail(userID string, toolID int64) (*ToolItem, error) {
	return s.toolDomain().Detail(userID, toolID)
}

func (s *Service) SetToolFavorite(userID string, toolID int64, favorite bool) (*ToolItem, error) {
	return s.toolDomain().SetFavorite(userID, toolID, favorite)
}

func (s *Service) CreateTool(userID string, req ToolMutationRequest) (*ToolItem, error) {
	if err := s.validateToolPreviewResources(userID, req); err != nil {
		return nil, err
	}
	return s.toolDomain().Create(userID, req)
}

func (s *Service) UpdateTool(userID string, toolID int64, req ToolMutationRequest) (*ToolItem, error) {
	if err := s.validateToolPreviewResources(userID, req); err != nil {
		return nil, err
	}
	return s.toolDomain().Update(userID, toolID, req)
}

func (s *Service) validateToolPreviewResources(userID string, req ToolMutationRequest) error {
	if strings.TrimSpace(userID) == "" {
		return Unauthorized("请先登录")
	}
	values := append([]string{req.Cover, req.MediaURL}, req.ExtraInfo...)
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		id := resourceIDFromFileURL(value)
		if id == "" {
			return BadAuthRequest("工具预览仅支持本人上传的资源")
		}
		resource, err := s.repo.ResourceForUser(userID, id)
		if err != nil {
			return err
		}
		if resource.Status != model.ResourceStatusReady {
			return BadAuthRequest("预览资源尚未上传完成")
		}
		if req.Visibility == tools.ToolVisibilityPublic {
			return BadAuthRequest("公开工具暂不支持私人预览资源，请移除预览或改为私有")
		}
	}
	return nil
}

func (s *Service) DeleteTool(userID string, toolID int64) error {
	return s.toolDomain().Delete(userID, toolID)
}

// ResolveToolMentionTokens 将 prompt 中的 @[tool:type:ID:label:icon] 令牌替换为对应工具的提示词文本。
func (s *Service) ResolveToolMentionTokens(userID, mode, prompt string) (string, error) {
	return s.toolDomain().ResolveToolMentionTokens(userID, mode, prompt)
}

func (s *Service) EnsureBuiltinTools() error {
	return tools.EnsureBuiltinTools(s.repo)
}
