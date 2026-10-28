package app

import (
	"errors"
	"fmt"
	"strings"

	"yingce/backend/internal/model"
)

type TaskMediaUploadIntent struct {
	TaskID            string             `json:"taskId"`
	ResourceID        string             `json:"resourceId"`
	SourceURL         string             `json:"sourceUrl"`
	ObjectKey         string             `json:"objectKey"`
	UploadURL         string             `json:"uploadUrl,omitempty"`
	Headers           map[string]string  `json:"headers,omitempty"`
	MimeType          string             `json:"mimeType"`
	Size              int64              `json:"size"`
	ExpiresAt         string             `json:"expiresAt,omitempty"`
	Index             int                `json:"index"`
	MultipartUploadID string             `json:"multipartUploadId,omitempty"`
	Parts             []DirectUploadPart `json:"parts,omitempty"`
	PartSize          int64              `json:"partSize,omitempty"`
}

type TaskMediaUploadSource struct {
	Index     int    `json:"index"`
	SourceURL string `json:"sourceUrl"`
	MimeType  string `json:"mimeType,omitempty"`
}

func (s *Service) clientMediaUploadAvailable(userID string, checkpoint *mediaCheckpoint) bool {
	if checkpoint == nil || len(checkpoint.Items) == 0 {
		return false
	}
	for _, item := range checkpoint.Items {
		if strings.TrimSpace(item.Reference.URL) == "" || item.Reference.DataURL != "" {
			return false
		}
	}
	setting, _, enabled, err := s.activeResourceOSSSetting(userID)
	return err == nil && enabled && setting.Provider == "s3"
}

func (s *Service) TaskMediaUploadIntent(userID, taskID string, index int, fileName string, size int64, mimeType string, width, height int) (*TaskMediaUploadIntent, error) {
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task.MediaStage != "client_upload_pending" || task.MediaRecoveryJSON == "" {
		return nil, BadAuthRequest("任务当前没有待上传的生成作品")
	}
	checkpoint, err := s.decodeMediaCheckpoint(task)
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(checkpoint.Items) {
		return nil, BadAuthRequest("生成作品上传索引无效")
	}
	item := checkpoint.Items[index]
	sourceURL := strings.TrimSpace(item.Reference.URL)
	if sourceURL == "" {
		return nil, BadAuthRequest("上游结果地址已过期")
	}
	if _, err := ValidateOutboundURL(sourceURL); err != nil {
		return nil, BadAuthRequest("上游结果地址不可访问")
	}
	if size <= 0 {
		return nil, BadAuthRequest("上传文件大小无效")
	}
	if mimeType == "" {
		mimeType = firstNonEmpty(item.MIMEType, item.Reference.MIMEType)
	}
	if mimeType == "" {
		return nil, BadAuthRequest("上传文件类型无效")
	}
	if fileName == "" {
		fileName = fmt.Sprintf("generated-%d.%s", index+1, extensionFromMimeType(mimeType))
	}
	direct, err := s.BeginDirectTaskMediaUpload(userID, taskID, index, fileName, size, mimeType, width, height)
	if err != nil {
		return nil, err
	}
	intent := &TaskMediaUploadIntent{
		TaskID: task.ID, ResourceID: direct.Resource.ID, SourceURL: sourceURL,
		ObjectKey: direct.Resource.ObjectKey, UploadURL: direct.UploadURL, Headers: direct.Headers,
		MimeType: direct.Resource.MimeType, Size: direct.Resource.Size, Index: index,
		MultipartUploadID: direct.MultipartUploadID, Parts: direct.Parts, PartSize: direct.PartSize,
	}
	if !direct.ExpiresAt.IsZero() {
		intent.ExpiresAt = direct.ExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return intent, nil
}

func (s *Service) TaskMediaUploadSources(userID, taskID string) ([]TaskMediaUploadSource, error) {
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task.MediaStage != "client_upload_pending" || task.MediaRecoveryJSON == "" {
		return nil, BadAuthRequest("任务当前没有待上传的生成作品")
	}
	checkpoint, err := s.decodeMediaCheckpoint(task)
	if err != nil {
		return nil, err
	}
	result := make([]TaskMediaUploadSource, 0, len(checkpoint.Items))
	for index, item := range checkpoint.Items {
		if strings.TrimSpace(item.Reference.URL) == "" {
			return nil, BadAuthRequest("上游结果地址已过期")
		}
		if _, err := ValidateOutboundURL(item.Reference.URL); err != nil {
			return nil, BadAuthRequest("上游结果地址不可访问")
		}
		result = append(result, TaskMediaUploadSource{Index: index, SourceURL: item.Reference.URL, MimeType: firstNonEmpty(item.MIMEType, item.Reference.MIMEType)})
	}
	return result, nil
}

func (s *Service) CompleteTaskMediaUpload(userID, taskID string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task.Status != model.TaskStatusRunning || task.MediaStage != "client_upload_pending" || task.MediaRecoveryJSON == "" {
		if task.Status == model.TaskStatusSucceeded {
			return taskForOutput(*task), nil
		}
		return nil, BadAuthRequest("任务当前不在浏览器上传阶段")
	}
	checkpoint, err := s.decodeMediaCheckpoint(task)
	if err != nil {
		return nil, err
	}
	result, err := s.clientMediaResult(task, checkpoint)
	if err != nil {
		return nil, err
	}
	task.MediaStage = "register"
	if err := s.saveMediaCheckpointWithoutLease(task, checkpoint, "register"); err != nil {
		return nil, err
	}
	if err := s.finishTaskMediaRecovery(task, result, nil); err != nil {
		return nil, err
	}
	completed, err := s.repo.TaskForUser(userID, task.ID)
	if err != nil {
		return nil, err
	}
	return taskForOutput(*completed), nil
}

func (s *Service) FailTaskMediaUpload(userID, taskID, message string) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task.Status == model.TaskStatusFailed {
		return taskForOutput(*task), nil
	}
	if task.Status != model.TaskStatusRunning || task.MediaStage != "client_upload_pending" {
		return nil, BadAuthRequest("任务当前不在浏览器上传阶段")
	}
	if strings.TrimSpace(message) == "" {
		message = "浏览器上传生成作品失败"
	}
	if err := s.terminalCoordinator().handleResultPersistenceFailureError(task, errors.New(message)); err != nil {
		return nil, err
	}
	updated, err := s.repo.TaskForUser(userID, task.ID)
	if err != nil {
		return nil, err
	}
	return taskForOutput(*updated), nil
}

func (s *Service) clientMediaResult(task *model.Task, checkpoint *mediaCheckpoint) (map[string]interface{}, error) {
	items := make([]interface{}, 0, len(checkpoint.Items))
	for index := range checkpoint.Items {
		item := &checkpoint.Items[index]
		resource, err := s.resourceForUploadKey(task.UserID, mediaUploadKey(task.ID, index))
		if err != nil {
			return nil, err
		}
		if resource == nil || resource.Status != model.ResourceStatusReady {
			return nil, errors.New("生成作品尚未上传完成")
		}
		item.ResourceID = resource.ID
		url := resourceFileURL(resource.ID)
		items = append(items, map[string]interface{}{"dataUrl": url, "url": url, "resourceId": resource.ID, "storageKey": "resource:" + resource.ID, "mimeType": resource.MimeType, "bytes": resource.Size, "width": resource.Width, "height": resource.Height, "durationMs": resource.DurationMs})
	}
	result := map[string]interface{}{"mode": checkpoint.Mode}
	if checkpoint.Mode == "image" {
		result["images"] = items
	} else if checkpoint.Mode == "audio" {
		result["audios"] = items
		result["audio"] = items[0]
	} else {
		result[checkpoint.Mode] = items[0]
	}
	return result, nil
}
