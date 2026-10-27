package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

const billingAutoRefundSettingKey = "billing_auto_refund"

// billingAutoRefundInterval 控制自动退回的扫描频率；每轮最多处理一页，避免单轮长事务。
const (
	billingAutoRefundInterval = time.Minute
	billingAutoRefundBatch    = 100
	billingAutoRefundNote     = "系统自动退回：已开启冻结积分自动退回"
)

// BillingAutoRefundSetting 是积分运营页的“自动退回”开关。默认关闭：
// 待核对订单可能已在上游产生费用，只有管理员明确开启后才自动释放冻结积分。
type BillingAutoRefundSetting struct {
	Enabled   bool       `json:"enabled"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
}

func (s *Service) billingAutoRefundSetting() (BillingAutoRefundSetting, error) {
	setting, err := s.repo.SystemSetting(billingAutoRefundSettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return BillingAutoRefundSetting{}, nil
	}
	if err != nil {
		return BillingAutoRefundSetting{}, err
	}
	var value BillingAutoRefundSetting
	if json.Unmarshal([]byte(setting.ValueJSON), &value) != nil {
		return BillingAutoRefundSetting{}, errors.New("自动退回配置格式无效")
	}
	updatedAt := setting.UpdatedAt
	value.UpdatedAt = &updatedAt
	return value, nil
}

func (s *Service) AdminBillingAutoRefundSetting(actor *model.User) (BillingAutoRefundSetting, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return BillingAutoRefundSetting{}, err
	}
	return s.billingAutoRefundSetting()
}

func (s *Service) UpdateBillingAutoRefundSetting(actor *model.User, req BillingAutoRefundSetting) (BillingAutoRefundSetting, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return BillingAutoRefundSetting{}, err
	}
	encoded, err := json.Marshal(BillingAutoRefundSetting{Enabled: req.Enabled})
	if err != nil {
		return BillingAutoRefundSetting{}, err
	}
	setting := model.SystemSetting{Key: billingAutoRefundSettingKey, ValueJSON: string(encoded), UpdatedBy: actor.ID}
	current, err := s.repo.SystemSetting(billingAutoRefundSettingKey)
	if err == nil {
		setting.CreatedAt = current.CreatedAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return BillingAutoRefundSetting{}, err
	}
	if err := s.repo.SaveSystemSetting(&setting); err != nil {
		return BillingAutoRefundSetting{}, err
	}
	summary := "关闭冻结积分自动退回"
	if req.Enabled {
		summary = "开启冻结积分自动退回"
	}
	if err := s.appendAdminAudit(actor, "billing_auto_refund.update", "system_setting", billingAutoRefundSettingKey, summary, map[string]any{"enabled": req.Enabled}); err != nil {
		return BillingAutoRefundSetting{}, err
	}
	if req.Enabled {
		// 开启后立即跑一轮，不必等下一个扫描周期。
		s.runWorkerTask(func() { s.autoRefundReviewBilling(context.Background()) })
	}
	return s.billingAutoRefundSetting()
}

func (s *Service) startBillingAutoRefundWorker() {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(billingAutoRefundInterval)
		defer ticker.Stop()
		for {
			s.autoRefundReviewBilling(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}

// autoRefundReviewBilling 退回“待核对队列”中的冻结积分。队列口径与管理员页面一致
// （待核对、运行超时、任务已失败/取消但仍预授权），但排除上游已确认生成作品的订单：
// 这类订单要等作品交付后结算，或由管理员人工处理，自动退款会让作品白送。
// 每轮重新读取开关，关闭后下一轮立即停止。
func (s *Service) autoRefundReviewBilling(ctx context.Context) int {
	setting, err := s.billingAutoRefundSetting()
	if err != nil {
		slog.Warn("billing auto refund setting load failed", "error", err)
		return 0
	}
	if !setting.Enabled {
		return 0
	}
	orders, err := s.repo.AutoRefundableBillingOrders(billingAutoRefundBatch)
	if err != nil {
		slog.Warn("billing auto refund query failed", "error", err)
		return 0
	}
	refunded := 0
	for _, order := range orders {
		if ctx.Err() != nil {
			break
		}
		if order.Status != model.BillingStatusUncertain && order.Status != model.BillingStatusRunning && order.Status != model.BillingStatusReserved {
			continue
		}
		if err := s.RefundBilling(order.ID, billingAutoRefundNote); err != nil {
			slog.Warn("billing auto refund failed", "orderId", order.ID, "error", err)
			continue
		}
		if err := s.repo.RecordBillingResolution(order.ID, "", billingAutoRefundNote); err != nil {
			slog.Warn("billing auto refund resolution record failed", "orderId", order.ID, "error", err)
		}
		refunded++
	}
	return refunded
}
