package app

import (
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newTestFeedbackService(t *testing.T) (*Service, *model.User, *model.User) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.UserFeedback{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	repo := repository.New(db)
	svc := &Service{repo: repo}

	admin := &model.User{ID: "admin_1", Username: "admin", Role: "admin", Status: "active", CreatedAt: time.Now()}
	user := &model.User{ID: "user_1", Username: "testuser", Email: "test@example.com", Role: "user", Status: "active", CreatedAt: time.Now()}

	if err := db.Create(admin).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(user).Error; err != nil {
		t.Fatal(err)
	}

	return svc, admin, user
}

func TestFeedbackSubmitAndList(t *testing.T) {
	svc, admin, user := newTestFeedbackService(t)

	// 1. Submit feedback as user
	req := SubmitFeedbackRequest{
		Type:        model.FeedbackTypeBug,
		Title:       "视频下载按钮未响应",
		Content:     "在生成视频后，点击卡片右上角的下载按钮无反应。",
		Contact:     "test@example.com",
		Attachments: `[{"id":"res_1","name":"screen.png","type":"image","url":"/api/resources/res_1/file","size":1024}]`,
		Environment: `{"browser":"Chrome 120","os":"macOS"}`,
	}

	fb, err := svc.SubmitFeedback(user, req)
	if err != nil {
		t.Fatalf("SubmitFeedback failed: %v", err)
	}
	if fb.ID == "" || fb.Status != model.FeedbackStatusPending {
		t.Fatalf("unexpected feedback created: %+v", fb)
	}

	// 2. User view their own feedbacks
	myList, err := svc.MyFeedbacks(user)
	if err != nil {
		t.Fatalf("MyFeedbacks failed: %v", err)
	}
	if len(myList) != 1 || myList[0].Title != req.Title {
		t.Fatalf("expected 1 feedback, got %d", len(myList))
	}

	// 3. Admin view feedbacks
	adminList, err := svc.AdminListFeedbacks(admin, repository.FeedbackFilter{Status: "pending"})
	if err != nil {
		t.Fatalf("AdminListFeedbacks failed: %v", err)
	}
	if adminList.Total != 1 || len(adminList.List) != 1 {
		t.Fatalf("admin expected 1 feedback, got total=%d", adminList.Total)
	}

	// 4. Admin reply and resolve
	updated, err := svc.AdminUpdateFeedback(admin, fb.ID, AdminUpdateFeedbackRequest{
		Status:     model.FeedbackStatusResolved,
		AdminReply: "已修复该问题，感谢您的反馈！",
	})
	if err != nil {
		t.Fatalf("AdminUpdateFeedback failed: %v", err)
	}
	if updated.Status != model.FeedbackStatusResolved || updated.AdminReply == "" || updated.RepliedAt == nil {
		t.Fatalf("AdminUpdateFeedback not updated properly: %+v", updated)
	}

	// 5. User checks inbox again
	myList2, err := svc.MyFeedbacks(user)
	if err != nil {
		t.Fatalf("MyFeedbacks 2 failed: %v", err)
	}
	if myList2[0].Status != model.FeedbackStatusResolved || myList2[0].AdminReply != "已修复该问题，感谢您的反馈！" {
		t.Fatalf("user inbox did not reflect admin reply: %+v", myList2[0])
	}

	// 6. Admin archives feedback
	archived, err := svc.AdminArchiveFeedback(admin, fb.ID, true)
	if err != nil {
		t.Fatalf("AdminArchiveFeedback failed: %v", err)
	}
	if !archived.Archived || archived.ArchivedAt == nil {
		t.Fatalf("expected feedback to be archived: %+v", archived)
	}

	// 7. Verify admin filter by archived
	archivedFilter := true
	adminArchivedList, err := svc.AdminListFeedbacks(admin, repository.FeedbackFilter{Archived: &archivedFilter})
	if err != nil || adminArchivedList.Total != 1 {
		t.Fatalf("expected 1 archived feedback, got %d", adminArchivedList.Total)
	}

	notArchivedFilter := false
	adminActiveList, err := svc.AdminListFeedbacks(admin, repository.FeedbackFilter{Archived: &notArchivedFilter})
	if err != nil || adminActiveList.Total != 0 {
		t.Fatalf("expected 0 active feedbacks, got %d", adminActiveList.Total)
	}
}
