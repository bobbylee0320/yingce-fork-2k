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

// 生成作品写入平台对象存储：先限时直传；直传超时、失败或存储熔断时，作品先存到后端
// 数据目录，任务照常成功并结算，再由 resource_offload_jobs 补传到原定位置。访问链接
// 始终是 /api/resources/{id}/file，补传只改 resources 行，画布和任务结果无需回写。
// OSS 上传并发与 AI 生成 worker 解耦，过载时收敛，稳定时逐步恢复。
const (
	ossUploadMinConcurrency     = 1
	ossUploadInitialConcurrency = 2
	ossUploadMaxConcurrency     = 4
	ossUploadStableSuccesses    = 8

	// 直传时限按 256 KiB/s 估算（每 MiB 4 秒），并且不超过后台“对象存储传输超时”。
	generatedUploadBaseBudget   = time.Minute
	generatedUploadPerMiBBudget = 4 * time.Second
	// 等待上传名额单独计时，不占用传输时限；等不到名额就直接本地兜底。
	generatedUploadQueueTimeout = 2 * time.Minute

	localFallbackBudgetBytes  int64 = 10 << 30
	localFallbackMinFreeBytes int64 = 5 << 30
	// 首次补传等待一分钟，给存储服务恢复时间。
	resourceOffloadFirstDelay = time.Minute
)

var errOSSUploadRetry = errors.New("OSS 上传可重试")
var errStorageCircuitOpen = errors.New("对象存储连续写入失败，已暂停直传")
var errOSSUploadQueueTimeout = errors.New("等待对象存储上传名额超时")

type mediaOSSUploadError struct {
	cause     error
	retryable bool
}

func (e *mediaOSSUploadError) Error() string {
	if e.retryable {
		return "对象存储暂时不可用，作品保存将在后台重试"
	}
	return "对象存储上传失败，请检查存储配置"
}

func (e *mediaOSSUploadError) Unwrap() error { return e.cause }
func (e *mediaOSSUploadError) Is(target error) bool {
	return e.retryable && target == errOSSUploadRetry
}

type ossUploadLimiter struct {
	mu        sync.Mutex
	target    int
	active    int
	successes int
}

func newOSSUploadLimiter() *ossUploadLimiter {
	return &ossUploadLimiter{target: ossUploadInitialConcurrency}
}

var mediaOSSUploadLimiter = newOSSUploadLimiter()

func (l *ossUploadLimiter) acquire(ctx context.Context) error {
	for {
		l.mu.Lock()
		if l.active < l.target {
			l.active++
			l.mu.Unlock()
			return nil
		}
		l.mu.Unlock()
		if err := sleepContext(ctx, 25*time.Millisecond); err != nil {
			return err
		}
	}
}

func (l *ossUploadLimiter) release(err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active > 0 {
		l.active--
	}
	failure := classifyStorageError(err)
	if err != nil && (failure.StatusCode == 429 || failure.StatusCode == 503) {
		l.target = max(ossUploadMinConcurrency, l.target/2)
		l.successes = 0
		return
	}
	if err == nil {
		l.successes++
		if l.successes >= ossUploadStableSuccesses {
			l.target = min(ossUploadMaxConcurrency, l.target+1)
			l.successes = 0
		}
	}
}

func (l *ossUploadLimiter) concurrency() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.target
}

// generatedUploadBudget 是单次直传的总时限（含 SDK 内部重试）。transferTimeout 为 0
// 表示读取运行策略失败，此时只按文件大小估算。
func generatedUploadBudget(size int64, transferTimeout time.Duration) time.Duration {
	budget := generatedUploadBaseBudget + time.Duration(max(size, 0)>>20)*generatedUploadPerMiBBudget
	if transferTimeout > 0 {
		budget = min(budget, transferTimeout)
	}
	return budget
}

func (s *Service) objectStorageTransferTimeout() time.Duration {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return 0
	}
	return time.Duration(policy.Storage.TransferTimeoutSeconds) * time.Second
}

func storageBreakerKey(resource *model.Resource) string {
	return strings.Join([]string{strings.ToLower(resource.Provider), resource.Endpoint, resource.Bucket}, "\x00")
}

func (s *Service) dataDisk() SystemPerformanceDisk {
	if s.mediaStagingDiskProbe != nil {
		return s.mediaStagingDiskProbe()
	}
	return collectSystemDisk(s.dataDir)
}

// localFallbackRefusal 返回不能本地兜底的原因；nil 表示可以兜底。只覆盖平台存储：
// 用户自有对象存储失败时不把用户数据转存到平台磁盘。
func (s *Service) localFallbackRefusal(resource *model.Resource) error {
	if resource == nil || resource.Provider == "local" {
		return errors.New("资源已在本地存储")
	}
	if resource.StorageSettingID != "" {
		location, err := s.repo.StorageLocation(resource.StorageSettingID)
		if err != nil || location.Scope != "platform" {
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
	disk := s.dataDisk()
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

// taskMediaObjectWriter 是生成作品的对象写入器。平台存储可兜底时：熔断中直接存本地；
// 否则限时直传，排队超时或直传失败改存本地。*fallbackCause 记录触发兜底的原因，供调用方
// 写请求日志。不能兜底时返回 mediaOSSUploadError，由任务按可重试与否延迟恢复。
func (s *Service) taskMediaObjectWriter(task *model.Task, stagedPath string, fallbackCause *error) func(*model.Resource, string, io.Reader) (string, error) {
	return func(resource *model.Resource, _ string, body io.Reader) (string, error) {
		if resource.Provider == "local" {
			return "", writeLocalResourceObject(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)), body)
		}
		refusal := s.localFallbackRefusal(resource)
		failWith := func(cause error, retryable bool) (string, error) {
			uploadErr := &mediaOSSUploadError{cause: cause, retryable: retryable}
			if refusal != nil {
				_ = s.log(task.UserID, task.ID, "warn", "对象存储写入失败，未做本地兜底", refusal.Error())
				return "", uploadErr
			}
			if err := s.fallbackTaskMediaToLocal(task, resource, stagedPath, cause); err != nil {
				return "", &mediaOSSUploadError{cause: fmt.Errorf("%w（本地兜底失败：%v）", cause, err), retryable: retryable}
			}
			*fallbackCause = cause
			return "", nil
		}
		key := storageBreakerKey(resource)
		if refusal == nil && mediaStorageBreaker.isOpen(key) {
			return failWith(errStorageCircuitOpen, true)
		}
		queueCtx, cancelQueue := context.WithTimeout(context.Background(), generatedUploadQueueTimeout)
		err := mediaOSSUploadLimiter.acquire(queueCtx)
		cancelQueue()
		if err != nil {
			return failWith(fmt.Errorf("%w：%w", errOSSUploadQueueTimeout, err), true)
		}
		ctx, cancel := context.WithTimeout(context.Background(), generatedUploadBudget(resource.Size, s.objectStorageTransferTimeout()))
		defer cancel()
		etag, err := s.storeTaskMediaObjectContext(ctx, resource, body)
		mediaOSSUploadLimiter.release(err)
		mediaStorageBreaker.record(key, err)
		if err == nil {
			return etag, nil
		}
		failure := classifyStorageError(err)
		return failWith(err, failure.Transient || failure.StatusCode == 429 || failure.StatusCode == 503)
	}
}
