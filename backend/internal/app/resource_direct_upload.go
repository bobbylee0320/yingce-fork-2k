package app

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

const directS3UploadTTL = 5 * time.Minute

type DirectResourceUpload struct {
	Resource  *model.Resource   `json:"resource"`
	UploadURL string            `json:"uploadUrl,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
}

func (s *Service) BeginDirectImageUpload(userID string, fileName string, size int64, mimeType string, width int, height int, uploadIdentity string) (*DirectResourceUpload, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	fileName = strings.TrimSpace(fileName)
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if fileName == "" || len(fileName) > 255 || size <= 0 || !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return nil, BadAuthRequest("图片名称、大小或格式无效")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	if size >= megabytes(policy.Resource.ResourceUploadMB) {
		return nil, BadAuthRequest(fmt.Sprintf("单个上传文件必须小于 %dMB", policy.Resource.ResourceUploadMB))
	}

	uploadKey := normalizedResourceUploadKey([]string{uploadIdentity})
	if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr != nil {
		return nil, lookupErr
	} else if existing != nil {
		if existing.Kind != "image" || existing.Size != size || existing.MimeType != mimeType {
			return nil, NewAppError(http.StatusConflict, "上传幂等标识已用于其他文件")
		}
		if existing.Status == model.ResourceStatusReady {
			return &DirectResourceUpload{Resource: existing}, nil
		}
		if existing.Provider != "s3" {
			return nil, NewAppError(http.StatusConflict, "该图片已有其他上传方式正在处理")
		}
		if existing.Status == model.ResourceStatusFailed {
			claimed, claimErr := s.repo.ClaimFailedResourceUpload(userID, existing.ID)
			if claimErr != nil {
				return nil, claimErr
			}
			if !claimed {
				return nil, resourceUploadInProgress()
			}
			existing.Status = model.ResourceStatusPending
			existing.Error = ""
		}
		return s.directImageUploadURL(existing)
	}

	setting, storageSettingID, useOSS, err := s.activeResourceOSSSetting(userID)
	if err != nil {
		return nil, err
	}
	if !useOSS || setting.Provider != "s3" {
		return nil, NewAppError(http.StatusNotImplemented, "当前对象存储不支持浏览器直传")
	}
	now := time.Now()
	resource := &model.Resource{
		ID: newID(), UserID: userID, Kind: "image", Status: model.ResourceStatusPending,
		Provider: setting.Provider, Endpoint: setting.Endpoint, Bucket: setting.Bucket,
		StorageSettingID: storageSettingID, ObjectKey: ossObjectKey(setting, userID, "image", fileName, mimeType, now),
		MimeType: mimeType, Size: size, Width: max(width, 0), Height: max(height, 0),
		UploadKey: uploadKey, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.CreateResource(resource); err != nil {
		if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && existing != nil {
			if existing.Status == model.ResourceStatusReady {
				return &DirectResourceUpload{Resource: existing}, nil
			}
			return nil, resourceUploadInProgress()
		}
		return nil, err
	}
	result, err := s.directImageUploadURL(resource)
	if err != nil {
		_ = s.repo.DeleteResource(userID, resource.ID)
		return nil, err
	}
	return result, nil
}

func (s *Service) directImageUploadURL(resource *model.Resource) (*DirectResourceUpload, error) {
	setting, err := s.ossSettingForResource(resource.UserID, resource)
	if err != nil {
		return nil, err
	}
	if setting.Provider != "s3" {
		return nil, NewAppError(http.StatusNotImplemented, "当前对象存储不支持浏览器直传")
	}
	url, err := presignS3PutObject(setting, resource.ObjectKey, resource.MimeType, time.Now().Add(directS3UploadTTL))
	if err != nil {
		return nil, err
	}
	return &DirectResourceUpload{Resource: resource, UploadURL: url, Headers: map[string]string{"Content-Type": resource.MimeType}}, nil
}

func (s *Service) CompleteDirectImageUpload(userID string, resourceID string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Kind != "image" || resource.Provider != "s3" {
		return nil, BadAuthRequest("资源不是待完成的 S3 图片上传")
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status != model.ResourceStatusPending {
		return nil, BadAuthRequest("图片上传会话已失效，请重试")
	}
	setting, err := s.ossSettingForResource(userID, resource)
	if err != nil {
		return nil, err
	}
	metadata, err := headS3Object(setting, resource.ObjectKey)
	if err != nil {
		return nil, err
	}
	if metadata.Size != resource.Size || (metadata.ContentType != "" && !strings.EqualFold(metadata.ContentType, resource.MimeType)) {
		return nil, BadAuthRequest("S3 图片内容与上传声明不一致")
	}
	day, err := s.reserveUserUploadQuota(userID, resource.Size)
	if err != nil {
		_ = deleteS3Object(setting, resource.ObjectKey)
		_, _ = s.repo.FailPendingResourceUpload(userID, resource.ID, "对象已上传，但账号存储额度不足", time.Now())
		return nil, err
	}
	completedAt := time.Now()
	claimed, err := s.repo.CompletePendingResourceUpload(userID, resource.ID, metadata.ETag, completedAt)
	if err != nil {
		s.releaseUserUploadQuota(userID, day, resource.Size)
		return nil, err
	}
	if !claimed {
		s.releaseUserUploadQuota(userID, day, resource.Size)
		latest, lookupErr := s.repo.ResourceForUser(userID, resource.ID)
		if lookupErr == nil && latest.Status == model.ResourceStatusReady {
			return latest, nil
		}
		return nil, resourceUploadInProgress()
	}
	s.commitUserUploadQuota(userID, resource.Size)
	resource.Status = model.ResourceStatusReady
	resource.ETag = metadata.ETag
	resource.UpdatedAt = completedAt
	s.recordActivity(userID, "resource", 1)
	return resource, nil
}

func (s *Service) FailDirectImageUpload(userID string, resourceID string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status != model.ResourceStatusPending || resource.Provider != "s3" || resource.Kind != "image" {
		return nil, BadAuthRequest("图片上传会话已失效")
	}
	setting, settingErr := s.ossSettingForResource(userID, resource)
	if settingErr == nil {
		metadata, headErr := headS3Object(setting, resource.ObjectKey)
		if headErr == nil && metadata.Size == resource.Size && (metadata.ContentType == "" || strings.EqualFold(metadata.ContentType, resource.MimeType)) {
			return s.CompleteDirectImageUpload(userID, resourceID)
		}
		if headErr == nil {
			_ = deleteS3Object(setting, resource.ObjectKey)
		}
	}
	if _, err := s.repo.FailPendingResourceUpload(userID, resource.ID, "浏览器直传未完成", time.Now()); err != nil {
		return nil, err
	}
	return s.repo.ResourceForUser(userID, resourceID)
}
