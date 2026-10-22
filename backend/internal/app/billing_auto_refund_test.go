package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestBillingAutoRefundDefaultsDisabled(t *testing.T) {
	svc := newResourceTestService(t)
	setting, err := svc.billingAutoRefundSetting()
	if err != nil {
		t.Fatal(err)
	}
	if setting.Enabled {
		t.Fatal("自动退回默认必须关闭")
	}
	// 关闭时在读取订单之前就返回；测试库未迁移 billing_orders，若误查询会记录告警但仍返回 0。
	if refunded := svc.autoRefundReviewBilling(t.Context()); refunded != 0 {
		t.Fatalf("关闭时不应退回订单，实际退回 %d", refunded)
	}
}

func TestBillingAutoRefundRequiresAdmin(t *testing.T) {
	svc := newResourceTestService(t)
	if _, err := svc.UpdateBillingAutoRefundSetting(&model.User{ID: "user-1", Role: model.UserRoleUser}, BillingAutoRefundSetting{Enabled: true}); err == nil {
		t.Fatal("非管理员不能修改自动退回")
	}
	setting, err := svc.billingAutoRefundSetting()
	if err != nil {
		t.Fatal(err)
	}
	if setting.Enabled {
		t.Fatal("被拒绝的请求不能写入开关")
	}
}
