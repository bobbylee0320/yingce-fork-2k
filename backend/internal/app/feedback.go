package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"path/filepath"
	"strings"
	"time"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type SubmitFeedbackRequest struct {
	Type        model.FeedbackType `json:"type"`
	Title       string             `json:"title"`
	Content     string             `json:"content"`
	Attachments string             `json:"attachments"` // JSON string of []model.FeedbackAttachment
	Environment string             `json:"environment"` // JSON string
	Contact     string             `json:"contact"`
}

type AdminUpdateFeedbackRequest struct {
	Status     model.FeedbackStatus `json:"status"`
	AdminReply string               `json:"adminReply"`
	Archived   *bool                `json:"archived"`
}

type FeedbackListResult struct {
	List  []model.UserFeedback `json:"list"`
	Total int64                `json:"total"`
	Page  int                  `json:"page"`
	Limit int                  `json:"limit"`
}

func (s *Service) SubmitFeedback(actor *model.User, req SubmitFeedbackRequest) (*model.UserFeedback, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录后提交反馈")
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, kernel.BadAuthRequest("请填写反馈标题")
	}
	if len(title) > 200 {
		return nil, kernel.BadAuthRequest("反馈标题不能超过 200 个字")
	}

	content := strings.TrimSpace(req.Content)
	if content == "" {
		return nil, kernel.BadAuthRequest("请填写详细的反馈描述")
	}
	if len(content) > 10000 {
		return nil, kernel.BadAuthRequest("反馈内容不能超过 10000 个字")
	}

	fbType := req.Type
	switch fbType {
	case model.FeedbackTypeBug, model.FeedbackTypeFeature, model.FeedbackTypeImprovement, model.FeedbackTypeOther:
	default:
		fbType = model.FeedbackTypeBug
	}

	contact := strings.TrimSpace(req.Contact)
	if contact == "" {
		if actor.Email != "" {
			contact = actor.Email
		} else {
			contact = actor.Username
		}
	}

	attachments := strings.TrimSpace(req.Attachments)
	if attachments == "" {
		attachments = "[]"
	} else {
		// 校验 JSON 合法性
		var items []model.FeedbackAttachment
		if err := json.Unmarshal([]byte(attachments), &items); err != nil {
			attachments = "[]"
		}
	}

	env := strings.TrimSpace(req.Environment)
	if env == "" {
		env = "{}"
	}

	now := time.Now().UTC()
	feedback := &model.UserFeedback{
		ID:          "fb_" + kernel.NewID(),
		UserID:      actor.ID,
		UserName:    actor.Username,
		UserEmail:   actor.Email,
		Contact:     contact,
		Type:        fbType,
		Title:       title,
		Content:     content,
		Attachments: attachments,
		Environment: env,
		Status:      model.FeedbackStatusPending,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := s.repo.CreateFeedback(feedback); err != nil {
		return nil, fmt.Errorf("保存反馈失败：%w", err)
	}

	return feedback, nil
}

func (s *Service) MyFeedbacks(actor *model.User) ([]model.UserFeedback, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.ListFeedbacksByUser(actor.ID)
}

func (s *Service) UploadFeedbackAttachment(actor *model.User, header *multipart.FileHeader) (*model.FeedbackAttachment, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	if header == nil {
		return nil, kernel.BadAuthRequest("请选择要上传的附件")
	}

	// 限制单个附件最大 50MB
	const maxAttachmentBytes = 50 * 1024 * 1024
	if header.Size > maxAttachmentBytes {
		return nil, kernel.BadAuthRequest("附件大小不能超过 50MB")
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	var kind string
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp":
		kind = "image"
	case ".mp4", ".webm", ".mov", ".avi", ".mkv":
		kind = "video"
	default:
		return nil, kernel.BadAuthRequest("仅支持上传图片或视频格式文件作为附件")
	}

	resource, err := s.UploadResource(actor.ID, header, kind, 0, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("上传附件失败：%w", err)
	}

	fileURL := "/api/resources/" + resource.ID + "/file"
	return &model.FeedbackAttachment{
		ID:       resource.ID,
		Name:     header.Filename,
		Type:     kind,
		URL:      fileURL,
		Size:     header.Size,
		MimeType: resource.MimeType,
	}, nil
}

func (s *Service) AdminListFeedbacks(actor *model.User, filter repository.FeedbackFilter) (*FeedbackListResult, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}

	list, total, err := s.repo.ListAllFeedbacks(filter)
	if err != nil {
		return nil, fmt.Errorf("查询反馈列表失败：%w", err)
	}

	page := filter.Page
	if page < 1 {
		page = 1
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}

	return &FeedbackListResult{
		List:  list,
		Total: total,
		Page:  page,
		Limit: limit,
	}, nil
}

func (s *Service) AdminUpdateFeedback(actor *model.User, id string, req AdminUpdateFeedbackRequest) (*model.UserFeedback, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}

	fb, err := s.repo.GetFeedback(id)
	if err != nil {
		return nil, kernel.BadAuthRequest("反馈不存在或已被删除")
	}

	now := time.Now().UTC()
	if req.Status != "" {
		switch req.Status {
		case model.FeedbackStatusPending, model.FeedbackStatusProcessing, model.FeedbackStatusResolved, model.FeedbackStatusClosed:
			fb.Status = req.Status
		}
	}

	if req.AdminReply != "" || req.Status == model.FeedbackStatusResolved || req.Status == model.FeedbackStatusClosed {
		fb.AdminReply = req.AdminReply
		fb.RepliedAt = &now
	}

	if req.Archived != nil {
		fb.Archived = *req.Archived
		if fb.Archived {
			fb.ArchivedAt = &now
		} else {
			fb.ArchivedAt = nil
		}
	}

	fb.UpdatedAt = now

	if err := s.repo.UpdateFeedback(fb); err != nil {
		return nil, fmt.Errorf("更新反馈失败：%w", err)
	}

	return fb, nil
}

func (s *Service) AdminArchiveFeedback(actor *model.User, id string, archive bool) (*model.UserFeedback, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}

	fb, err := s.repo.GetFeedback(id)
	if err != nil {
		return nil, kernel.BadAuthRequest("反馈不存在或已被删除")
	}

	now := time.Now().UTC()
	fb.Archived = archive
	if archive {
		fb.ArchivedAt = &now
	} else {
		fb.ArchivedAt = nil
	}
	fb.UpdatedAt = now

	if err := s.repo.UpdateFeedback(fb); err != nil {
		return nil, fmt.Errorf("更新反馈归档状态失败：%w", err)
	}

	return fb, nil
}

func (s *Service) AdminDeleteFeedback(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	if strings.TrimSpace(id) == "" {
		return errors.New("缺少反馈ID")
	}
	return s.repo.DeleteFeedback(id)
}
