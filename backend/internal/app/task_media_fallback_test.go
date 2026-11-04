package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"

	"yingce/backend/internal/model"
)

func TestGeneratedUploadBudgetUsesConservativeSpeedAndTransferTimeout(t *testing.T) {
	for _, tc := range []struct {
		size     int64
		transfer time.Duration
		want     time.Duration
	}{
		{size: 5 << 20, transfer: 1200 * time.Second, want: 80 * time.Second},
		{size: 50 << 20, transfer: 1200 * time.Second, want: 260 * time.Second},
		{size: 50 << 20, transfer: 120 * time.Second, want: 120 * time.Second},
		{size: 0, transfer: 0, want: time.Minute},
	} {
		if got := generatedUploadBudget(tc.size, tc.transfer); got != tc.want {
			t.Fatalf("generatedUploadBudget(%d, %s) = %s, want %s", tc.size, tc.transfer, got, tc.want)
		}
	}
}

func seedPlatformOSS(t *testing.T, s *Service, endpoint string) {
	t.Helper()
	value, err := json.Marshal(ossSettingValue{Enabled: true, Provider: "aliyun", Endpoint: endpoint, Bucket: "platform-bucket", AccessKeyID: "platform-id", AccessKeySecret: "platform-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SaveSystemSetting(&model.SystemSetting{Key: ossSettingKey, ValueJSON: string(value)}); err != nil {
		t.Fatal(err)
	}
}

func stagedImageCheckpoint(t *testing.T, s *Service, task *model.Task) *mediaCheckpoint {
	t.Helper()
	temp, err := s.stageInlineMedia(mediaTestPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := &mediaCheckpoint{Mode: "image", StartedAt: time.Now(), Items: []mediaCheckpointItem{{TempName: temp, MIMEType: "image/png"}}}
	if err := s.saveMediaCheckpoint(task, checkpoint, "upload"); err != nil {
		t.Fatal(err)
	}
	return checkpoint
}

func mediaStageLogCount(t *testing.T, db *gorm.DB, taskID, path string, status model.ApiCallStatus) int64 {
	t.Helper()
	var count int64
	if err := db.Model(&model.ApiCallLog{}).Where("task_id = ? AND path = ? AND status = ?", taskID, path, status).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	return count
}

func TestPlatformStorageUploadFailureFallsBackToLocalAndSkipsUploadWhileCircuitOpen(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var uploads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		uploads.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	s, db := newMediaRecoveryTestService(t)
	seedPlatformOSS(t, s, server.URL)

	first := seedMediaTask(t, db, providerConfig{})
	if _, err := s.materializeTaskMedia(context.Background(), first, providerConfig{}, stagedImageCheckpoint(t, s, first)); err != nil {
		t.Fatalf("platform storage failure was not absorbed by local fallback: %v", err)
	}
	resource, err := s.resourceForUploadKey(first.UserID, mediaUploadKey(first.ID, 0))
	if err != nil || resource == nil || resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		t.Fatalf("fallback resource = %+v, %v", resource, err)
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); err != nil {
		t.Fatalf("local fallback file missing: %v", err)
	}
	var job model.ResourceOffloadJob
	if err := db.First(&job, "resource_id = ?", resource.ID).Error; err != nil {
		t.Fatal(err)
	}
	if job.Status != model.ResourceOffloadStatusPending || job.TargetProvider != "aliyun" || job.TargetBucket != "platform-bucket" || job.TargetObjectKey == "" || job.LocalObjectKey != resource.ObjectKey {
		t.Fatalf("offload job = %+v", job)
	}
	if uploads.Load() != 1 {
		t.Fatalf("uploads = %d, want 1", uploads.Load())
	}
	if mediaStageLogCount(t, db, first.ID, "task/media/upload", model.ApiCallStatusFailed) != 1 || mediaStageLogCount(t, db, first.ID, "task/media/local_fallback", model.ApiCallStatusSucceeded) != 1 {
		t.Fatal("fallback did not log the failed upload and the local save")
	}

	key := storageBreakerKey(&model.Resource{Provider: job.TargetProvider, Endpoint: job.TargetEndpoint, Bucket: job.TargetBucket})
	mediaStorageBreaker.mu.Lock()
	mediaStorageBreaker.states[key] = &storageBreakerState{openUntil: time.Now().Add(time.Minute)}
	mediaStorageBreaker.mu.Unlock()
	t.Cleanup(func() {
		mediaStorageBreaker.mu.Lock()
		delete(mediaStorageBreaker.states, key)
		mediaStorageBreaker.mu.Unlock()
	})

	second := seedMediaTask(t, db, providerConfig{})
	if _, err := s.materializeTaskMedia(context.Background(), second, providerConfig{}, stagedImageCheckpoint(t, s, second)); err != nil {
		t.Fatalf("open circuit did not fall back: %v", err)
	}
	if uploads.Load() != 1 {
		t.Fatalf("open circuit still uploaded: uploads=%d", uploads.Load())
	}
	var circuitLog model.ApiCallLog
	if err := db.First(&circuitLog, "task_id = ? AND path = ?", second.ID, "task/media/upload").Error; err != nil {
		t.Fatal(err)
	}
	if circuitLog.Error != mediaStageLabel("upload")+"（存储熔断中，未直传）" {
		t.Fatalf("circuit log error = %q", circuitLog.Error)
	}
}

func TestGeneratedMediaLocalFirstSkipsSynchronousObjectStorageUpload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	t.Setenv("CANVAS_GENERATED_MEDIA_LOCAL_FIRST", "true")
	var uploads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		uploads.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	s, db := newMediaRecoveryTestService(t)
	seedPlatformOSS(t, s, server.URL)
	task := seedMediaTask(t, db, providerConfig{})
	started := time.Now()
	if _, err := s.materializeTaskMedia(context.Background(), task, providerConfig{}, stagedImageCheckpoint(t, s, task)); err != nil {
		t.Fatalf("local-first media persistence failed: %v", err)
	}
	resource, err := s.resourceForUploadKey(task.UserID, mediaUploadKey(task.ID, 0))
	if err != nil || resource == nil || resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		t.Fatalf("local-first resource = %+v, %v", resource, err)
	}
	var job model.ResourceOffloadJob
	if err := db.First(&job, "resource_id = ?", resource.ID).Error; err != nil {
		t.Fatal(err)
	}
	if job.Status != model.ResourceOffloadStatusPending || job.ExpiresAt.Before(started.Add(4*time.Hour)) {
		t.Fatalf("local-first offload job = %+v", job)
	}
	if uploads.Load() != 0 {
		t.Fatalf("local-first path made synchronous uploads: %d", uploads.Load())
	}
}

func TestExpiredOffloadMarksResourceUnavailableAndRemovesLocalBytes(t *testing.T) {
	s, db := newMediaRecoveryTestService(t)
	resource := &model.Resource{ID: "expired-resource", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/expired.png", MimeType: "image/png", Size: 4}
	if err := s.repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	localPath := filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))
	if err := os.MkdirAll(filepath.Dir(localPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPath, []byte("test"), 0o640); err != nil {
		t.Fatal(err)
	}
	job := &model.ResourceOffloadJob{
		ID: "expired-job", UserID: resource.UserID, ResourceID: resource.ID, Size: resource.Size,
		LocalObjectKey: resource.ObjectKey, TargetProvider: "s3", TargetEndpoint: "https://storage.invalid", TargetBucket: "bucket",
		TargetObjectKey: "target/expired.png", Status: model.ResourceOffloadStatusProcessing,
		ExpiresAt: time.Now().Add(-time.Minute), NextAttemptAt: time.Now(), LeaseOwner: "worker-1",
		CreatedAt: time.Now().Add(-6 * time.Hour), UpdatedAt: time.Now(),
	}
	if err := db.Create(job).Error; err != nil {
		t.Fatal(err)
	}
	s.expireResourceOffloadJob(job, "worker-1")
	var saved model.Resource
	if err := db.First(&saved, "id = ?", resource.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Status != model.ResourceStatusFailed || saved.Error == "" {
		t.Fatalf("expired resource = %+v", saved)
	}
	if _, err := os.Stat(localPath); !os.IsNotExist(err) {
		t.Fatalf("expired local file still exists, stat error=%v", err)
	}
	var savedJob model.ResourceOffloadJob
	if err := db.First(&savedJob, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if savedJob.Status != model.ResourceOffloadStatusExpired || savedJob.LocalDeletedAt == nil {
		t.Fatalf("expired job = %+v", savedJob)
	}
}

func TestExpiredOffloadClaimPrecedesFutureRetry(t *testing.T) {
	s, db := newMediaRecoveryTestService(t)
	now := time.Now()
	job := &model.ResourceOffloadJob{
		ID: "expired-priority-job", UserID: "user-1", ResourceID: "resource-priority", Size: 1,
		LocalObjectKey: "users/user-1/image/priority.png", TargetProvider: "aliyun", TargetObjectKey: "target/priority.png",
		Status: model.ResourceOffloadStatusPending, NextAttemptAt: now.Add(2 * time.Hour), ExpiresAt: now.Add(-time.Minute), CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}
	if err := db.Create(job).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := s.repo.ClaimNextResourceOffloadJob("worker-priority", resourceOffloadLease, now.Add(-generatedMediaLocalRetention))
	if err != nil || claimed == nil || claimed.ID != job.ID || claimed.Status != model.ResourceOffloadStatusProcessing {
		t.Fatalf("expired job claim = %#v, %v; want expired job claimed despite future retry", claimed, err)
	}
}

func TestMediaStagingRemovesExpiredUnreferencedFiles(t *testing.T) {
	s, db := newMediaRecoveryTestService(t)
	dir := filepath.Join(s.dataDir, "media-staging")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, age time.Duration) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("staged"), 0o600); err != nil {
			t.Fatal(err)
		}
		modified := time.Now().Add(-age)
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
		return path
	}
	fresh := write("result-fresh", time.Hour)
	expired := write("result-expired", 25*time.Hour)
	retained := write("result-retained", 25*time.Hour)
	tooOld := write("result-too-old", 8*24*time.Hour)

	task := seedMediaTask(t, db, providerConfig{})
	checkpoint := &mediaCheckpoint{Mode: "image", StartedAt: time.Now(), Items: []mediaCheckpointItem{{TempName: "result-retained"}, {TempName: "result-too-old"}}}
	if err := s.saveMediaCheckpoint(task, checkpoint, "upload"); err != nil {
		t.Fatal(err)
	}

	file, err := s.newMediaTemp(1024)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	_ = os.Remove(file.Name())

	for path, wantExists := range map[string]bool{fresh: true, expired: false, retained: true, tooOld: false} {
		_, statErr := os.Stat(path)
		if exists := statErr == nil; exists != wantExists {
			t.Fatalf("%s exists=%v, want %v (stat error %v)", filepath.Base(path), exists, wantExists, statErr)
		}
	}
}
