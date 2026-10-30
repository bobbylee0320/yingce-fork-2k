package app

import (
	"regexp"
	"strings"
)

// 用户可见文本（任务错误、退款原因、积分流水备注）会随 API 回传到浏览器，
// 不能出现上游地址。原始内容仍写入请求日志和任务诊断，管理员按需排查。
const (
	upstreamAddressLinkPlaceholder = "[链接已隐藏]"
	upstreamAddressHostPlaceholder = "[地址已隐藏]"
)

var (
	// 网络错误的地址常以 dial/read/write tcp <addr> 形式出现，保留动词前缀，
	// 前端据此继续把这条失败归类成网络异常。
	upstreamNetworkOperation = regexp.MustCompile(`(?i)\b(?:dial|read|write|proxyconnect)\s+tcp\s+\S+`)
	upstreamIPv4Address      = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b`)
)

// logBearerToken 匹配错误文本里可能夹带的 Bearer 令牌与 sk- 形式的密钥。
var logBearerToken = regexp.MustCompile(`(?i)\b(?:bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,})`)

// RedactLogText 生成可写入进程日志的错误文本：隐藏 URL（含签名参数）、IP 与令牌，并按字符截断。
func RedactLogText(text string, maxRunes int) string {
	text = logBearerToken.ReplaceAllString(redactUpstreamAddress(text), "[令牌已隐藏]")
	if maxRunes > 0 {
		text = truncateRunes(text, maxRunes)
	}
	return text
}

// redactUpstreamAddress 隐藏文本里的上游 URL、IP 和网络操作地址。
// URL 复用请求明细的 [链接已隐藏] 约定，保持用户可见文案与后台日志同一套措辞。
func redactUpstreamAddress(text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	text = providerErrorURL.ReplaceAllString(text, upstreamAddressLinkPlaceholder)
	text = upstreamNetworkOperation.ReplaceAllStringFunc(text, func(match string) string {
		fields := strings.Fields(match)
		if len(fields) >= 2 {
			return fields[0] + " " + fields[1] + " " + upstreamAddressHostPlaceholder + ":"
		}
		return upstreamAddressHostPlaceholder
	})
	return upstreamIPv4Address.ReplaceAllString(text, upstreamAddressHostPlaceholder)
}
