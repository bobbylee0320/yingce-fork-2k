package app

import (
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestTaskSubmissionAdmission(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.TaskSubmissionReceipt{}); err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db)}
	request := func(operation, retry string) CreateTaskRequest {
		return CreateTaskRequest{Type: "canvas_video", Prompt: "video", Input: map[string]any{"metadata": map[string]any{"clientOperationId": operation, "retryOf": retry}}}
	}
	req := request("operation", "")
	receipt, _, err := svc.prepareTaskSubmission("owner", req)
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "accepted", UserID: "owner", Type: req.Type, Status: model.TaskStatusRunning, InputJSON: `{"metadata":{"conversationId":"chat","messageId":"message"}}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	receipt.TaskID = task.ID
	if err := db.Create(receipt).Error; err != nil {
		t.Fatal(err)
	}
	// Existing receipts are returned before runtime/model/credit validation.
	got, err := svc.CreateTask("owner", req)
	if err != nil || got.ID != task.ID {
		t.Fatalf("replay = %+v, %v", got, err)
	}
	req.Prompt = "different"
	if _, err := svc.CreateTask("owner", req); err == nil {
		t.Fatal("conflicting request accepted")
	}
	resolved, err := svc.ResolveTaskSubmissions("owner", []string{"operation"})
	if err != nil || len(resolved) != 1 || resolved[0].ID != task.ID {
		t.Fatalf("resolve = %+v, %v", resolved, err)
	}
	resolved, err = svc.ResolveTaskSubmissions("other", []string{"operation"})
	if err != nil || len(resolved) != 0 {
		t.Fatal("receipt leaked across accounts")
	}
	retry := request("retry-operation", task.ID)
	got, err = svc.CreateTask("owner", retry)
	if err != nil || got.ID != task.ID {
		t.Fatalf("active retry = %+v, %v", got, err)
	}
	if _, err := svc.CreateTask("other", retry); err == nil {
		t.Fatal("another user's retry accepted")
	}
}
