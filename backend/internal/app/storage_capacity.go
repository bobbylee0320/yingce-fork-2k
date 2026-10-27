// 账号文件容量：全局基础容量 + 已购扩容，以及超额后的宽限期与只读判定。

package app

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

const (
	// 超出容量后先只拦截新上传和生成；宽限期结束后账号进入只读。
	storageOverLimitGracePeriod = 7 * 24 * time.Hour
	// 单账号有效容量上限，防止扩容记录累加溢出或误配置。
	maxUserStoredFileBytes = int64(1) << 50
	maxStorageGrantBytes   = int64(100_000) << 30
	maxStorageGrantDays    = 3650
	storageStatusCacheTTL  = 15 * time.Second
	storageStatusCacheSize = 4096
)

type AccountFileStorageUsage struct {
	UsedBytes      int64      `json:"usedBytes"`
	TotalBytes     int64      `json:"totalBytes"`
	BaseBytes      int64      `json:"baseBytes"`
	PurchasedBytes int64      `json:"purchasedBytes"`
	NextExpiresAt  *time.Time `json:"nextExpiresAt,omitempty"`
	OverLimit      bool       `json:"overLimit"`
	OverLimitSince *time.Time `json:"overLimitSince,omitempty"`
	ReadOnlyAt     *time.Time `json:"readOnlyAt,omitempty"`
	ReadOnly       bool       `json:"readOnly"`
}

type storageStatusEntry struct {
	value   AccountFileStorageUsage
	expires time.Time
}

type AdminStorageGrantRequest struct {
	Bytes        int64  `json:"bytes"`
	DurationDays int    `json:"durationDays"`
	Note         string `json:"note"`
}

type RevokeStorageGrantRequest struct {
	Reason string `json:"reason"`
}

func validStorageGrantSize(bytes int64, days int) error {
	if bytes <= 0 || bytes > maxStorageGrantBytes || bytes%(int64(1)<<30) != 0 {
		return BadAuthRequest("扩容容量必须是 1-100000 GB 的整数")
	}
	if days < 0 || days > maxStorageGrantDays {
		return BadAuthRequest(fmt.Sprintf("扩容有效期必须是 0-%d 天（0 表示永久）", maxStorageGrantDays))
	}
	return nil
}

// storedFileLimit 是所有账号文件容量判断的唯一入口。
func (s *Service) storedFileLimit(userID string, policy RuntimePolicySetting) (int64, error) {
	base := gigabytes(policy.Resource.StoredFileGB)
	purchased, _, err := s.repo.UserStorageGrantSummary(userID, time.Now())
	if err != nil {
		return 0, err
	}
	return capStoredFileLimit(base + purchased), nil
}

func capStoredFileLimit(value int64) int64 {
	if value < 0 || value > maxUserStoredFileBytes {
		return maxUserStoredFileBytes
	}
	return value
}

// AccountFileStorageUsage 总是实时计算并刷新只读判定缓存，用户清理或扩容后刷新用量即可解除限制。
func (s *Service) AccountFileStorageUsage(userID string) (*AccountFileStorageUsage, error) {
	usage, err := s.computeAccountStorageStatus(userID, time.Now(), true)
	if err != nil {
		return nil, err
	}
	s.storeStorageStatus(userID, *usage)
	return usage, nil
}

// computeAccountStorageStatus 在 observe=true 时记录或清除超额起点；管理端查看只读不写。
func (s *Service) computeAccountStorageStatus(userID string, now time.Time, observe bool) (*AccountFileStorageUsage, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	used, err := s.repo.UserStoredFileBytes(userID)
	if err != nil {
		return nil, err
	}
	purchased, nextExpiry, err := s.repo.UserStorageGrantSummary(userID, now)
	if err != nil {
		return nil, err
	}
	base := gigabytes(policy.Resource.StoredFileGB)
	usage := &AccountFileStorageUsage{
		UsedBytes: used, BaseBytes: base, PurchasedBytes: purchased,
		TotalBytes: capStoredFileLimit(base + purchased), NextExpiresAt: nextExpiry,
	}
	usage.OverLimit = usage.UsedBytes > usage.TotalBytes
	state, err := s.repo.UserStorageState(userID)
	if err != nil {
		return nil, err
	}
	if !usage.OverLimit {
		if observe && state != nil && state.OverLimitSince != nil {
			if err := s.repo.ClearUserStorageOverLimit(userID, now); err != nil {
				return nil, err
			}
		}
		return usage, nil
	}
	if (state == nil || state.OverLimitSince == nil) && observe {
		if state, err = s.repo.MarkUserStorageOverLimit(userID, now); err != nil {
			return nil, err
		}
	}
	if state != nil && state.OverLimitSince != nil {
		since := *state.OverLimitSince
		readOnlyAt := since.Add(storageOverLimitGracePeriod)
		usage.OverLimitSince = &since
		usage.ReadOnlyAt = &readOnlyAt
		usage.ReadOnly = !now.Before(readOnlyAt)
	}
	return usage, nil
}

func (s *Service) cachedStorageStatus(userID string) (AccountFileStorageUsage, error) {
	now := time.Now()
	s.storageStatusMu.Lock()
	entry, ok := s.storageStatusCache[userID]
	s.storageStatusMu.Unlock()
	if ok && now.Before(entry.expires) {
		return entry.value, nil
	}
	usage, err := s.computeAccountStorageStatus(userID, now, true)
	if err != nil {
		return AccountFileStorageUsage{}, err
	}
	s.storeStorageStatus(userID, *usage)
	return *usage, nil
}

func (s *Service) storeStorageStatus(userID string, value AccountFileStorageUsage) {
	s.storageStatusMu.Lock()
	defer s.storageStatusMu.Unlock()
	if s.storageStatusCache == nil || len(s.storageStatusCache) >= storageStatusCacheSize {
		s.storageStatusCache = make(map[string]storageStatusEntry)
	}
	s.storageStatusCache[userID] = storageStatusEntry{value: value, expires: time.Now().Add(storageStatusCacheTTL)}
}

func (s *Service) invalidateStorageStatus(userID string) {
	s.storageStatusMu.Lock()
	defer s.storageStatusMu.Unlock()
	delete(s.storageStatusCache, userID)
}

// RequireStorageWritable 供只读守卫调用：宽限期结束仍超额时拒绝内容写入。
func (s *Service) RequireStorageWritable(userID string) error {
	if strings.TrimSpace(userID) == "" {
		return nil
	}
	usage, err := s.cachedStorageStatus(userID)
	if err != nil {
		return err
	}
	if !usage.ReadOnly {
		return nil
	}
	details := map[string]any{"usedBytes": usage.UsedBytes, "totalBytes": usage.TotalBytes}
	if usage.ReadOnlyAt != nil {
		details["readOnlyAt"] = usage.ReadOnlyAt.UTC().Format(time.RFC3339)
	}
	return kernel.StorageReadOnly(fmt.Sprintf("账号文件已超出 %s 容量且宽限期已结束，当前为只读状态。请删除素材腾出空间或购买存储空间", formatStorageLimit(usage.TotalBytes)), details)
}

func (s *Service) UserStorageGrants(actor *model.User) ([]model.UserStorageGrant, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.UserStorageGrants(actor.ID, 100)
}

type AdminUserStorage struct {
	Usage  AccountFileStorageUsage  `json:"usage"`
	Grants []model.UserStorageGrant `json:"grants"`
}

func (s *Service) AdminUserStorage(actor *model.User, userID string) (*AdminUserStorage, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	user, err := s.repo.User(strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	usage, err := s.computeAccountStorageStatus(user.ID, time.Now(), false)
	if err != nil {
		return nil, err
	}
	grants, err := s.repo.UserStorageGrants(user.ID, 200)
	if err != nil {
		return nil, err
	}
	return &AdminUserStorage{Usage: *usage, Grants: grants}, nil
}

func (s *Service) AdminGrantUserStorage(actor *model.User, userID string, request AdminStorageGrantRequest) (*model.UserStorageGrant, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	user, err := s.repo.User(strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	if err := validStorageGrantSize(request.Bytes, request.DurationDays); err != nil {
		return nil, err
	}
	now := time.Now()
	grant := &model.UserStorageGrant{
		ID: newID(), UserID: user.ID, Source: model.UserStorageGrantSourceAdmin,
		Bytes: request.Bytes, DurationDays: request.DurationDays, StartsAt: now,
		Note: truncateRunes(strings.TrimSpace(request.Note), 500), CreatedBy: actor.ID, CreatedAt: now,
	}
	if request.DurationDays > 0 {
		expires := now.Add(time.Duration(request.DurationDays) * 24 * time.Hour)
		grant.ExpiresAt = &expires
	}
	if err := s.repo.CreateUserStorageGrant(grant); err != nil {
		return nil, err
	}
	s.invalidateStorageStatus(user.ID)
	if err := s.appendAdminAudit(actor, "storage_grant.create", "user", user.ID, "赠送存储空间", map[string]any{"grantId": grant.ID, "bytes": grant.Bytes, "durationDays": grant.DurationDays}); err != nil {
		return nil, err
	}
	return grant, nil
}

func (s *Service) AdminRevokeUserStorageGrant(actor *model.User, grantID string, request RevokeStorageGrantRequest) (*model.UserStorageGrant, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	reason := truncateRunes(strings.TrimSpace(request.Reason), 500)
	if reason == "" {
		return nil, BadAuthRequest("请填写撤销原因")
	}
	grant, err := s.repo.RevokeUserStorageGrant(grantID, actor.ID, reason, time.Now())
	if errors.Is(err, repository.ErrStorageGrantNotFound) {
		return nil, NotFound(err.Error())
	}
	if err != nil {
		return nil, err
	}
	s.invalidateStorageStatus(grant.UserID)
	if err := s.appendAdminAudit(actor, "storage_grant.revoke", "user", grant.UserID, "撤销存储空间", map[string]any{"grantId": grant.ID, "bytes": grant.Bytes, "reason": reason}); err != nil {
		return nil, err
	}
	return grant, nil
}

// afterStorageOrderGranted 让本实例的只读判定立即看到新容量；其它实例依赖短 TTL。
func (s *Service) afterStorageOrderGranted(order *model.PaymentOrder) {
	if order == nil || order.ProductKind != model.TopupProductKindStorage || order.Status != model.PaymentOrderCredited {
		return
	}
	s.invalidateStorageStatus(order.UserID)
	slog.Info("storage grant applied", "user", order.UserID, "order", order.ID, "bytes", order.StorageBytes, "days", order.StorageDurationDays)
}
