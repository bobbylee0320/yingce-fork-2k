package app

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mattn/go-sqlite3"
	"yingce/backend/internal/storage"
)

func TestOSSUploadLimiterAdaptsToThrottlingAndRecovery(t *testing.T) {
	limiter := newOSSUploadLimiter()
	if got := limiter.concurrency(); got != ossUploadInitialConcurrency {
		t.Fatalf("initial concurrency = %d, want %d", got, ossUploadInitialConcurrency)
	}
	if err := limiter.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	limiter.release(&storage.HTTPStatusError{StatusCode: http.StatusServiceUnavailable})
	if got := limiter.concurrency(); got != ossUploadMinConcurrency {
		t.Fatalf("after throttling concurrency = %d, want %d", got, ossUploadMinConcurrency)
	}
	for i := 0; i < ossUploadStableSuccesses; i++ {
		if err := limiter.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		limiter.release(nil)
	}
	if got := limiter.concurrency(); got != 2 {
		t.Fatalf("after stable recovery concurrency = %d, want 2", got)
	}
	for i := 0; i < ossUploadStableSuccesses*10; i++ {
		if err := limiter.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		limiter.release(nil)
	}
	if got := limiter.concurrency(); got != ossUploadMaxConcurrency {
		t.Fatalf("stable concurrency = %d, want max %d", got, ossUploadMaxConcurrency)
	}
	if err := limiter.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	limiter.release(&storage.HTTPStatusError{StatusCode: http.StatusTooManyRequests})
	if got := limiter.concurrency(); got != ossUploadMaxConcurrency/2 {
		t.Fatalf("throttle decrease from max = %d", got)
	}
}

func TestOSSUploadLimiterEnforcesCurrentConcurrency(t *testing.T) {
	limiter := newOSSUploadLimiter()
	for i := 0; i < ossUploadInitialConcurrency; i++ {
		if err := limiter.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := limiter.acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("third upload should wait at concurrency 2, got %v", err)
	}
	limiter.release(nil)
	if err := limiter.acquire(context.Background()); err != nil {
		t.Fatalf("upload slot was not released: %v", err)
	}
	limiter.release(nil)
	limiter.release(nil)
}

func TestMediaStagingBudgetAndDiskHeadroom(t *testing.T) {
	if mediaStagingBudget != 2<<30 || mediaStagingMinFreeBytes != 5<<30 {
		t.Fatalf("budget/free floor = %d/%d", mediaStagingBudget, mediaStagingMinFreeBytes)
	}
	if !mediaStagingCapacityAvailable(7<<30, 2<<30, true, true) {
		t.Fatal("exactly 5 GiB remaining should be accepted")
	}
	if mediaStagingCapacityAvailable((7<<30)-1, 2<<30, true, true) {
		t.Fatal("reservation that leaves less than 5 GiB should wait")
	}
	if mediaStagingCapacityAvailable(8<<30, mediaStagingBudget+1, true, true) {
		t.Fatal("reservation larger than budget should be rejected")
	}
	if mediaStagingCapacityAvailable(8<<30, 1, false, true) || mediaStagingCapacityAvailable(8<<30, 1, true, false) {
		t.Fatal("unavailable or unwritable disk must wait")
	}
}

func TestMediaStagingWaitsWhenDiskFloorWouldBeCrossed(t *testing.T) {
	service := &Service{dataDir: t.TempDir()}
	disk := func() SystemPerformanceDisk {
		return SystemPerformanceDisk{Available: true, Writable: true, FreeBytes: uint64((5 << 30) + (1 << 20))}
	}
	if _, err := service.newMediaTempWithDisk(2<<20, disk); err == nil {
		t.Fatal("staging allocation crossed the 5 GiB free-space floor")
	} else if !errors.Is(err, errMediaStagingFull) {
		t.Fatalf("expected staging wait, got %v", err)
	}
}

func TestMediaUploadRetryBackoffCaps(t *testing.T) {
	if got := mediaUploadRetryDelay(1); got != 15*time.Second {
		t.Fatalf("first retry delay = %s", got)
	}
	if got := mediaUploadRetryDelay(99); got != time.Hour {
		t.Fatalf("capped retry delay = %s", got)
	}
	if got := mediaRegistrationRetryDelay(1); got != 5*time.Second {
		t.Fatalf("first registration retry delay = %s", got)
	}
}

func TestTransientMediaRegistrationClassification(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "connection closed", err: sql.ErrConnDone, want: true},
		{name: "postgres serialization", err: &pgconn.PgError{Code: "40001"}, want: true},
		{name: "postgres connection", err: &pgconn.PgError{Code: "08006"}, want: true},
		{name: "sqlite busy", err: sqlite3.Error{Code: sqlite3.ErrBusy}, want: true},
		{name: "sqlite locked", err: sqlite3.Error{Code: sqlite3.ErrLocked}, want: true},
		{name: "constraint", err: &pgconn.PgError{Code: "23505"}, want: false},
		{name: "validation", err: errors.New("resource ownership mismatch"), want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := transientMediaRegistrationError(tc.err); got != tc.want {
				t.Fatalf("retryable = %v, want %v", got, tc.want)
			}
		})
	}
}
