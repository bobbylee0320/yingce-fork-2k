package app

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"sync"
	"time"

	"yingce/backend/internal/model"
)

// OSS 上传并发与 AI 生成 worker 解耦，过载时收敛，稳定时逐步恢复。
const (
	ossUploadMinConcurrency     = 1
	ossUploadInitialConcurrency = 2
	ossUploadMaxConcurrency     = 4
	ossUploadStableSuccesses    = 8
)

var errOSSUploadRetry = errors.New("OSS 上传可重试")

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

func generatedUploadBudget(size int64) time.Duration {
	budget := time.Minute + time.Duration(max(size, 0)>>20)*time.Second
	return min(budget, 10*time.Minute)
}

func (s *Service) taskMediaObjectWriter() func(*model.Resource, string, io.Reader) (string, error) {
	return func(resource *model.Resource, _ string, body io.Reader) (string, error) {
		if resource.Provider == "local" {
			return "", writeLocalResourceObject(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)), body)
		}
		ctx, cancel := context.WithTimeout(context.Background(), generatedUploadBudget(resource.Size))
		defer cancel()
		if err := mediaOSSUploadLimiter.acquire(ctx); err != nil {
			return "", &mediaOSSUploadError{cause: err, retryable: true}
		}
		etag, err := s.storeTaskMediaObjectContext(ctx, resource, body)
		mediaOSSUploadLimiter.release(err)
		if err != nil {
			failure := classifyStorageError(err)
			return "", &mediaOSSUploadError{cause: err, retryable: failure.Transient || failure.StatusCode == 429 || failure.StatusCode == 503}
		}
		return etag, nil
	}
}
