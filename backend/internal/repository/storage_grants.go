package repository

import (
	"errors"
	"strings"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrStorageGrantNotFound = errors.New("扩容记录不存在")

// activeStorageGrants 只筛选当前生效的记录：未撤销、已开始且未过期。
func activeStorageGrants(db *gorm.DB, userID string, now time.Time) *gorm.DB {
	return db.Model(&model.UserStorageGrant{}).
		Where("user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)", userID, now, now)
}

// UserStorageGrantSummary 返回当前生效的扩容总量和最近一条到期时间。
func (r *Repository) UserStorageGrantSummary(userID string, now time.Time) (int64, *time.Time, error) {
	var row struct {
		Total      int64
		NextExpiry *time.Time
	}
	if err := activeStorageGrants(r.db, userID, now).Select("COALESCE(SUM(bytes), 0) AS total").Scan(&row).Error; err != nil {
		return 0, nil, err
	}
	var next model.UserStorageGrant
	err := activeStorageGrants(r.db, userID, now).Where("expires_at IS NOT NULL").Order("expires_at asc").Limit(1).Find(&next).Error
	if err != nil {
		return 0, nil, err
	}
	if next.ID != "" {
		row.NextExpiry = next.ExpiresAt
	}
	return row.Total, row.NextExpiry, nil
}

func (r *Repository) UserStorageGrants(userID string, limit int) ([]model.UserStorageGrant, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	var items []model.UserStorageGrant
	err := r.db.Where("user_id = ?", userID).Order("created_at desc, id desc").Limit(limit).Find(&items).Error
	return items, err
}

func (r *Repository) CreateUserStorageGrant(grant *model.UserStorageGrant) error {
	return r.db.Create(grant).Error
}

func (r *Repository) RevokeUserStorageGrant(id, actorID, reason string, now time.Time) (*model.UserStorageGrant, error) {
	var grant model.UserStorageGrant
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&grant, "id = ?", strings.TrimSpace(id)).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrStorageGrantNotFound
			}
			return err
		}
		if grant.RevokedAt != nil {
			return nil
		}
		if err := tx.Model(&model.UserStorageGrant{}).Where("id = ?", grant.ID).Updates(map[string]any{
			"revoked_at": &now, "revoked_by": actorID, "revoke_reason": reason,
		}).Error; err != nil {
			return err
		}
		return tx.First(&grant, "id = ?", grant.ID).Error
	})
	if err != nil {
		return nil, err
	}
	return &grant, nil
}

func (r *Repository) UserStorageState(userID string) (*model.UserStorageState, error) {
	var state model.UserStorageState
	err := r.db.Where("user_id = ?", userID).Limit(1).Find(&state).Error
	if err != nil {
		return nil, err
	}
	if state.UserID == "" {
		return nil, nil
	}
	return &state, nil
}

// MarkUserStorageOverLimit 只在尚未记录时写入起点，保证并发观察不会推迟宽限期。
func (r *Repository) MarkUserStorageOverLimit(userID string, since time.Time) (*model.UserStorageState, error) {
	state := model.UserStorageState{UserID: userID, OverLimitSince: &since, UpdatedAt: since}
	if err := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&state).Error; err != nil {
		return nil, err
	}
	if err := r.db.Model(&model.UserStorageState{}).Where("user_id = ? AND over_limit_since IS NULL", userID).
		Updates(map[string]any{"over_limit_since": &since, "updated_at": since}).Error; err != nil {
		return nil, err
	}
	return r.UserStorageState(userID)
}

func (r *Repository) ClearUserStorageOverLimit(userID string, now time.Time) error {
	return r.db.Model(&model.UserStorageState{}).Where("user_id = ? AND over_limit_since IS NOT NULL", userID).
		Updates(map[string]any{"over_limit_since": nil, "updated_at": now}).Error
}
