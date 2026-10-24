package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"yingce/backend/internal/app"
	"yingce/backend/internal/auth"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newTestFeedbackHandler(t *testing.T) (*gin.Engine, *model.User, *model.User) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.UserFeedback{}, &model.AuthSession{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	repo := repository.New(db)
	svc := app.New(repo, t.TempDir())

	admin := &model.User{ID: "admin_u1", Username: "admin", Role: "admin", Status: "active", CreatedAt: time.Now()}
	user := &model.User{ID: "normal_u1", Username: "normal", Email: "normal@example.com", Role: "user", Status: "active", CreatedAt: time.Now()}

	if err := db.Create(admin).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}

	// Create sessions
	db.Create(&model.AuthSession{ID: "sess_admin", UserID: admin.ID, TokenHash: auth.HashToken("admin-tok"), CreatedAt: time.Now(), ExpiresAt: time.Now().Add(24 * time.Hour)})
	db.Create(&model.AuthSession{ID: "sess_user", UserID: user.ID, TokenHash: auth.HashToken("user-tok"), CreatedAt: time.Now(), ExpiresAt: time.Now().Add(24 * time.Hour)})

	r := gin.New()
	api := r.Group("/api")
	RegisterFeedbackRoutes(api, svc)

	return r, admin, user
}

func TestFeedbackHTTPEndpoints(t *testing.T) {
	r, _, _ := newTestFeedbackHandler(t)

	// 1. Submit feedback
	payload := map[string]any{
		"type":        "bug",
		"title":       "测试反馈标题",
		"content":     "测试反馈正文内容描述详细信息",
		"contact":     "test@user.com",
		"attachments": "[]",
		"environment": "{}",
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/feedbacks", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_user.user-tok"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var submitResp struct {
		Code int                `json:"code"`
		Data model.UserFeedback `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &submitResp); err != nil {
		t.Fatalf("decode submit response: %v", err)
	}
	if submitResp.Data.ID == "" || submitResp.Data.Title != "测试反馈标题" {
		t.Fatalf("unexpected feedback data: %+v", submitResp.Data)
	}

	// 2. User gets my feedbacks
	reqMy := httptest.NewRequest(http.MethodGet, "/api/feedbacks/my", nil)
	reqMy.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_user.user-tok"})
	wMy := httptest.NewRecorder()
	r.ServeHTTP(wMy, reqMy)

	if wMy.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", wMy.Code, wMy.Body.String())
	}

	// 3. Admin gets feedbacks
	reqAdmin := httptest.NewRequest(http.MethodGet, "/api/admin/feedbacks", nil)
	reqAdmin.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_admin.admin-tok"})
	wAdmin := httptest.NewRecorder()
	r.ServeHTTP(wAdmin, reqAdmin)

	if wAdmin.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", wAdmin.Code, wAdmin.Body.String())
	}

	// 4. Admin reply & patch
	patchPayload := map[string]any{
		"status":     "resolved",
		"adminReply": "已处理完毕",
	}
	patchBody, _ := json.Marshal(patchPayload)
	reqPatch := httptest.NewRequest(http.MethodPatch, "/api/admin/feedbacks/"+submitResp.Data.ID, bytes.NewReader(patchBody))
	reqPatch.Header.Set("Content-Type", "application/json")
	reqPatch.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_admin.admin-tok"})
	wPatch := httptest.NewRecorder()
	r.ServeHTTP(wPatch, reqPatch)

	if wPatch.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", wPatch.Code, wPatch.Body.String())
	}

	// 5. Admin archive feedback
	reqArchive := httptest.NewRequest(http.MethodPost, "/api/admin/feedbacks/"+submitResp.Data.ID+"/archive", nil)
	reqArchive.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_admin.admin-tok"})
	wArchive := httptest.NewRecorder()
	r.ServeHTTP(wArchive, reqArchive)

	if wArchive.Code != http.StatusOK {
		t.Fatalf("expected 200 on archive, got %d: %s", wArchive.Code, wArchive.Body.String())
	}

	// 6. Admin query with archived=true
	reqArchivedList := httptest.NewRequest(http.MethodGet, "/api/admin/feedbacks?archived=true", nil)
	reqArchivedList.AddCookie(&http.Cookie{Name: "open_ai_canvas_session", Value: "sess_admin.admin-tok"})
	wArchivedList := httptest.NewRecorder()
	r.ServeHTTP(wArchivedList, reqArchivedList)

	if wArchivedList.Code != http.StatusOK {
		t.Fatalf("expected 200 on query archived list, got %d: %s", wArchivedList.Code, wArchivedList.Body.String())
	}
}
