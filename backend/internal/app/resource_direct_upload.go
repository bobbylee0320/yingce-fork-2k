package app

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/storage"
)

const directS3UploadTTL = 5 * time.Minute

type DirectResourceUpload struct {
	Resource          *model.Resource    `json:"resource"`
	UploadURL         string             `json:"uploadUrl,omitempty"`
	Headers           map[string]string  `json:"headers,omitempty"`
	ExpiresAt         time.Time          `json:"expiresAt,omitempty"`
	MultipartUploadID string             `json:"multipartUploadId,omitempty"`
	Parts             []DirectUploadPart `json:"parts,omitempty"`
	PartSize          int64              `json:"partSize,omitempty"`
}

type DirectUploadPart struct {
	PartNumber int    `json:"partNumber"`
	UploadURL  string `json:"uploadUrl"`
	ETag       string `json:"etag,omitempty"`
}

func (s *Service) BeginDirectImageUpload(userID string, fileName string, size int64, mimeType string, width int, height int, uploadIdentity string) (*DirectResourceUpload, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	return s.beginDirectResourceUpload(userID, "image", fileName, size, mimeType, width, height, uploadIdentity, megabytes(policy.Resource.ResourceUploadMB))
}

// BeginDirectTaskMediaUpload creates the pending resource used by generated
// media. The object is still empty at this point; the browser receives the
// upstream URL and a short lived PUT signature, then completes the task after
// the object has been verified by HEAD.
func (s *Service) BeginDirectTaskMediaUpload(userID, taskID string, index int, fileName string, size int64, mimeType string, width, height int) (*DirectResourceUpload, error) {
	task, err := s.repo.TaskForUser(userID, strings.TrimSpace(taskID))
	if err != nil {
		return nil, err
	}
	if task.MediaStage != "client_upload_pending" || task.MediaRecoveryJSON == "" {
		return nil, BadAuthRequest("任务当前没有待上传的生成作品")
	}
	checkpoint, err := s.decodeMediaCheckpoint(task)
	if err != nil || index < 0 || index >= len(checkpoint.Items) {
		return nil, BadAuthRequest("生成作品上传索引无效")
	}
	item := checkpoint.Items[index]
	if strings.TrimSpace(item.Reference.URL) == "" {
		return nil, BadAuthRequest("生成作品上游地址已过期")
	}
	kind := checkpoint.Mode
	if kind != "image" && kind != "video" && kind != "audio" {
		return nil, BadAuthRequest("生成作品类型无效")
	}
	if mimeType == "" {
		mimeType = firstNonEmpty(item.MIMEType, item.Reference.MIMEType)
	}
	if fileName == "" {
		fileName = "generated." + extensionFromMimeType(mimeType)
	}
	return s.beginDirectResourceUpload(userID, kind, fileName, size, mimeType, width, height, fmt.Sprintf("task-media:%s:%d", taskID, index), megabytesForDirectUpload(s, kind))
}

func megabytesForDirectUpload(s *Service, kind string) int64 {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return 0
	}
	if kind == "image" || kind == "video" || kind == "audio" {
		return megabytes(policy.Resource.GeneratedFileMB)
	}
	return megabytes(policy.Resource.ResourceUploadMB)
}

func (s *Service) beginDirectResourceUpload(userID, kind, fileName string, size int64, mimeType string, width, height int, uploadIdentity string, maxSize int64) (*DirectResourceUpload, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	fileName = strings.TrimSpace(fileName)
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if fileName == "" || len(fileName) > 255 || size <= 0 || !strings.HasPrefix(strings.ToLower(mimeType), kind+"/") {
		return nil, BadAuthRequest("生成作品名称、大小或格式无效")
	}
	if maxSize <= 0 {
		return nil, BadAuthRequest("当前运行环境未启用对象存储直传")
	}
	if size >= maxSize {
		return nil, BadAuthRequest(fmt.Sprintf("单个生成文件必须小于 %dMB", maxSize/(1<<20)))
	}
	uploadKey := normalizedResourceUploadKey([]string{uploadIdentity})
	if existing, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr != nil {
		return nil, lookupErr
	} else if existing != nil {
		if existing.Kind != kind || existing.Size != size || existing.MimeType != mimeType {
			return nil, NewAppError(http.StatusConflict, "上传幂等标识已用于其他文件")
		}
		if existing.Status == model.ResourceStatusReady {
			return &DirectResourceUpload{Resource: existing}, nil
		}
		if existing.Provider != "s3" {
			return nil, NewAppError(http.StatusConflict, "该生成作品已有其他上传方式正在处理")
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
		ID: newID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending,
		Provider: setting.Provider, Endpoint: setting.Endpoint, Bucket: setting.Bucket,
		StorageSettingID: storageSettingID, ObjectKey: ossObjectKey(setting, userID, kind, fileName, mimeType, now),
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
	result, err := s.directResourceUploadURL(resource)
	if err != nil {
		_ = s.repo.DeleteResource(userID, resource.ID)
		return nil, err
	}
	return result, nil
}

func (s *Service) directImageUploadURL(resource *model.Resource) (*DirectResourceUpload, error) {
	return s.directResourceUploadURL(resource)
}

func (s *Service) directResourceUploadURL(resource *model.Resource) (*DirectResourceUpload, error) {
	setting, err := s.ossSettingForResource(resource.UserID, resource)
	if err != nil {
		return nil, err
	}
	if setting.Provider != "s3" {
		return nil, NewAppError(http.StatusNotImplemented, "当前对象存储不支持浏览器直传")
	}
	expiresAt := time.Now().Add(directS3UploadTTL)
	if resource.Kind == "video" {
		const partSize int64 = 8 << 20
		uploadID, err := createS3MultipartUpload(setting, resource.ObjectKey, resource.MimeType)
		if err != nil {
			return nil, err
		}
		count := int((resource.Size + partSize - 1) / partSize)
		parts := make([]DirectUploadPart, 0, count)
		for index := 1; index <= count; index++ {
			partURL, signErr := presignS3UploadPart(setting, resource.ObjectKey, uploadID, index, expiresAt)
			if signErr != nil {
				_ = abortS3MultipartUpload(setting, resource.ObjectKey, uploadID)
				return nil, signErr
			}
			parts = append(parts, DirectUploadPart{PartNumber: index, UploadURL: partURL})
		}
		return &DirectResourceUpload{Resource: resource, MultipartUploadID: uploadID, Parts: parts, PartSize: partSize, ExpiresAt: expiresAt}, nil
	}
	url, err := presignS3PutObject(setting, resource.ObjectKey, resource.MimeType, expiresAt)
	if err != nil {
		return nil, err
	}
	return &DirectResourceUpload{Resource: resource, UploadURL: url, Headers: map[string]string{"Content-Type": resource.MimeType}, ExpiresAt: expiresAt}, nil
}

func (s *Service) CompleteDirectImageUpload(userID string, resourceID string) (*model.Resource, error) {
	return s.completeDirectResourceUpload(userID, resourceID, "", nil, false)
}

func (s *Service) CompleteDirectResourceUpload(userID string, resourceID string, multipartUploadID string, parts []DirectUploadPart, generated ...bool) (*model.Resource, error) {
	return s.completeDirectResourceUpload(userID, resourceID, multipartUploadID, parts, len(generated) > 0 && generated[0])
}

func (s *Service) completeDirectResourceUpload(userID string, resourceID string, multipartUploadID string, parts []DirectUploadPart, generated bool) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Provider != "s3" || (resource.Kind != "image" && resource.Kind != "video" && resource.Kind != "audio") {
		return nil, BadAuthRequest("资源不是待完成的 S3 生成作品上传")
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status != model.ResourceStatusPending {
		return nil, BadAuthRequest("生成作品上传会话已失效，请重试")
	}
	setting, err := s.ossSettingForResource(userID, resource)
	if err != nil {
		return nil, err
	}
	if resource.Kind == "video" {
		if strings.TrimSpace(multipartUploadID) == "" || len(parts) == 0 {
			return nil, BadAuthRequest("视频分片上传信息不完整")
		}
		multipartParts := make([]storage.S3MultipartPart, 0, len(parts))
		for _, part := range parts {
			multipartParts = append(multipartParts, storage.S3MultipartPart{PartNumber: part.PartNumber, ETag: part.ETag})
		}
		if err := completeS3MultipartUpload(setting, resource.ObjectKey, multipartUploadID, multipartParts); err != nil {
			return nil, err
		}
	}
	metadata, err := headS3Object(setting, resource.ObjectKey)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(metadata.ETag) == "" || metadata.Size != resource.Size || (metadata.ContentType != "" && !strings.EqualFold(metadata.ContentType, resource.MimeType)) {
		return nil, BadAuthRequest("S3 生成作品内容与上传声明不一致")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	day := ""
	if generated {
		day, err = s.reserveGeneratedResourceQuota(userID, resource.Size)
	} else {
		day, err = s.reserveUserUploadQuota(userID, resource.Size)
	}
	if err != nil {
		_ = deleteS3Object(setting, resource.ObjectKey)
		_, _ = s.repo.FailPendingResourceUpload(userID, resource.ID, "对象已上传，但账号存储额度不足", time.Now())
		return nil, err
	}
	completedAt := time.Now()
	claimed, err := s.repo.CompletePendingResourceUploadWithinStorageLimit(userID, resource.ID, metadata.ETag, completedAt, gigabytes(policy.Resource.StoredFileGB))
	if err != nil {
		s.releaseUserUploadQuota(userID, day, resource.Size)
		if errors.Is(err, repository.ErrUploadStorageLimit) {
			_ = deleteS3Object(setting, resource.ObjectKey)
			_, _ = s.repo.FailPendingResourceUpload(userID, resource.ID, "对象已上传，但账号存储额度不足", time.Now())
		}
		return nil, uploadReservationError(err)
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
	return s.failDirectResourceUpload(userID, resourceID, "")
}

func (s *Service) FailDirectResourceUpload(userID string, resourceID string, multipartUploadID string) (*model.Resource, error) {
	return s.failDirectResourceUpload(userID, resourceID, multipartUploadID)
}

func (s *Service) failDirectResourceUpload(userID string, resourceID string, multipartUploadID string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Status == model.ResourceStatusReady {
		return resource, nil
	}
	if resource.Status != model.ResourceStatusPending || resource.Provider != "s3" || (resource.Kind != "image" && resource.Kind != "video" && resource.Kind != "audio") {
		return nil, BadAuthRequest("生成作品上传会话已失效")
	}
	setting, settingErr := s.ossSettingForResource(userID, resource)
	if settingErr == nil {
		if resource.Kind == "video" && strings.TrimSpace(multipartUploadID) != "" {
			_ = abortS3MultipartUpload(setting, resource.ObjectKey, multipartUploadID)
		}
		metadata, headErr := headS3Object(setting, resource.ObjectKey)
		if headErr == nil && metadata.Size == resource.Size && (metadata.ContentType == "" || strings.EqualFold(metadata.ContentType, resource.MimeType)) {
			return s.completeDirectResourceUpload(userID, resourceID, "", nil, false)
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
