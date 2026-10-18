package repository

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"yingce/backend/internal/model"
)

func TestTaskSubmission(t *testing.T) {
	for _, driver := range []string{"sqlite", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			config := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
			var db *gorm.DB
			var err error
			if driver == "sqlite" {
				db, err = gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "receipts.db")+"?_journal_mode=WAL&_busy_timeout=5000"), config)
			} else {
				dsn := os.Getenv("CANVAS_TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("isolated postgres DSN not configured")
				}
				admin, openErr := gorm.Open(postgres.Open(dsn), config)
				if openErr != nil {
					t.Fatal(openErr)
				}
				schema := fmt.Sprintf("task_submission_%d", time.Now().UnixNano())
				if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					_ = admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error
					conn, _ := admin.DB()
					_ = conn.Close()
				})
				parsed, err := url.Parse(dsn)
				if err != nil {
					t.Fatal(err)
				}
				query := parsed.Query()
				query.Set("search_path", schema)
				parsed.RawQuery = query.Encode()
				db, err = gorm.Open(postgres.Open(parsed.String()), config)
			}
			if err != nil {
				t.Fatal(err)
			}
			conn, _ := db.DB()
			if driver == "sqlite" {
				conn.SetMaxOpenConns(1)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := db.AutoMigrate(&model.TaskSubmissionReceipt{}, &model.Task{}, &model.CreditAccount{}, &model.BillingOrder{}, &model.CreditLedgerEntry{}); err != nil {
				t.Fatal(err)
			}
			repo := New(db)
			if err := db.Create(&model.CreditAccount{UserID: "owner", AvailableMicrocredits: 1000}).Error; err != nil {
				t.Fatal(err)
			}
			makeTask := func(id, key string) model.Task {
				return model.Task{ID: id, UserID: "owner", Type: "canvas_video", Status: model.TaskStatusQueued, SubmissionReceipt: &model.TaskSubmissionReceipt{UserID: "owner", KeyHash: key, OperationHash: key, RequestHash: "request"}}
			}
			makeOrder := func(task model.Task) *model.BillingOrder {
				return &model.BillingOrder{ID: "order-" + task.ID, UserID: task.UserID, TaskID: task.ID, IdempotencyKey: task.ID, AmountMicrocredits: 100, Status: model.BillingStatusReserved}
			}
			first := makeTask("first", "same-operation")
			first.BillingOrderID = "order-first"
			if err := repo.CreateTaskWithCreditReservation(&first, makeOrder(first), 100); err != nil {
				t.Fatal(err)
			}
			// Model a lost HTTP response and a fresh service/process reading the receipt.
			replay := makeTask("response-lost", "same-operation")
			if err := New(db).CreateTaskWithCreditReservation(&replay, makeOrder(replay), 1); err != nil {
				t.Fatal(err)
			}
			if replay.ID != first.ID {
				t.Fatalf("replay created %s instead of %s", replay.ID, first.ID)
			}
			conflict := makeTask("changed", "same-operation")
			conflict.SubmissionReceipt.RequestHash = "changed"
			if err := repo.CreateTaskWithCreditReservation(&conflict, makeOrder(conflict), 100); !errors.Is(err, ErrTaskSubmissionConflict) {
				t.Fatalf("changed request: %v", err)
			}
			// Simultaneous requests must converge before credit reservation.
			var wg sync.WaitGroup
			results := make(chan model.Task, 6)
			failures := make(chan error, 6)
			for i := 0; i < 6; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					task := makeTask(fmt.Sprintf("concurrent-%d", i), "concurrent")
					err := New(db).CreateTaskWithCreditReservation(&task, makeOrder(task), 100)
					failures <- err
					results <- task
				}(i)
			}
			wg.Wait()
			close(failures)
			close(results)
			for err := range failures {
				if err != nil {
					t.Fatal(err)
				}
			}
			ids := map[string]bool{}
			for task := range results {
				ids[task.ID] = true
			}
			if len(ids) != 1 {
				t.Fatalf("concurrent created %d tasks", len(ids))
			}
			account, err := repo.CreditAccount("owner")
			if err != nil {
				t.Fatal(err)
			}
			if account.AvailableMicrocredits != 800 || account.ReservedMicrocredits != 200 {
				t.Fatalf("duplicate reservation: %+v", account)
			}
			var count int64
			db.Model(&model.BillingOrder{}).Count(&count)
			if count != 2 {
				t.Fatalf("billing orders = %d", count)
			}
			// The same operation is independent across users.
			other := makeTask("other-user", "same-operation")
			other.UserID = "other"
			other.SubmissionReceipt.UserID = "other"
			if err := repo.CreateTaskWithActiveLimit(&other, 100); err != nil {
				t.Fatal(err)
			}
			// Parent task still running or already successful: return it without a new order.
			for _, status := range []model.TaskStatus{model.TaskStatusRunning, model.TaskStatusSucceeded} {
				if err := db.Model(&model.Task{}).Where("id = ?", first.ID).Update("status", status).Error; err != nil {
					t.Fatal(err)
				}
				task := makeTask("blocked-"+string(status), "retry-"+string(status))
				task.SubmissionReceipt.RetryOf = first.ID
				if err := repo.CreateTaskWithCreditReservation(&task, makeOrder(task), 100); err != nil {
					t.Fatal(err)
				}
				if task.ID != first.ID {
					t.Fatal("retry did not return original task")
				}
			}
			if err := db.Model(&model.Task{}).Where("id = ?", first.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.BillingOrder{}).Where("id = ?", first.BillingOrderID).Update("status", model.BillingStatusUncertain).Error; err != nil {
				t.Fatal(err)
			}
			blocked := makeTask("uncertain", "retry-uncertain")
			blocked.SubmissionReceipt.RetryOf = first.ID
			if err := repo.CreateTaskWithCreditReservation(&blocked, makeOrder(blocked), 100); !errors.Is(err, ErrTaskRetryUnconfirmed) {
				t.Fatalf("uncertain billing retry: %v", err)
			}
			// Deleting history cannot erase the durable paid-operation identity.
			if err := db.Delete(&model.Task{}, "id = ?", first.ID).Error; err != nil {
				t.Fatal(err)
			}
			deleted := makeTask("deleted-replay", "same-operation")
			if err := repo.CreateTaskWithCreditReservation(&deleted, makeOrder(deleted), 100); !errors.Is(err, ErrTaskSubmissionDeleted) {
				t.Fatalf("deleted replay: %v", err)
			}
			// Reservation failure rolls the receipt back, allowing the original operation to be retried.
			poor := makeTask("poor", "insufficient")
			poor.UserID = "poor"
			poor.SubmissionReceipt.UserID = "poor"
			if err := repo.CreateTaskWithCreditReservation(&poor, makeOrder(poor), 100); !errors.Is(err, ErrInsufficientCredits) {
				t.Fatal(err)
			}
			if _, err := repo.TaskSubmission("poor", "insufficient"); !errors.Is(err, gorm.ErrRecordNotFound) {
				t.Fatal("failed reservation left receipt")
			}
		})
	}
}
