package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

const internalErrorMessage = "系统处理失败，请稍后重试"

func ok(c *gin.Context, data any) {
	c.JSON(http.StatusOK, gin.H{"code": service.CodeOK, "data": data, "msg": "ok"})
}

// fail 只接受调用方已经确认可公开的错误；service 返回值统一交给 failService 投影。
func fail(c *gin.Context, status int, err error) {
	message := http.StatusText(status)
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	if public, ok := requestDecodeMessage(err); ok {
		message = public
	}
	writeFailure(c, status, status, service.ReasonForStatus(status), message)
}

// requestDecodeMessage 把请求体解析失败的内部错误（JSON 语法、字段类型、超限、空正文）
// 换成可公开的中文提示，避免把 Go 结构体名和英文解析信息返回给用户。
func requestDecodeMessage(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var maxBytes *http.MaxBytesError
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	switch {
	case errors.As(err, &maxBytes):
		return "请求内容过大", true
	case errors.As(err, &syntaxErr), errors.As(err, &typeErr), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "请求格式错误", true
	}
	return "", false
}

func failService(c *gin.Context, err error) {
	var cooldown *service.EmailCodeCooldownError
	if errors.As(err, &cooldown) {
		c.Header("Retry-After", strconv.Itoa(cooldown.Seconds))
		writeFailure(c, http.StatusTooManyRequests, service.CodeRateLimited, service.ReasonRateLimited, cooldown.Error())
		return
	}
	var modelErr *service.ModelError
	if errors.As(err, &modelErr) && modelErr.AppError != nil && validErrorStatus(modelErr.Status) {
		writeAppError(c, modelErr.AppError)
		return
	}
	var appErr *service.AppError
	if errors.As(err, &appErr) && validErrorStatus(appErr.Status) {
		writeAppError(c, appErr)
		return
	}
	failInternal(c, http.StatusInternalServerError, err)
}

func writeAppError(c *gin.Context, appErr *service.AppError) {
	code := appErr.Code
	if code == 0 {
		code = appErr.Status
	}
	reason := appErr.Reason
	if reason == "" {
		reason = service.ReasonForStatus(appErr.Status)
	}
	message := strings.TrimSpace(appErr.Message)
	if message == "" {
		message = safeInternalErrorMessage(appErr.Status)
	}
	if appErr.Status >= http.StatusInternalServerError {
		diagnosticErr := appErr.Cause
		if diagnosticErr == nil {
			diagnosticErr = appErr
		}
		logHandlerError(c, appErr.Status, diagnosticErr)
	}
	body := gin.H{"code": code, "data": nil, "msg": message}
	if reason != "" {
		body["reason"] = reason
	}
	if len(appErr.Details) > 0 {
		body["details"] = appErr.Details
	}
	c.JSON(appErr.Status, body)
}

// failInternal 保留真实 HTTP 状态，但绝不把未分类错误原文写入响应。
func failInternal(c *gin.Context, status int, err error) {
	if !validErrorStatus(status) {
		status = http.StatusInternalServerError
	}
	logHandlerError(c, status, err)
	writeFailure(c, status, status, service.ReasonForStatus(status), safeInternalErrorMessage(status))
}

func writeFailure(c *gin.Context, status int, code int, reason service.ErrorReason, message string) {
	body := gin.H{"code": code, "data": nil, "msg": message}
	if reason != "" {
		body["reason"] = reason
	}
	c.JSON(status, body)
}

func validErrorStatus(status int) bool {
	return status >= http.StatusBadRequest && status <= 599
}

func safeInternalErrorMessage(status int) string {
	switch status {
	case http.StatusBadGateway:
		return "上游服务暂时不可用，请稍后重试"
	case http.StatusServiceUnavailable:
		return "服务暂时不可用，请稍后重试"
	case http.StatusGatewayTimeout:
		return "上游服务响应超时，请稍后重试"
	default:
		return internalErrorMessage
	}
}

func logHandlerError(c *gin.Context, status int, err error) {
	if err == nil {
		return
	}
	method := ""
	route := ""
	if c != nil && c.Request != nil {
		method = c.Request.Method
		route = c.FullPath()
		if route == "" {
			route = "<unmatched>"
		}
	}
	requestID := ""
	if c != nil {
		requestID = c.Writer.Header().Get("X-Request-ID")
	}
	// 只记录脱敏、截断后的错误文本：URL 中的地址与密钥参数、Bearer 令牌会被替换，
	// 上游响应体不会整段进入日志。没有原因文本时 500 无法排查。
	log.Printf("handler request failed: method=%s route=%s status=%d request_id=%s error_type=%T error=%q", method, route, status, requestID, err, service.RedactLogText(err.Error(), 500))
}
