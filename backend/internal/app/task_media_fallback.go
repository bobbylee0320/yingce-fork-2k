package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"yingce/backend/internal/model"
)

// 生成作品的本地兜底：平台对象存储写入失败时，作品先存到后端数据目录，任务照常
// 成功并结算，再由 resource_offload_jobs 补传到原定位置。访问链接始终是
// /api/resources/{id}/file，补传只改 resources 行，画布和任务结果无需回写。
const (
	localFallbackBudgetBytes  int64 = 10 << 30
	localFallbackMinFreeBytes int64 = 5 << 30
	// 熔断：5 分钟内连续 3 次写入失败后，5 分钟内的新作品直接走本地兜底。
	storageBreakerWindow    = 5 * time.Minute
	storageBreakerThreshold = 3
	storageBreakerOpenFor   = 5 * time.Minute
	// 首次补传等待一分钟，给存储服务恢复时间。
	resourceOffloadFirstDelay = time.Minute
)

var errStorageCircuitOpen = errors.New("对象存储连续写入失败，已暂停直传")

// generatedUploadBudget 限制作品直传对象存储的总时长（含 SDK 内部重试），
// 超时后转本地兜底，避免用户长时间停在“正在保存”。
func generatedUploadBudget(size int64) time.Duration {
	budget := time.Minute + time.Duration(max(size, 0)>>20)*time.Second
	return min(budget, 10*time.Minute)
}

type storageBreakerState struct {
	failures  []time.Time
	openUntil time.Time
}

type storageBreaker struct {
	mu     sync.Mutex
	states map[string]*storageBreakerState
}

var mediaStorageBreaker = &storageBreaker{states: map[string]*storageBreakerState{}}

func storageBreakerKey(resource *model.Resource) string {
	return strings.Join([]string{strings.ToLower(resource.Provider), resource.Endpoint, resource.Bucket}, "\x00")
}

func (b *storageBreaker) isOpen(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.states[key]
	return state != nil && time.Now().Before(state.openUntil)
}

func (b *storageBreaker) record(key string, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err == nil {
		delete(b.states, key)
		return
	}
	if errors.Is(err, context.Canceled) {
		return
	}
	now := time.Now()
	state := b.states[key]
	if state == nil {
		state = &storageBreakerState{}
		b.states[key] = state
	}
	recent := state.failures[:0]
	for _, at := range state.failures {
		if now.Sub(at) < storageBreakerWindow {
			recent = append(recent, at)
		}
	}
	state.failures = append(recent, now)
	if len(state.failures) >= storageBreakerThreshold {
		state.openUntil = now.Add(storageBreakerOpenFor)
		state.failures = nil
		slog.Error("object storage circuit opened", "provider", storageBreakerProvider(key), "openUntil", state.openUntil)
	}
}

func storageBreakerProvider(key string) string {
	provider, _, _ := strings.Cut(key, "\x00")
	return provider
}

// localFallbackRefusal 返回不能本地兜底的原因；nil 表示可以兜底。只覆盖平台存储：
// 用户自有对象存储失败时不把用户数据转存到平台磁盘。
func (s *Service) localFallbackRefusal(resource *model.Resource) error {
	if resource == nil || resource.Provider == "local" {
		return errors.New("资源已在本地存储")
	}
	if resource.StorageSettingID != "" {
		location, err := s.repo.StorageLocation(resource.StorageSettingID)
		if err != nil {
			return errors.New("用户自有存储不做本地兜底")
		}
		if location.Scope != "platform" {
			return errors.New("用户自有存储不做本地兜底")
		}
	}
	used, err := s.repo.LocalFallbackBytes()
	if err != nil {
		return err
	}
	if used+resource.Size > localFallbackBudgetBytes {
		return fmt.Errorf("本地兜底空间已用 %d 字节，超过上限", used)
	}
	disk := collectSystemDisk(s.dataDir)
	if !disk.Available || !disk.Writable || int64(disk.FreeBytes)-resource.Size < localFallbackMinFreeBytes {
		return errors.New("数据盘剩余空间不足，不做本地兜底")
	}
	return nil
}

// fallbackTaskMediaToLocal 把暂存作品写到本地资源目录，登记补传任务，并把 resource
// 改为本地存储。调用方随后把资源标记为 ready 并保存。补传任务先于资源行落库：
// 资源行保存失败时，worker 会发现资源不是这份本地文件并取消任务。
func (s *Service) fallbackTaskMediaToLocal(task *model.Task, resource *model.Resource, stagedPath string, cause error) error {
	now := time.Now()
	localKey := localObjectKey(resource.UserID, resource.Kind, "generated."+extensionFromMimeType(resource.MimeType), resource.MimeType, now)
	localPath := filepath.Join(s.dataDir, "resources", filepath.FromSlash(localKey))
	source, err := os.Open(stagedPath)
	if err != nil {
		return err
	}
	err = writeLocalResourceObject(localPath, source)
	_ = source.Close()
	if err == nil {
		var info os.FileInfo
		if info, err = os.Stat(localPath); err == nil && info.Size() != resource.Size {
			err = errors.New("本地兜底文件大小与资源记录不一致")
		}
	}
	if err != nil {
		_ = os.Remove(localPath)
		return err
	}
	failure := classifyStorageError(cause)
	job := &model.ResourceOffloadJob{
		ID: newID(), UserID: resource.UserID, ResourceID: resource.ID, TaskID: task.ID, Size: resource.Size,
		LocalObjectKey: localKey, TargetProvider: resource.Provider, TargetEndpoint: resource.Endpoint, TargetBucket: resource.Bucket,
		TargetStorageSettingID: resource.StorageSettingID, TargetObjectKey: resource.ObjectKey,
		Status: model.ResourceOffloadStatusPending, LastErrorCode: failure.Label(), LastError: truncateRunes(cause.Error(), 1000),
		NextAttemptAt: now.Add(resourceOffloadFirstDelay), CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.UpsertResourceOffloadJob(job); err != nil {
		_ = os.Remove(localPath)
		return fmt.Errorf("登记对象存储补传任务失败：%w", err)
	}
	resource.Provider, resource.Endpoint, resource.Bucket, resource.StorageSettingID, resource.ObjectKey, resource.ETag = "local", "", "", "", localKey, ""
	slog.Warn("generated media saved locally after object storage failure", "taskId", task.ID, "resourceId", resource.ID, "storageError", failure.Label())
	_ = s.log(task.UserID, task.ID, "warn", "对象存储写入失败，作品已先保存到服务器，稍后自动同步", failure.Label())
	return nil
}

// taskMediaObjectWriter 是生成作品的对象写入器：平台存储可兜底时限时直传，失败或熔断
// 时改存本地。*fallbackCause 记录触发兜底的存储错误，供调用方写请求日志。
func (s *Service) taskMediaObjectWriter(task *model.Task, stagedPath string, fallbackCause *error) func(*model.Resource, string, io.Reader) (string, error) {
	return func(resource *model.Resource, _ string, body io.Reader) (string, error) {
		if resource.Provider == "local" {
			return "", writeLocalResourceObject(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)), body)
		}
		refusal := s.localFallbackRefusal(resource)
		key := storageBreakerKey(resource)
		ctx := context.Background()
		if refusal == nil {
			if mediaStorageBreaker.isOpen(key) {
				if err := s.fallbackTaskMediaToLocal(task, resource, stagedPath, errStorageCircuitOpen); err != nil {
					return "", fmt.Errorf("%w（本地兜底失败：%v）", errStorageCircuitOpen, err)
				}
				*fallbackCause = errStorageCircuitOpen
				return "", nil
			}
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, generatedUploadBudget(resource.Size))
			defer cancel()
		}
		etag, err := s.storeTaskMediaObjectContext(ctx, resource, body)
		mediaStorageBreaker.record(key, err)
		if err == nil {
			return etag, nil
		}
		if refusal != nil {
			_ = s.log(task.UserID, task.ID, "warn", "对象存储写入失败，未做本地兜底", refusal.Error())
			return "", err
		}
		if fallbackErr := s.fallbackTaskMediaToLocal(task, resource, stagedPath, err); fallbackErr != nil {
			return "", fmt.Errorf("%w（本地兜底失败：%v）", err, fallbackErr)
		}
		*fallbackCause = err
		return "", nil
	}
}
