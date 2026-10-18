package repository

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

var ErrTaskSubmissionConflict = errors.New("同一生成操作的内容已变化，请刷新任务状态")
var ErrTaskSubmissionDeleted = errors.New("原任务历史已删除，本次操作不会再次提交或扣费")
var ErrTaskRetryUnconfirmed = errors.New("原任务或费用状态尚未确认，不能重新生成")

func (r *Repository) TaskSubmission(userID, keyHash string) (*model.TaskSubmissionReceipt, error) {
	var receipt model.TaskSubmissionReceipt
	err := r.db.Where("user_id = ? AND key_hash = ?", userID, keyHash).First(&receipt).Error
	return &receipt, err
}

func (r *Repository) TaskSubmissionForOperation(userID, operationHash string) (*model.TaskSubmissionReceipt, error) {
	var receipt model.TaskSubmissionReceipt
	err := r.db.Where("user_id = ? AND operation_hash = ?", userID, operationHash).First(&receipt).Error
	return &receipt, err
}

func (r *Repository) replayTaskSubmission(task *model.Task, receipt *model.TaskSubmissionReceipt) error {
	if receipt.RequestHash != task.SubmissionReceipt.RequestHash {
		return ErrTaskSubmissionConflict
	}
	existing, err := r.TaskForUser(task.UserID, receipt.TaskID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrTaskSubmissionDeleted
	}
	if err != nil {
		return err
	}
	*task = *existing
	return nil
}

// Runs inside the same transaction as task creation and credit reservation.
// The unique receipt wins before any balance mutation, including across processes.
func (r *Repository) claimTaskSubmission(task *model.Task) (bool, error) {
	receipt := task.SubmissionReceipt
	if receipt == nil {
		return false, nil
	}
	if existing, err := r.TaskSubmission(task.UserID, receipt.KeyHash); err == nil {
		return true, r.replayTaskSubmission(task, existing)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	if receipt.RetryOf != "" {
		var parent model.Task
		if err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ?", receipt.RetryOf, task.UserID).First(&parent).Error; err != nil {
			return false, err
		}
		if parent.Status == model.TaskStatusQueued || parent.Status == model.TaskStatusRunning || parent.Status == model.TaskStatusSucceeded {
			*task = parent
			return true, nil
		}
		if (parent.Status != model.TaskStatusFailed && parent.Status != model.TaskStatusCancelled) || parent.MediaRecoveryJSON != "" || parent.ProviderCancelStatus == model.ProviderCancelStatusRequested || parent.ProviderCancelStatus == model.ProviderCancelStatusUncertain || (parent.LeaseExpiresAt != nil && parent.LeaseExpiresAt.After(time.Now())) {
			return false, ErrTaskRetryUnconfirmed
		}
		if parent.ExecutionDiagnosticJSON != "" {
			var diagnostic model.TaskExecutionDiagnostic
			if err := json.Unmarshal([]byte(parent.ExecutionDiagnosticJSON), &diagnostic); err != nil || diagnostic.SubmissionOutcome == "unknown" {
				return false, ErrTaskRetryUnconfirmed
			}
		}
		if parent.BillingOrderID != "" {
			var order model.BillingOrder
			if err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&order, "id = ?", parent.BillingOrderID).Error; err != nil {
				return false, err
			}
			if order.Status != model.BillingStatusRefunded && order.Status != model.BillingStatusSettled {
				return false, ErrTaskRetryUnconfirmed
			}
		}
	}
	receipt.TaskID = task.ID
	created := r.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}, {Name: "key_hash"}}, DoNothing: true}).Create(receipt)
	if created.Error != nil {
		return false, created.Error
	}
	if created.RowsAffected == 0 {
		existing, err := r.TaskSubmission(task.UserID, receipt.KeyHash)
		if err != nil {
			return false, err
		}
		return true, r.replayTaskSubmission(task, existing)
	}
	return false, nil
}
