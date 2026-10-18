package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/auth"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestPersonalImagePresetsHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.Tool{}, &model.ToolFavorite{}, &model.IDSequence{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"alice", "bob"} {
		if err := db.Create(&model.User{ID: id, Username: id, Email: id + "@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.AuthSession{ID: id, UserID: id, TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	router := gin.New()
	RegisterToolRoutes(router.Group("/api"), svc)
	call := func(user, method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
		if user != "" {
			r.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: user + ".test-token"})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	w := call("alice", "POST", "/api/tools", `{"type":"nine_grid","label":"个人白底图","prompt":"白色背景","visibility":"private"}`)
	if w.Code != 200 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Code int              `json:"code"`
		Data service.ToolItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Code != 0 || created.Data.ID <= 0 {
		t.Fatalf("create envelope %s %v", w.Body.String(), err)
	}
	path := fmt.Sprintf("/api/tools/%d", created.Data.ID)
	body := `{"type":"nine_grid","label":"个人暖光图","prompt":"暖光背景","visibility":"private"}`
	for _, actor := range []string{"", "bob"} {
		w := call(actor, "PATCH", path, body)
		want := http.StatusNotFound
		if actor == "" {
			want = http.StatusUnauthorized
		}
		if w.Code != want {
			t.Fatalf("unauthorized patch %q: %d %s", actor, w.Code, w.Body.String())
		}
	}
	w = call("alice", "PATCH", path, body)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "暖光背景") {
		t.Fatalf("update %d %s", w.Code, w.Body.String())
	}
	w = call("alice", "GET", path, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "暖光背景") {
		t.Fatalf("persistence %d %s", w.Code, w.Body.String())
	}
	w = call("bob", "GET", "/api/tools?scope=custom&type=nine_grid", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "个人暖光图") {
		t.Fatalf("account leak %d %s", w.Code, w.Body.String())
	}
	w = call("alice", "PATCH", path, `{"type":"nine_grid","label":"x","prompt":""}`)
	if w.Code != 400 {
		t.Fatalf("invalid update %d %s", w.Code, w.Body.String())
	}
	w = call("alice", "DELETE", path, "")
	if w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}
	w = call("alice", "GET", path, "")
	if w.Code != 404 {
		t.Fatalf("deleted tool visible %d %s", w.Code, w.Body.String())
	}
}
