// 上游调用日志写入（LogAPICall）与视频任务多次轮询日志的合并。

package app

import (
	"errors"
	stdlog "log"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) LogAPICall(log model.ApiCallLog) error {
	if log.ID == "" {
		log.ID = newID()
	}
	if log.CreatedAt.IsZero() {
		log.CreatedAt = time.Now()
	}
	if log.StartedAt.IsZero() {
		log.StartedAt = log.CreatedAt.Add(-time.Duration(log.DurationMs) * time.Millisecond)
	}
	s.estimateCallCost(&log)
	if log.BillingOrderID != "" && log.ProviderRequestID != "" {
		if err := s.repo.UpdateBillingProviderRequestID(log.BillingOrderID, log.ProviderRequestID); err != nil {
			// 账单关联是请求日志的辅助状态，不能因为关联更新失败而丢失
			// 已经发生的上游调用记录。后续由任务/账单对账流程补偿关联。
			stdlog.Printf("provider billing request id update failed: billing_order_id=%s provider_request_id=%s error=%v", log.BillingOrderID, log.ProviderRequestID, err)
		}
	}
	if log.TaskID != "" && (log.RequestKind == "create" || log.RequestKind == "poll" || log.RequestKind == "cancel") {
		stage := log.RequestKind
		var nextPollAt *time.Time
		if stage == "create" && log.Status == model.ApiCallStatusSucceeded && log.ProviderRequestID != "" {
			stage = "accepted"
			delay := 2 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		} else if stage == "poll" {
			delay := 5 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		}
		if err := s.repo.UpdateTaskProviderState(log.TaskID, log.ProviderRequestID, stage, nextPollAt); err != nil {
			// 请求日志本身仍需保留；任务状态可由后续任务收尾或恢复流程
			// 重建，不能让一次状态写失败掩盖真实的上游调用。
			stdlog.Printf("provider task state update failed: task_id=%s provider_request_id=%s error=%v", log.TaskID, log.ProviderRequestID, err)
		}
	}
	if merged, err := s.mergeAsyncMediaAPICallLog(log); err != nil {
		return err
	} else if merged {
		return nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.cachedAPICallLogUsage(log.UserID)
	if err != nil {
		return err
	}
	incomingBytes := int64(len(log.Path) + len(log.Model) + len(log.ProviderRequestID) + len(log.ErrorCode) + len(log.Error) + len(log.UpstreamURL) + len(log.RequestContentType) + len(log.RequestBody) + len(log.ResponseBody))
	if err := validateAPICallLogQuotaWithPolicy(usage, incomingBytes, policy.Resource); err != nil {
		// 超限时丢弃快照，下一次按真实用量重新判断（例如管理员刚归档过历史）。
		delete(s.apiLogUsageCache, log.UserID)
		return err
	}
	if err := s.repo.Create(&log); err != nil {
		return err
	}
	s.noteAPICallLogUsage(log.UserID, incomingBytes)
	return nil
}

// apiLogUsageCacheTTL 是调用日志配额基线允许的最长陈旧时间。
// UserStorageUsage 会汇总该用户全部历史表，每条上游请求都在 storageMu 内重算会让所有用户排队。
const apiLogUsageCacheTTL = 30 * time.Second

// apiLogUsageCacheLimit 限制快照条目数，超过时先清理过期项。
const apiLogUsageCacheLimit = 10_000

type apiLogUsageEntry struct {
	usage repository.UserStorageUsage
	at    time.Time
}

// cachedAPICallLogUsage 返回调用日志配额判断所需的用量；调用方必须持有 storageMu。
// 快照最多陈旧 apiLogUsageCacheTTL，期间由 noteAPICallLogUsage 累加本进程写入的日志。
func (s *Service) cachedAPICallLogUsage(userID string) (repository.UserStorageUsage, error) {
	now := time.Now()
	if entry, ok := s.apiLogUsageCache[userID]; ok && now.Sub(entry.at) < apiLogUsageCacheTTL {
		return entry.usage, nil
	}
	usage, err := s.repo.UserStorageUsage(userID)
	if err != nil {
		return usage, err
	}
	if s.apiLogUsageCache == nil {
		s.apiLogUsageCache = make(map[string]apiLogUsageEntry)
	}
	if len(s.apiLogUsageCache) >= apiLogUsageCacheLimit {
		for key, entry := range s.apiLogUsageCache {
			if now.Sub(entry.at) >= apiLogUsageCacheTTL {
				delete(s.apiLogUsageCache, key)
			}
		}
	}
	s.apiLogUsageCache[userID] = apiLogUsageEntry{usage: usage, at: now}
	return usage, nil
}

// noteAPICallLogUsage 把刚写入的日志计入快照；调用方必须持有 storageMu。
func (s *Service) noteAPICallLogUsage(userID string, bytes int64) {
	entry, ok := s.apiLogUsageCache[userID]
	if !ok {
		return
	}
	entry.usage.APICallCount++
	entry.usage.TaskBytes += bytes
	s.apiLogUsageCache[userID] = entry
}

func (s *Service) mergeAsyncMediaAPICallLog(log model.ApiCallLog) (bool, error) {
	// Delivery is a separate outcome: a failed download must not rewrite a
	// successful generation request as failed.
	if (log.Capability != "video" && log.Capability != "image") || log.RequestKind != "poll" {
		return false, nil
	}
	if log.TaskID == "" && log.ProviderRequestID == "" {
		return false, nil
	}
	root, err := s.repo.AsyncMediaAPICallRoot(log)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if log.RequestKind == "poll" {
		root.PollCount++
		if log.ResponseBody != "" {
			root.ResponseBody = log.ResponseBody
		}
	}
	if log.ProviderRequestID != "" {
		root.ProviderRequestID = log.ProviderRequestID
	}
	if log.ProviderStatus != "" {
		root.ProviderStatus = log.ProviderStatus
	}
	startedAt := root.StartedAt
	if startedAt.IsZero() {
		startedAt = root.CreatedAt.Add(-time.Duration(root.DurationMs) * time.Millisecond)
		root.StartedAt = startedAt
	}
	root.DurationMs = max(root.DurationMs, log.CreatedAt.Sub(startedAt).Milliseconds())
	root.StatusCode = log.StatusCode
	root.ConcurrencyLimit = log.ConcurrencyLimit
	if log.Status == model.ApiCallStatusFailed {
		root.Status = log.Status
		root.ErrorCode = log.ErrorCode
		root.Error = log.Error
	} else {
		root.Status = model.ApiCallStatusSucceeded
		root.ErrorCode = ""
		root.Error = ""
	}
	if log.UsageAvailable {
		root.UsageAvailable = true
		root.InputTokens = log.InputTokens
		root.OutputTokens = log.OutputTokens
		root.CachedTokens = log.CachedTokens
	}
	return true, s.repo.Save(root)
}

func (s *Service) APICallLogs(actor *model.User, limit int) ([]model.ApiCallLog, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.ApiCallLogs(actor.ID, actor.Role == model.UserRoleAdmin, limit)
}
