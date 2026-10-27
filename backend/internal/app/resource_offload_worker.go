package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

// 补传 worker：把本地兜底的生成作品上传到原定对象存储，成功后切换资源行。
// 资源 ID 和访问链接不变；本地文件在切换后保留一段时间再删，避免打断正在进行的读取。
const (
	resourceOffloadInterval       = 30 * time.Second
	resourceOffloadBatch          = 10
	resourceOffloadLease          = 15 * time.Minute
	resourceOffloadUploadTimeout  = 10 * time.Minute
	resourceOffloadLocalRetention = 15 * time.Minute
)

var resourceOffloadDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, 30 * time.Minute, time.Hour}

func resourceOffloadRetryDelay(attempts int) time.Duration {
	if attempts >= 1 && attempts <= len(resourceOffloadDelays) {
		return resourceOffloadDelays[attempts-1]
	}
	if attempts < 1 {
		return resourceOffloadDelays[0]
	}
	return 2 * time.Hour
}

func (s *Service) startResourceOffloadWorker() {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(resourceOffloadInterval)
		defer ticker.Stop()
		for {
			s.drainResourceOffloadJobs(ctx, resourceOffloadBatch)
			s.cleanupOffloadedLocalFiles()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}

func (s *Service) drainResourceOffloadJobs(ctx context.Context, limit int) {
	owner := s.workerID
	if owner == "" {
		owner = newID()
	}
	// 同一轮里某个存储位置写入失败后，不再对它发起新的上传，只顺延剩余任务。
	blocked := map[string]bool{}
	for index := 0; index < limit && ctx.Err() == nil; index++ {
		job, err := s.repo.ClaimNextResourceOffloadJob(owner, resourceOffloadLease)
		if err != nil {
			slog.Warn("resource offload claim failed", "error", err)
			return
		}
		if job == nil {
			return
		}
		s.processResourceOffloadJob(ctx, job, owner, blocked)
	}
}

func offloadTargetKey(job *model.ResourceOffloadJob) string {
	return storageBreakerKey(&model.Resource{Provider: job.TargetProvider, Endpoint: job.TargetEndpoint, Bucket: job.TargetBucket})
}

func (s *Service) retryResourceOffload(job *model.ResourceOffloadJob, owner, code, message string) {
	if err := s.repo.RetryResourceOffloadJob(job.ID, owner, code, truncateRunes(message, 1000), time.Now().Add(resourceOffloadRetryDelay(job.Attempts))); err != nil {
		slog.Warn("resource offload retry update failed", "jobId", job.ID, "error", err)
	}
}

func (s *Service) processResourceOffloadJob(ctx context.Context, job *model.ResourceOffloadJob, owner string, blocked map[string]bool) {
	resource, err := s.repo.Resource(job.ResourceID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		s.retryResourceOffload(job, owner, job.LastErrorCode, "读取资源失败："+err.Error())
		return
	}
	if err != nil || resource.UserID != job.UserID || resource.Status != model.ResourceStatusReady || resource.Provider != "local" || resource.ObjectKey != job.LocalObjectKey {
		if err != nil {
			resource = nil
		}
		s.cancelResourceOffload(job, owner, resource, "资源已删除或已不使用这份本地文件")
		return
	}
	// 转码会把播放副本状态写回资源行，等转码结束再切换，避免远端资源带上本地播放副本。
	if resource.PlaybackStatus == model.PlaybackStatusProcessing {
		s.retryResourceOffload(job, owner, job.LastErrorCode, "等待播放副本转码完成")
		return
	}
	key := offloadTargetKey(job)
	if blocked[key] {
		s.retryResourceOffload(job, owner, job.LastErrorCode, job.LastError)
		return
	}
	file, err := os.Open(filepath.Join(s.dataDir, "resources", filepath.FromSlash(job.LocalObjectKey)))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// 本地唯一副本丢失，无法自动恢复，保留记录供人工处理。
			slog.Error("resource offload local file missing", "jobId", job.ID, "resourceId", job.ResourceID)
			if finishErr := s.repo.FinishResourceOffloadJob(job.ID, owner, model.ResourceOffloadStatusFailed, map[string]any{"last_error_code": "local_missing", "last_error": "本地兜底文件不存在"}); finishErr != nil {
				slog.Warn("resource offload finish failed", "jobId", job.ID, "error", finishErr)
			}
			return
		}
		s.retryResourceOffload(job, owner, "local_open_failed", err.Error())
		return
	}
	target := &model.Resource{ID: resource.ID, UserID: resource.UserID, Kind: resource.Kind, Provider: job.TargetProvider, Endpoint: job.TargetEndpoint, Bucket: job.TargetBucket, StorageSettingID: job.TargetStorageSettingID, ObjectKey: job.TargetObjectKey, MimeType: resource.MimeType, Size: resource.Size}
	setting, err := s.ossSettingForResource(job.UserID, target)
	if err != nil {
		_ = file.Close()
		s.retryResourceOffload(job, owner, "storage_config", err.Error())
		return
	}
	started := time.Now()
	uploadCtx, cancel := context.WithTimeout(ctx, resourceOffloadUploadTimeout)
	etag, err := putOSSObjectContext(uploadCtx, s.storageSettingWithRuntimePolicy(setting), job.TargetObjectKey, resource.MimeType, resource.Size, file)
	cancel()
	_ = file.Close()
	mediaStorageBreaker.record(key, err)
	if err != nil {
		blocked[key] = true
		failure := classifyStorageError(err)
		s.retryResourceOffload(job, owner, failure.Label(), err.Error())
		s.logResourceOffload(job, resource, started, err)
		return
	}
	switched, err := s.repo.SwitchResourceToObjectStorage(job, etag)
	if err != nil {
		s.retryResourceOffload(job, owner, "switch_failed", err.Error())
		return
	}
	if !switched {
		latest, readErr := s.repo.Resource(job.ResourceID)
		if readErr != nil {
			latest = nil
		}
		s.cancelResourceOffload(job, owner, latest, "上传完成时资源已变化")
		return
	}
	deleteAfter := time.Now().Add(resourceOffloadLocalRetention)
	if err := s.repo.FinishResourceOffloadJob(job.ID, owner, model.ResourceOffloadStatusDone, map[string]any{"local_playback_key": resource.PlaybackObjectKey, "local_delete_after": &deleteAfter, "last_error_code": "", "last_error": ""}); err != nil {
		slog.Warn("resource offload finish failed", "jobId", job.ID, "error", err)
	}
	if err := s.repo.ExpediteResourceOffloadJobs(job.TargetProvider, job.TargetEndpoint, job.TargetBucket, time.Now()); err != nil {
		slog.Warn("resource offload expedite failed", "error", err)
	}
	s.logResourceOffload(job, resource, started, nil)
}

// cancelResourceOffload 结束不再需要的补传。资源已删除时，删除可能已上传的目标对象；
// 资源行仍引用目标对象时（例如之后的重试直接上传成功）绝不删除它。
func (s *Service) cancelResourceOffload(job *model.ResourceOffloadJob, owner string, resource *model.Resource, reason string) {
	if resource == nil || resource.Status == model.ResourceStatusDeleted {
		target := &model.Resource{ID: job.ResourceID, UserID: job.UserID, Provider: job.TargetProvider, Endpoint: job.TargetEndpoint, Bucket: job.TargetBucket, StorageSettingID: job.TargetStorageSettingID, ObjectKey: job.TargetObjectKey}
		if setting, err := s.ossSettingForResource(job.UserID, target); err == nil {
			if err := deleteOSSObject(s.storageSettingWithRuntimePolicy(setting), job.TargetObjectKey); err != nil {
				slog.Warn("resource offload target cleanup failed", "jobId", job.ID, "error", err)
			}
		}
	}
	s.removeUnreferencedLocalObject(job.LocalObjectKey, "")
	if err := s.repo.FinishResourceOffloadJob(job.ID, owner, model.ResourceOffloadStatusCancelled, map[string]any{"last_error": reason}); err != nil {
		slog.Warn("resource offload cancel failed", "jobId", job.ID, "error", err)
	}
}

func (s *Service) removeUnreferencedLocalObject(objectKey, playbackKey string) bool {
	referenced, err := s.repo.LocalObjectReferenced(objectKey)
	if err != nil || referenced {
		return false
	}
	if err := s.deleteLocalResourceObject(objectKey); err != nil {
		slog.Warn("resource offload local cleanup failed", "error", err)
		return false
	}
	if playbackKey != "" {
		if err := os.Remove(filepath.Join(s.dataDir, playbackDirName, filepath.Base(playbackKey))); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("resource offload playback cleanup failed", "error", err)
		}
	}
	return true
}

func (s *Service) cleanupOffloadedLocalFiles() {
	jobs, err := s.repo.DueResourceOffloadCleanups(time.Now(), 50)
	if err != nil {
		slog.Warn("resource offload cleanup query failed", "error", err)
		return
	}
	for _, job := range jobs {
		referenced, err := s.repo.LocalObjectReferenced(job.LocalObjectKey)
		if err != nil {
			continue
		}
		// 仍有资源行引用本地文件时保留文件，只结束清理，避免反复检查。
		if referenced || s.removeUnreferencedLocalObject(job.LocalObjectKey, job.LocalPlaybackKey) {
			if err := s.repo.MarkResourceOffloadLocalDeleted(job.ID); err != nil {
				slog.Warn("resource offload cleanup mark failed", "jobId", job.ID, "error", err)
			}
		}
	}
}

func (s *Service) logResourceOffload(job *model.ResourceOffloadJob, resource *model.Resource, started time.Time, err error) {
	entry := model.ApiCallLog{UserID: job.UserID, TaskID: job.TaskID, Source: "backend-task", Capability: resource.Kind, RequestKind: "offload", Method: "INTERNAL", Path: "resource/offload", Status: model.ApiCallStatusSucceeded, DurationMs: time.Since(started).Milliseconds()}
	if err != nil {
		entry.Status, entry.ErrorCode, entry.Error = model.ApiCallStatusFailed, "media_offload_failed", mediaStageLabel("offload")
		if label := classifyStorageError(err).Label(); label != "" {
			entry.Error += "（存储返回 " + label + "）"
		}
	}
	if logErr := s.LogAPICall(entry); logErr != nil {
		slog.Warn("resource offload log failed", "jobId", job.ID, "error", logErr)
	}
}
