// 推广中心：推广码、注册归属和充值返佣。
//
// 开放方式由系统设置 referral 决定：all 表示所有正常账号都能推广；assigned 表示只有
// 管理员标记为推广人的账号能看到入口、生成链接和获得返佣。归属在注册时一次写入；
// 返佣在积分充值订单入账后按当时的设置和推广人资格计算，以订单 ID 去重。

package app

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	stdlog "log"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	referralSettingKey           = "referral"
	ReferralModeAll              = "all"
	ReferralModeAssigned         = "assigned"
	referralMaxRateBasisPoints   = 5_000
	referralCodeLength           = 8
	referralCodeAlphabet         = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	referralCodeCreateMaxAttempt = 5
)

type ReferralSetting struct {
	Enabled                   bool   `json:"enabled"`
	Mode                      string `json:"mode"`
	CommissionRateBasisPoints int64  `json:"commissionRateBasisPoints"`
}

type ReferralOverview struct {
	Code                      string                   `json:"code"`
	Mode                      string                   `json:"mode"`
	CommissionRateBasisPoints int64                    `json:"commissionRateBasisPoints"`
	Stats                     repository.ReferralStats `json:"stats"`
}

type ReferralInvitee struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type ReferralInviteePage struct {
	Invitees []ReferralInvitee `json:"invitees"`
	Total    int64             `json:"total"`
	Page     int               `json:"page"`
	PageSize int               `json:"pageSize"`
}

type ReferralCommissionView struct {
	ID                       string    `json:"id"`
	InviterUserID            string    `json:"inviterUserId,omitempty"`
	InviterName              string    `json:"inviterName,omitempty"`
	InviteeName              string    `json:"inviteeName"`
	OrderAmountFen           int64     `json:"orderAmountFen"`
	OrderCreditsMicrocredits int64     `json:"orderCreditsMicrocredits"`
	RateBasisPoints          int64     `json:"rateBasisPoints"`
	CommissionMicrocredits   int64     `json:"commissionMicrocredits"`
	CreatedAt                time.Time `json:"createdAt"`
}

type ReferralCommissionPage struct {
	Commissions []ReferralCommissionView `json:"commissions"`
	Total       int64                    `json:"total"`
	Page        int                      `json:"page"`
	PageSize    int                      `json:"pageSize"`
}

func defaultReferralSetting() ReferralSetting {
	return ReferralSetting{Enabled: false, Mode: ReferralModeAll, CommissionRateBasisPoints: 1_000}
}

func validateReferralSetting(setting ReferralSetting) error {
	if setting.Mode != ReferralModeAll && setting.Mode != ReferralModeAssigned {
		return BadAuthRequest("推广开放方式无效")
	}
	if setting.CommissionRateBasisPoints < 0 || setting.CommissionRateBasisPoints > referralMaxRateBasisPoints {
		return BadAuthRequest("返佣比例需在 0%-50% 之间")
	}
	return nil
}

func (s *Service) referralSetting() (ReferralSetting, error) {
	stored, err := s.repo.SystemSetting(referralSettingKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return defaultReferralSetting(), nil
	}
	if err != nil {
		return ReferralSetting{}, err
	}
	var setting ReferralSetting
	if json.Unmarshal([]byte(stored.ValueJSON), &setting) != nil {
		return ReferralSetting{}, errors.New("推广设置格式无效")
	}
	if err := validateReferralSetting(setting); err != nil {
		return ReferralSetting{}, err
	}
	return setting, nil
}

func (s *Service) AdminReferralSetting(actor *model.User) (ReferralSetting, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return ReferralSetting{}, err
	}
	return s.referralSetting()
}

func (s *Service) UpdateReferralSetting(actor *model.User, setting ReferralSetting) (ReferralSetting, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return ReferralSetting{}, err
	}
	setting.Mode = strings.TrimSpace(setting.Mode)
	if err := validateReferralSetting(setting); err != nil {
		return ReferralSetting{}, err
	}
	encoded, err := json.Marshal(setting)
	if err != nil {
		return ReferralSetting{}, err
	}
	record := model.SystemSetting{Key: referralSettingKey, ValueJSON: string(encoded), UpdatedBy: actor.ID}
	current, err := s.repo.SystemSetting(referralSettingKey)
	if err == nil {
		record.CreatedAt = current.CreatedAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return ReferralSetting{}, err
	}
	if err := s.repo.SaveSystemSetting(&record); err != nil {
		return ReferralSetting{}, err
	}
	if err := s.appendAdminAudit(actor, "referral.setting.update", "setting", referralSettingKey, "更新推广中心设置", setting); err != nil {
		return ReferralSetting{}, err
	}
	return setting, nil
}

func referralEligible(user *model.User, setting ReferralSetting) bool {
	if user == nil || user.Status != model.UserStatusActive || !setting.Enabled {
		return false
	}
	return setting.Mode == ReferralModeAll || user.IsPromoter
}

// ReferralAvailable 决定前端是否展示推广中心入口；会话接口每次读取最新设置。
func (s *Service) ReferralAvailable(user *model.User) (bool, error) {
	if user == nil {
		return false, nil
	}
	setting, err := s.referralSetting()
	if err != nil {
		return false, err
	}
	return referralEligible(user, setting), nil
}

func (s *Service) requireReferralAccess(user *model.User) (ReferralSetting, error) {
	if user == nil {
		return ReferralSetting{}, Unauthorized("请先登录")
	}
	setting, err := s.referralSetting()
	if err != nil {
		return ReferralSetting{}, err
	}
	if !referralEligible(user, setting) {
		return ReferralSetting{}, Forbidden("推广中心未对当前账号开放")
	}
	return setting, nil
}

func (s *Service) ReferralOverview(user *model.User) (*ReferralOverview, error) {
	setting, err := s.requireReferralAccess(user)
	if err != nil {
		return nil, err
	}
	profile, err := s.ensureReferralProfile(user.ID)
	if err != nil {
		return nil, err
	}
	stats, err := s.repo.ReferralStats(user.ID)
	if err != nil {
		return nil, err
	}
	return &ReferralOverview{Code: profile.Code, Mode: setting.Mode, CommissionRateBasisPoints: setting.CommissionRateBasisPoints, Stats: stats}, nil
}

func (s *Service) ReferralInvitees(user *model.User, page, limit int) (*ReferralInviteePage, error) {
	if _, err := s.requireReferralAccess(user); err != nil {
		return nil, err
	}
	page, limit = normalizeAdminPage(page, limit)
	rows, total, err := s.repo.ReferralInvitees(user.ID, limit, (page-1)*limit)
	if err != nil {
		return nil, err
	}
	invitees := make([]ReferralInvitee, 0, len(rows))
	for _, row := range rows {
		invitees = append(invitees, ReferralInvitee{Name: maskReferralName(row.DisplayName, row.Username), CreatedAt: row.CreatedAt})
	}
	return &ReferralInviteePage{Invitees: invitees, Total: total, Page: page, PageSize: limit}, nil
}

func (s *Service) ReferralCommissions(user *model.User, page, limit int) (*ReferralCommissionPage, error) {
	if _, err := s.requireReferralAccess(user); err != nil {
		return nil, err
	}
	return s.referralCommissionPage(user.ID, page, limit, false)
}

func (s *Service) AdminReferralCommissions(actor *model.User, page, limit int) (*ReferralCommissionPage, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	return s.referralCommissionPage("", page, limit, true)
}

func (s *Service) referralCommissionPage(inviterID string, page, limit int, admin bool) (*ReferralCommissionPage, error) {
	page, limit = normalizeAdminPage(page, limit)
	rows, total, err := s.repo.ReferralCommissions(inviterID, limit, (page-1)*limit)
	if err != nil {
		return nil, err
	}
	items := make([]ReferralCommissionView, 0, len(rows))
	for _, row := range rows {
		view := ReferralCommissionView{
			ID: row.ID, OrderAmountFen: row.OrderAmountFen, OrderCreditsMicrocredits: row.OrderCreditsMicrocredits,
			RateBasisPoints: row.RateBasisPoints, CommissionMicrocredits: row.CommissionMicrocredits, CreatedAt: row.CreatedAt,
			InviteeName: maskReferralName(row.InviteeDisplayName, row.InviteeUsername),
		}
		if admin {
			// 后台需要定位账号，展示完整名称；推广人只看到脱敏后的被邀请人。
			view.InviterUserID = row.InviterUserID
			view.InviterName = referralFullName(row.InviterDisplayName, row.InviterUsername)
			view.InviteeName = referralFullName(row.InviteeDisplayName, row.InviteeUsername)
		}
		items = append(items, view)
	}
	return &ReferralCommissionPage{Commissions: items, Total: total, Page: page, PageSize: limit}, nil
}

func (s *Service) ensureReferralProfile(userID string) (*model.ReferralProfile, error) {
	profile, err := s.repo.ReferralProfileByUser(userID)
	if err == nil {
		return profile, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	for attempt := 0; attempt < referralCodeCreateMaxAttempt; attempt++ {
		code, err := newReferralCode()
		if err != nil {
			return nil, err
		}
		profile, err := s.repo.CreateReferralProfile(&model.ReferralProfile{UserID: userID, Code: code, CreatedAt: time.Now()})
		if errors.Is(err, repository.ErrReferralCodeTaken) {
			continue
		}
		return profile, err
	}
	return nil, errors.New("生成推广码失败，请稍后重试")
}

func newReferralCode() (string, error) {
	var builder strings.Builder
	limit := big.NewInt(int64(len(referralCodeAlphabet)))
	for i := 0; i < referralCodeLength; i++ {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		builder.WriteByte(referralCodeAlphabet[n.Int64()])
	}
	return builder.String(), nil
}

func normalizeReferralCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != referralCodeLength {
		return ""
	}
	for _, r := range code {
		if !strings.ContainsRune(referralCodeAlphabet, r) {
			return ""
		}
	}
	return code
}

// bindReferral 在注册成功后写入归属。推广码无效、推广人无资格或写入失败都不影响注册本身。
func (s *Service) bindReferral(inviteeID, rawCode string) {
	code := normalizeReferralCode(rawCode)
	if code == "" || inviteeID == "" {
		return
	}
	if err := s.tryBindReferral(inviteeID, code); err != nil {
		stdlog.Printf("referral binding failed: invitee=%s error=%v", inviteeID, err)
	}
}

func (s *Service) tryBindReferral(inviteeID, code string) error {
	profile, err := s.repo.ReferralProfileByCode(code)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if profile.UserID == inviteeID {
		return nil
	}
	inviter, err := s.repo.User(profile.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	setting, err := s.referralSetting()
	if err != nil {
		return err
	}
	if !referralEligible(inviter, setting) {
		return nil
	}
	_, err = s.repo.CreateReferralBinding(&model.ReferralBinding{InviteeUserID: inviteeID, InviterUserID: inviter.ID, Code: code, CreatedAt: time.Now()})
	return err
}

// grantReferralCommission 在积分充值订单入账后发放返佣。可对同一订单重复调用：
// 支付回调、主动查询和对账补发都会走到这里，由 payment_order_id 唯一约束去重。
// 返佣失败只记录日志，不回滚已入账的充值。
func (s *Service) grantReferralCommission(order *model.PaymentOrder) {
	if order == nil || order.Status != model.PaymentOrderCredited || topupProductKind(order.ProductKind) != model.TopupProductKindCredits || order.CreditsMicrocredits <= 0 {
		return
	}
	if err := s.tryGrantReferralCommission(order); err != nil {
		stdlog.Printf("referral commission failed: payment_order_id=%s error=%v", order.ID, err)
	}
}

func (s *Service) tryGrantReferralCommission(order *model.PaymentOrder) error {
	binding, err := s.repo.ReferralBindingByInvitee(order.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	setting, err := s.referralSetting()
	if err != nil {
		return err
	}
	inviter, err := s.repo.User(binding.InviterUserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !referralEligible(inviter, setting) {
		return nil
	}
	amount := referralCommissionAmount(order.CreditsMicrocredits, setting.CommissionRateBasisPoints)
	if amount <= 0 {
		return nil
	}
	_, err = s.repo.GrantReferralCommission(&model.ReferralCommission{
		ID: newID(), InviterUserID: inviter.ID, InviteeUserID: order.UserID, PaymentOrderID: order.ID,
		OrderAmountFen: order.AmountFen, OrderCreditsMicrocredits: order.CreditsMicrocredits,
		RateBasisPoints: setting.CommissionRateBasisPoints, CommissionMicrocredits: amount,
	}, "推广返佣 · 邀请用户充值")
	return err
}

// referralCommissionAmount 先除后乘避免大额积分与比例相乘溢出，结果向下取整到微积分。
func referralCommissionAmount(credits, rateBasisPoints int64) int64 {
	if credits <= 0 || rateBasisPoints <= 0 {
		return 0
	}
	return credits/10_000*rateBasisPoints + credits%10_000*rateBasisPoints/10_000
}

func referralFullName(displayName, username string) string {
	if name := strings.TrimSpace(displayName); name != "" {
		return name
	}
	if username = strings.TrimSpace(username); username != "" {
		return username
	}
	return "已注销用户"
}

func maskReferralName(displayName, username string) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = strings.TrimSpace(username)
	}
	if name == "" {
		return "已注销用户"
	}
	first, _ := utf8.DecodeRuneInString(name)
	return string(first) + "**"
}
