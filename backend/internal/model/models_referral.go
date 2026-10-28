package model

import "time"

// ReferralProfile 保存用户的推广码；首次打开推广中心时生成，之后不变。
type ReferralProfile struct {
	UserID    string    `json:"userId" gorm:"primaryKey;size:36"`
	Code      string    `json:"code" gorm:"uniqueIndex;size:16;not null"`
	CreatedAt time.Time `json:"createdAt"`
}

// ReferralBinding 记录被邀请人归属；一个账号只能绑定一次，注册时写入。
type ReferralBinding struct {
	InviteeUserID string    `json:"inviteeUserId" gorm:"primaryKey;size:36"`
	InviterUserID string    `json:"inviterUserId" gorm:"size:36;not null;index:idx_referral_binding_inviter_created,priority:1"`
	Code          string    `json:"code" gorm:"size:16"`
	CreatedAt     time.Time `json:"createdAt" gorm:"index:idx_referral_binding_inviter_created,priority:2"`
}

// ReferralCommission 是一笔充值订单产生的推广返佣；PaymentOrderID 唯一，保证同一订单只返佣一次。
type ReferralCommission struct {
	ID                       string    `json:"id" gorm:"primaryKey;size:36"`
	InviterUserID            string    `json:"inviterUserId" gorm:"size:36;not null;index:idx_referral_commission_inviter_created,priority:1"`
	InviteeUserID            string    `json:"inviteeUserId" gorm:"size:36;not null;index"`
	PaymentOrderID           string    `json:"paymentOrderId" gorm:"size:36;not null;uniqueIndex"`
	OrderAmountFen           int64     `json:"orderAmountFen"`
	OrderCreditsMicrocredits int64     `json:"orderCreditsMicrocredits"`
	RateBasisPoints          int64     `json:"rateBasisPoints"`
	CommissionMicrocredits   int64     `json:"commissionMicrocredits"`
	LedgerEntryID            string    `json:"ledgerEntryId" gorm:"size:36"`
	CreatedAt                time.Time `json:"createdAt" gorm:"index:idx_referral_commission_inviter_created,priority:2"`
}
