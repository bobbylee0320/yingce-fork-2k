package repository

import (
	"errors"
	"strings"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrReferralCodeTaken 表示随机推广码撞上已有记录，调用方换一个码重试。
var ErrReferralCodeTaken = errors.New("referral code taken")

type ReferralStats struct {
	InviteeCount           int64 `json:"inviteeCount"`
	PaidInviteeCount       int64 `json:"paidInviteeCount"`
	CommissionCount        int64 `json:"commissionCount"`
	OrderAmountFen         int64 `json:"orderAmountFen"`
	CommissionMicrocredits int64 `json:"commissionMicrocredits"`
}

type ReferralInviteeRow struct {
	UserID      string    `json:"-"`
	Username    string    `json:"-"`
	DisplayName string    `json:"-"`
	CreatedAt   time.Time `json:"createdAt"`
}

type ReferralCommissionRow struct {
	model.ReferralCommission
	InviterUsername    string `json:"inviterUsername,omitempty"`
	InviterDisplayName string `json:"inviterDisplayName,omitempty"`
	InviteeUsername    string `json:"inviteeUsername,omitempty"`
	InviteeDisplayName string `json:"inviteeDisplayName,omitempty"`
}

func (r *Repository) ReferralProfileByUser(userID string) (*model.ReferralProfile, error) {
	var profile model.ReferralProfile
	if err := r.db.First(&profile, "user_id = ?", userID).Error; err != nil {
		return nil, err
	}
	return &profile, nil
}

func (r *Repository) ReferralProfileByCode(code string) (*model.ReferralProfile, error) {
	var profile model.ReferralProfile
	if err := r.db.First(&profile, "code = ?", code).Error; err != nil {
		return nil, err
	}
	return &profile, nil
}

// CreateReferralProfile 只在用户还没有推广码时写入；并发创建时返回已存在的那一条。
func (r *Repository) CreateReferralProfile(profile *model.ReferralProfile) (*model.ReferralProfile, error) {
	var result *model.ReferralProfile
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var codeOwner int64
		if err := tx.Model(&model.ReferralProfile{}).Where("code = ?", profile.Code).Count(&codeOwner).Error; err != nil {
			return err
		}
		if codeOwner > 0 {
			return ErrReferralCodeTaken
		}
		created := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, DoNothing: true}).Create(profile)
		if created.Error != nil {
			return created.Error
		}
		var stored model.ReferralProfile
		if err := tx.First(&stored, "user_id = ?", profile.UserID).Error; err != nil {
			return err
		}
		result = &stored
		return nil
	})
	return result, err
}

// CreateReferralBinding 写入邀请关系；被邀请人已绑定时保持原归属，返回 false。
func (r *Repository) CreateReferralBinding(binding *model.ReferralBinding) (bool, error) {
	created := r.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "invitee_user_id"}}, DoNothing: true}).Create(binding)
	return created.RowsAffected == 1, created.Error
}

func (r *Repository) ReferralBindingByInvitee(inviteeID string) (*model.ReferralBinding, error) {
	var binding model.ReferralBinding
	if err := r.db.First(&binding, "invitee_user_id = ?", inviteeID).Error; err != nil {
		return nil, err
	}
	return &binding, nil
}

func (r *Repository) ReferralStats(inviterID string) (ReferralStats, error) {
	var stats ReferralStats
	if err := r.db.Model(&model.ReferralBinding{}).Where("inviter_user_id = ?", inviterID).Count(&stats.InviteeCount).Error; err != nil {
		return stats, err
	}
	commissions := r.db.Model(&model.ReferralCommission{}).Where("inviter_user_id = ?", inviterID)
	if err := commissions.Session(&gorm.Session{}).Count(&stats.CommissionCount).Error; err != nil {
		return stats, err
	}
	if err := commissions.Session(&gorm.Session{}).Distinct("invitee_user_id").Count(&stats.PaidInviteeCount).Error; err != nil {
		return stats, err
	}
	var sums struct {
		OrderAmountFen         int64
		CommissionMicrocredits int64
	}
	if err := commissions.Session(&gorm.Session{}).Select("COALESCE(SUM(order_amount_fen), 0) AS order_amount_fen, COALESCE(SUM(commission_microcredits), 0) AS commission_microcredits").Scan(&sums).Error; err != nil {
		return stats, err
	}
	stats.OrderAmountFen = sums.OrderAmountFen
	stats.CommissionMicrocredits = sums.CommissionMicrocredits
	return stats, nil
}

func (r *Repository) ReferralInvitees(inviterID string, limit, offset int) ([]ReferralInviteeRow, int64, error) {
	var total int64
	if err := r.db.Model(&model.ReferralBinding{}).Where("inviter_user_id = ?", inviterID).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []ReferralInviteeRow
	err := r.db.Table("referral_bindings AS b").
		Select("b.invitee_user_id AS user_id, u.username, u.display_name, b.created_at").
		Joins("LEFT JOIN users AS u ON u.id = b.invitee_user_id").
		Where("b.inviter_user_id = ?", inviterID).
		Order("b.created_at DESC").Limit(limit).Offset(offset).Scan(&rows).Error
	return rows, total, err
}

// ReferralCommissions 列出返佣；inviterID 为空时返回全站记录（仅供后台）。
func (r *Repository) ReferralCommissions(inviterID string, limit, offset int) ([]ReferralCommissionRow, int64, error) {
	base := r.db.Model(&model.ReferralCommission{})
	if strings.TrimSpace(inviterID) != "" {
		base = base.Where("inviter_user_id = ?", inviterID)
	}
	var total int64
	if err := base.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	query := r.db.Table("referral_commissions AS c").
		Select("c.*, iu.username AS inviter_username, iu.display_name AS inviter_display_name, eu.username AS invitee_username, eu.display_name AS invitee_display_name").
		Joins("LEFT JOIN users AS iu ON iu.id = c.inviter_user_id").
		Joins("LEFT JOIN users AS eu ON eu.id = c.invitee_user_id")
	if strings.TrimSpace(inviterID) != "" {
		query = query.Where("c.inviter_user_id = ?", inviterID)
	}
	var rows []ReferralCommissionRow
	err := query.Order("c.created_at DESC").Limit(limit).Offset(offset).Scan(&rows).Error
	return rows, total, err
}

// GrantReferralCommission 在同一事务里写返佣记录、积分流水并加余额。
// 订单已返佣时返回 false 且不改动余额，供支付回调和对账重复调用。
func (r *Repository) GrantReferralCommission(commission *model.ReferralCommission, note string) (bool, error) {
	if commission.CommissionMicrocredits <= 0 {
		return false, nil
	}
	granted := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		commission.CreatedAt = now
		created := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "payment_order_id"}}, DoNothing: true}).Create(commission)
		if created.Error != nil {
			return created.Error
		}
		if created.RowsAffected == 0 {
			return nil
		}
		referenceKey := "referral:" + commission.PaymentOrderID
		entry := model.CreditLedgerEntry{
			ID: newRepositoryID(), UserID: commission.InviterUserID, Type: model.CreditLedgerReferral,
			AmountMicrocredits: commission.CommissionMicrocredits, PaymentOrderID: commission.PaymentOrderID,
			ReferenceKey: &referenceKey, Note: note,
		}
		ledger := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "reference_key"}}, DoNothing: true}).Create(&entry)
		if ledger.Error != nil {
			return ledger.Error
		}
		if ledger.RowsAffected == 0 {
			// 返佣记录刚创建却已有同键流水，说明数据不一致；回滚而不是重复加余额。
			return ErrPaymentOrderStateConflict
		}
		account := model.CreditAccount{UserID: commission.InviterUserID}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&account).Error; err != nil {
			return err
		}
		update := tx.Model(&model.CreditAccount{}).
			Where("user_id = ? AND available_microcredits <= ?", commission.InviterUserID, maxPaymentCreditBalance-commission.CommissionMicrocredits).
			Updates(map[string]any{
				"available_microcredits": gorm.Expr("available_microcredits + ?", commission.CommissionMicrocredits),
				"version":                gorm.Expr("version + 1"), "updated_at": now,
			})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return ErrPaymentCreditOverflow
		}
		if err := tx.First(&account, "user_id = ?", commission.InviterUserID).Error; err != nil {
			return err
		}
		if err := tx.Model(&entry).Updates(map[string]any{
			"available_delta_microcredits": commission.CommissionMicrocredits,
			"available_after_microcredits": account.AvailableMicrocredits,
			"reserved_after_microcredits":  account.ReservedMicrocredits,
		}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.ReferralCommission{}).Where("id = ?", commission.ID).Update("ledger_entry_id", entry.ID).Error; err != nil {
			return err
		}
		commission.LedgerEntryID = entry.ID
		granted = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return granted, nil
}
