package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newReferralTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.SystemSetting{}, &model.ReferralProfile{}, &model.ReferralBinding{}, &model.ReferralCommission{}, &model.CreditAccount{}, &model.CreditLedgerEntry{}); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func saveReferralTestSetting(t *testing.T, db *gorm.DB, setting ReferralSetting) {
	t.Helper()
	encoded, _ := json.Marshal(setting)
	if err := db.Save(&model.SystemSetting{Key: referralSettingKey, ValueJSON: string(encoded)}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestReferralBindAndCommissionIsIdempotent(t *testing.T) {
	s, db := newReferralTestService(t)
	saveReferralTestSetting(t, db, ReferralSetting{Enabled: true, Mode: ReferralModeAll, CommissionRateBasisPoints: 1_000})
	inviter := &model.User{ID: "inviter", Username: "inviter", DisplayName: "推广者", Role: model.UserRoleUser, Status: model.UserStatusActive}
	invitee := &model.User{ID: "invitee", Username: "invitee", DisplayName: "新用户", Role: model.UserRoleUser, Status: model.UserStatusActive}
	if err := db.Create([]*model.User{inviter, invitee}).Error; err != nil {
		t.Fatal(err)
	}
	overview, err := s.ReferralOverview(inviter)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Code) != referralCodeLength {
		t.Fatalf("unexpected code %q", overview.Code)
	}
	s.bindReferral(invitee.ID, " "+overview.Code+" ")
	s.bindReferral(inviter.ID, overview.Code) // 自己的码不能绑定自己
	order := &model.PaymentOrder{ID: "order-1", UserID: invitee.ID, Status: model.PaymentOrderCredited, ProductKind: model.TopupProductKindCredits, AmountFen: 1000, CreditsMicrocredits: 100 * CreditScale}
	s.grantReferralCommission(order)
	s.grantReferralCommission(order)
	var account model.CreditAccount
	if err := db.First(&account, "user_id = ?", inviter.ID).Error; err != nil {
		t.Fatal(err)
	}
	if account.AvailableMicrocredits != 10*CreditScale {
		t.Fatalf("commission = %d, want %d", account.AvailableMicrocredits, 10*CreditScale)
	}
	stats, err := s.ReferralOverview(inviter)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Stats.InviteeCount != 1 || stats.Stats.CommissionCount != 1 || stats.Stats.PaidInviteeCount != 1 || stats.Stats.OrderAmountFen != 1000 || stats.Stats.CommissionMicrocredits != 10*CreditScale {
		t.Fatalf("unexpected stats %#v", stats.Stats)
	}
	invitees, err := s.ReferralInvitees(inviter, 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(invitees.Invitees) != 1 || invitees.Invitees[0].Name != "新**" {
		t.Fatalf("invitee name must be masked: %#v", invitees.Invitees)
	}
	var ledger model.CreditLedgerEntry
	if err := db.First(&ledger, "user_id = ? AND type = ?", inviter.ID, model.CreditLedgerReferral).Error; err != nil {
		t.Fatal(err)
	}
	if ledger.AvailableAfterMicrocredits != 10*CreditScale {
		t.Fatalf("ledger after = %d", ledger.AvailableAfterMicrocredits)
	}
}

func TestReferralAssignedModeRequiresPromoter(t *testing.T) {
	s, db := newReferralTestService(t)
	saveReferralTestSetting(t, db, ReferralSetting{Enabled: true, Mode: ReferralModeAssigned, CommissionRateBasisPoints: 2_000})
	normal := &model.User{ID: "normal", Username: "normal", Status: model.UserStatusActive}
	promoter := &model.User{ID: "promoter", Username: "promoter", Status: model.UserStatusActive, IsPromoter: true}
	invitee := &model.User{ID: "invitee", Username: "invitee", Status: model.UserStatusActive}
	if err := db.Create([]*model.User{normal, promoter, invitee}).Error; err != nil {
		t.Fatal(err)
	}
	if available, _ := s.ReferralAvailable(normal); available {
		t.Fatal("normal user must not see referral center in assigned mode")
	}
	if _, err := s.ReferralOverview(normal); err == nil {
		t.Fatal("normal user overview must be forbidden")
	}
	overview, err := s.ReferralOverview(promoter)
	if err != nil {
		t.Fatal(err)
	}
	s.bindReferral(invitee.ID, overview.Code)
	// 推广人资格被取消后，新订单不再返佣。
	if err := db.Model(&model.User{}).Where("id = ?", promoter.ID).Update("is_promoter", false).Error; err != nil {
		t.Fatal(err)
	}
	s.grantReferralCommission(&model.PaymentOrder{ID: "order-2", UserID: invitee.ID, Status: model.PaymentOrderCredited, ProductKind: model.TopupProductKindCredits, AmountFen: 500, CreditsMicrocredits: 50 * CreditScale})
	var count int64
	db.Model(&model.ReferralCommission{}).Count(&count)
	if count != 0 {
		t.Fatalf("revoked promoter got %d commissions", count)
	}
}

func TestReferralCommissionAmountAvoidsOverflow(t *testing.T) {
	if got := referralCommissionAmount(9_000_000_000_000_000, 5_000); got != 4_500_000_000_000_000 {
		t.Fatalf("got %d", got)
	}
	if got := referralCommissionAmount(12_345, 1_000); got != 1_234 {
		t.Fatalf("got %d", got)
	}
}
