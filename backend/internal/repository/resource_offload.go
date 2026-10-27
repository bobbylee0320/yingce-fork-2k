package repository

import (
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpsertResourceOffloadJob 为同一资源只保留一条补传记录。资源重试保存时可能再次
// 进入本地兜底，这时用新的本地文件和目标位置覆盖旧记录并重新排队。
func (r *Repository) UpsertResourceOffloadJob(job *model.ResourceOffloadJob) error {
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "resource_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"user_id", "task_id", "size", "local_object_key", "target_provider", "target_endpoint", "target_bucket",
			"target_storage_setting_id", "target_object_key", "status", "attempts", "last_error_code", "last_error",
			"next_attempt_at", "lease_owner", "lease_expires_at", "local_playback_key", "local_delete_after", "local_deleted_at", "updated_at",
		}),
	}).Create(job).Error
}

func (r *Repository) ClaimNextResourceOffloadJob(owner string, leaseDuration time.Duration) (*model.ResourceOffloadJob, error) {
	var job model.ResourceOffloadJob
	now := time.Now()
	err := r.db.Transaction(func(tx *gorm.DB) error {
		available := "(status = ? OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?))) AND next_attempt_at <= ?"
		query := tx.Where(available, model.ResourceOffloadStatusPending, model.ResourceOffloadStatusProcessing, now, now).
			Order("next_attempt_at asc, created_at asc").Limit(1)
		if r.Dialect() == "postgres" {
			query = query.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"})
		}
		result := query.Find(&job)
		if result.Error != nil || result.RowsAffected == 0 {
			return result.Error
		}
		claim := tx.Model(&model.ResourceOffloadJob{}).Where("id = ?", job.ID)
		if r.Dialect() != "postgres" {
			claim = claim.Where(available, model.ResourceOffloadStatusPending, model.ResourceOffloadStatusProcessing, now, now)
		}
		updated := claim.Updates(map[string]any{
			"status":           model.ResourceOffloadStatusProcessing,
			"attempts":         gorm.Expr("attempts + ?", 1),
			"lease_owner":      owner,
			"lease_expires_at": now.Add(leaseDuration),
			"updated_at":       now,
		})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected == 0 {
			job = model.ResourceOffloadJob{}
			return nil
		}
		return tx.First(&job, "id = ?", job.ID).Error
	})
	if err != nil || job.ID == "" {
		return nil, err
	}
	return &job, nil
}

func (r *Repository) RetryResourceOffloadJob(id, owner, code, message string, nextAttemptAt time.Time) error {
	return r.db.Model(&model.ResourceOffloadJob{}).
		Where("id = ? AND lease_owner = ?", id, owner).
		Updates(map[string]any{
			"status": model.ResourceOffloadStatusPending, "last_error_code": code, "last_error": message,
			"next_attempt_at": nextAttemptAt, "lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now(),
		}).Error
}

// FinishResourceOffloadJob 把领取中的任务置为终态（done / cancelled / failed）。
func (r *Repository) FinishResourceOffloadJob(id, owner string, status model.ResourceOffloadStatus, updates map[string]any) error {
	values := map[string]any{"status": status, "lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now()}
	for key, value := range updates {
		values[key] = value
	}
	return r.db.Model(&model.ResourceOffloadJob{}).Where("id = ? AND lease_owner = ?", id, owner).Updates(values).Error
}

// SwitchResourceToObjectStorage 只在资源仍是该任务写入的那份本地文件时切换存储位置。
// 资源已删除、已被替换或已切换时返回 false，调用方负责清理刚上传的对象。
func (r *Repository) SwitchResourceToObjectStorage(job *model.ResourceOffloadJob, etag string) (bool, error) {
	result := r.db.Model(&model.Resource{}).
		Where("id = ? AND user_id = ? AND provider = ? AND object_key = ? AND status = ?", job.ResourceID, job.UserID, "local", job.LocalObjectKey, model.ResourceStatusReady).
		Updates(map[string]any{
			"provider": job.TargetProvider, "endpoint": job.TargetEndpoint, "bucket": job.TargetBucket,
			"storage_setting_id": job.TargetStorageSettingID, "object_key": job.TargetObjectKey, "e_tag": etag,
			// 播放副本只服务本地资源；切到对象存储后与其他远端视频一致，按原片播放。
			"playback_status": model.PlaybackStatusNone, "playback_object_key": "", "playback_error": "",
			"updated_at": time.Now(),
		})
	return result.RowsAffected == 1, result.Error
}

// LocalFallbackBytes 统计仍占用本地磁盘的兜底文件，用于限制兜底总量。
func (r *Repository) LocalFallbackBytes() (int64, error) {
	var total int64
	err := r.db.Model(&model.ResourceOffloadJob{}).
		Select("COALESCE(SUM(size), 0)").
		Where("status IN ? OR (status = ? AND local_deleted_at IS NULL)",
			[]model.ResourceOffloadStatus{model.ResourceOffloadStatusPending, model.ResourceOffloadStatusProcessing, model.ResourceOffloadStatusFailed},
			model.ResourceOffloadStatusDone).
		Scan(&total).Error
	return total, err
}

func (r *Repository) DueResourceOffloadCleanups(now time.Time, limit int) ([]model.ResourceOffloadJob, error) {
	var jobs []model.ResourceOffloadJob
	err := r.db.Where("status = ? AND local_deleted_at IS NULL AND local_delete_after <= ?", model.ResourceOffloadStatusDone, now).
		Order("local_delete_after asc").Limit(limit).Find(&jobs).Error
	return jobs, err
}

func (r *Repository) MarkResourceOffloadLocalDeleted(id string) error {
	now := time.Now()
	return r.db.Model(&model.ResourceOffloadJob{}).Where("id = ? AND local_deleted_at IS NULL", id).
		Updates(map[string]any{"local_deleted_at": &now, "updated_at": now}).Error
}

// ResourceOffloadSummary 是管理后台“待同步到对象存储”的概况。
type ResourceOffloadSummary struct {
	Pending       int64      `json:"pending"`
	PendingBytes  int64      `json:"pendingBytes"`
	Failed        int64      `json:"failed"`
	OldestPending *time.Time `json:"oldestPending,omitempty"`
	LastErrorCode string     `json:"lastErrorCode,omitempty"`
}

func (r *Repository) ResourceOffloadSummary() (ResourceOffloadSummary, error) {
	var summary ResourceOffloadSummary
	active := []model.ResourceOffloadStatus{model.ResourceOffloadStatusPending, model.ResourceOffloadStatusProcessing}
	var row struct {
		Count int64
		Bytes int64
	}
	if err := r.db.Model(&model.ResourceOffloadJob{}).Select("COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes").Where("status IN ?", active).Scan(&row).Error; err != nil {
		return summary, err
	}
	summary.Pending, summary.PendingBytes = row.Count, row.Bytes
	if err := r.db.Model(&model.ResourceOffloadJob{}).Where("status = ?", model.ResourceOffloadStatusFailed).Count(&summary.Failed).Error; err != nil {
		return summary, err
	}
	var oldest model.ResourceOffloadJob
	result := r.db.Where("status IN ?", active).Order("created_at asc").Limit(1).Find(&oldest)
	if result.Error != nil {
		return summary, result.Error
	}
	if result.RowsAffected == 1 {
		summary.OldestPending = &oldest.CreatedAt
		var latest model.ResourceOffloadJob
		if err := r.db.Where("status IN ? AND last_error_code <> ''", active).Order("updated_at desc").Limit(1).Find(&latest).Error; err != nil {
			return summary, err
		}
		summary.LastErrorCode = latest.LastErrorCode
	}
	return summary, nil
}

// ExpediteResourceOffloadJobs 在某个存储位置恢复写入后，把同一位置等待退避的补传提前。
func (r *Repository) ExpediteResourceOffloadJobs(provider, endpoint, bucket string, now time.Time) error {
	return r.db.Model(&model.ResourceOffloadJob{}).
		Where("status = ? AND target_provider = ? AND target_endpoint = ? AND target_bucket = ? AND next_attempt_at > ?", model.ResourceOffloadStatusPending, provider, endpoint, bucket, now).
		Updates(map[string]any{"next_attempt_at": now, "updated_at": now}).Error
}

// LocalObjectReferenced 判断是否还有资源行使用这份本地文件，删除本地文件前必须为 false。
func (r *Repository) LocalObjectReferenced(objectKey string) (bool, error) {
	var count int64
	err := r.db.Model(&model.Resource{}).Where("COALESCE(provider, '') IN ? AND object_key = ?", []string{"", "local"}, objectKey).Count(&count).Error
	return count > 0, err
}
