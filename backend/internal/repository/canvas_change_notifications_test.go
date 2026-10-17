package repository

import (
	"context"
	"errors"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestCanvasNotificationsWaitForOuterCommitAndDiscardRollback(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	var revisions []int64
	repo := New(db).WithCanvasChangeNotifier(func(userID, canvasID string) {
		var project model.CanvasProject
		if err := db.First(&project, "id = ? AND user_id = ?", canvasID, userID).Error; err != nil {
			t.Error(err)
		}
		revisions = append(revisions, project.Revision)
	})
	rollback := errors.New("rollback")
	err = repo.Transaction(func(tx *Repository) error {
		if err := tx.WithContext(context.Background()).WithCanvasEditProofs(nil).UpsertCanvasProject(&model.CanvasProject{ID: "canvas", UserID: "user", PayloadJSON: `{}`}); err != nil {
			return err
		}
		if len(revisions) != 0 {
			t.Fatal("published before outer commit")
		}
		return rollback
	})
	if !errors.Is(err, rollback) || len(revisions) != 0 {
		t.Fatalf("rollback notifications=%v, err=%v", revisions, err)
	}
	err = repo.Transaction(func(tx *Repository) error {
		if err := tx.UpsertCanvasProject(&model.CanvasProject{ID: "canvas", UserID: "user", PayloadJSON: `{}`}); err != nil {
			return err
		}
		_ = tx.Transaction(func(nested *Repository) error { nested.canvasChanged("other", "rolled-back"); return rollback })
		if len(revisions) != 0 {
			t.Fatal("nested commit notified early")
		}
		tx.canvasChanged("user", "canvas")
		return nil
	})
	if err != nil || len(revisions) != 1 || revisions[0] != 1 {
		t.Fatalf("committed notifications=%v, err=%v", revisions, err)
	}
}
