package platform

import (
	"context"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// loopPanicRestartDelay 是后台循环 panic 后重新启动前的等待时间，避免同一个缺陷高频刷日志。
const loopPanicRestartDelay = 5 * time.Second

// RunRecovered 执行 fn 并兜住 panic。后台 goroutine 不在 Gin 的 Recovery 保护范围内，
// 未恢复的 panic 会让整个进程退出，连带中断所有 SSE、WebSocket 与执行中的任务。
func RunRecovered(scope string, fn func()) (panicked bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			panicked = true
			slog.Error("background goroutine panic recovered", "scope", scope, "panic", recovered, "stack", string(debug.Stack()))
		}
	}()
	fn()
	return false
}

type Worker struct {
	mu          sync.Mutex
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	started     bool
	draining    atomic.Bool
	activeTasks atomic.Int64
}

func (r *Worker) Start() (context.Context, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return r.ctx, false
	}
	r.ctx, r.cancel = context.WithCancel(context.Background())
	r.started = true
	r.draining.Store(false)
	return r.ctx, true
}

func (r *Worker) GoLoop(fn func(context.Context)) bool {
	r.mu.Lock()
	if !r.started || r.draining.Load() {
		r.mu.Unlock()
		return false
	}
	ctx := r.ctx
	r.wg.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.wg.Done()
		// 循环体 panic 后退避重启；正常返回（通常是 ctx 结束）时退出。
		for RunRecovered("worker_loop", func() { fn(ctx) }) {
			timer := time.NewTimer(loopPanicRestartDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return true
}

func (r *Worker) GoTask(fn func()) bool {
	r.mu.Lock()
	if !r.started || r.draining.Load() {
		r.mu.Unlock()
		return false
	}
	r.wg.Add(1)
	r.activeTasks.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.wg.Done()
		defer r.activeTasks.Add(-1)
		RunRecovered("worker_task", fn)
	}()
	return true
}

func (r *Worker) BeginDrain() {
	r.mu.Lock()
	r.draining.Store(true)
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
}

func (r *Worker) Stop(ctx context.Context) error {
	r.BeginDrain()
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		r.mu.Lock()
		r.started = false
		r.ctx = nil
		r.cancel = nil
		r.mu.Unlock()
		return nil
	}
}

func (r *Worker) IsDraining() bool { return r.draining.Load() }

func (r *Worker) ActiveTaskCount() int64 { return r.activeTasks.Load() }
