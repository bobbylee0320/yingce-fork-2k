package app

import (
	"net/http"
	"strings"
	"testing"
)

// 中文供应商的内容安全拒绝原先落到「请检查模型和参数」等通用文案，用户会去改参数或换模型，而不是改内容。
func TestProviderChineseSafetyRefusalUsesModerationMessage(t *testing.T) {
	const moderation = "请求内容未通过模型服务安全审核，请调整后重试"
	for name, body := range map[string]string{
		"image refusal":  `{"error":{"message":"非常抱歉，生成的图片可能违反了关于裸露、色情或情色内容的防护限制。"}}`,
		"policy":         `{"message":"请求触发了平台安全策略，已拦截"}`,
		"content safety": `{"msg":"输入包含违规内容，内容安全检查未通过"}`,
	} {
		for _, status := range []int{http.StatusBadRequest, http.StatusUnprocessableEntity} {
			got := providerHTTPError{StatusCode: status, Status: http.StatusText(status), Body: body}.Error()
			if !strings.HasPrefix(got, moderation) {
				t.Errorf("%s/%d: %q, want moderation message", name, status, got)
			}
		}
		if got := providerErrorWithDetail("模型服务返回失败，请检查请求内容或渠道配置", body); !strings.HasPrefix(got, moderation) {
			t.Errorf("%s/business failure: %q, want moderation message", name, got)
		}
	}
	if got := (providerHTTPError{StatusCode: http.StatusBadRequest, Status: "400 Bad Request", Body: `{"error":{"message":"参数 size 不合法"}}`}).Error(); strings.HasPrefix(got, moderation) {
		t.Errorf("普通参数错误不应归为安全审核：%q", got)
	}
}
