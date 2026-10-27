package model

import "time"

type ResourceOffloadStatus string

const (
	ResourceOffloadStatusPending    ResourceOffloadStatus = "pending"
	ResourceOffloadStatusProcessing ResourceOffloadStatus = "processing"
	// done 表示资源已切换到对象存储；本地文件在 LocalDeleteAfter 之后清理。
	ResourceOffloadStatusDone      ResourceOffloadStatus = "done"
	ResourceOffloadStatusCancelled ResourceOffloadStatus = "cancelled"
	// failed 只用于无法自动恢复的情况（例如本地文件丢失），需要人工处理。
	ResourceOffloadStatusFailed ResourceOffloadStatus = "failed"
)

// ResourceOffloadJob 记录“对象存储写入失败、生成作品先保存到本地”的资源，
// 由后台 worker 补传到原定的对象存储位置。Target* 冻结首次上传时的存储位置
// 和对象键，重试始终写同一个对象，不产生孤儿对象。
type ResourceOffloadJob struct {
	ID                     string                `json:"id" gorm:"primaryKey;size:36"`
	UserID                 string                `json:"userId" gorm:"index;size:36"`
	ResourceID             string                `json:"resourceId" gorm:"uniqueIndex;size:36"`
	TaskID                 string                `json:"taskId" gorm:"index;size:36"`
	Size                   int64                 `json:"size"`
	LocalObjectKey         string                `json:"localObjectKey"`
	TargetProvider         string                `json:"targetProvider" gorm:"size:24"`
	TargetEndpoint         string                `json:"targetEndpoint"`
	TargetBucket           string                `json:"targetBucket" gorm:"size:160"`
	TargetStorageSettingID string                `json:"-" gorm:"size:36"`
	TargetObjectKey        string                `json:"targetObjectKey"`
	Status                 ResourceOffloadStatus `json:"status" gorm:"size:24;index:idx_resource_offload_jobs_due,priority:1"`
	Attempts               int                   `json:"attempts"`
	LastErrorCode          string                `json:"lastErrorCode" gorm:"size:80"`
	LastError              string                `json:"lastError" gorm:"type:text"`
	NextAttemptAt          time.Time             `json:"nextAttemptAt" gorm:"index:idx_resource_offload_jobs_due,priority:2"`
	LeaseOwner             string                `json:"-" gorm:"size:120"`
	LeaseExpiresAt         *time.Time            `json:"-"`
	// 切换到对象存储时记下的本地播放副本，和原文件一起延迟清理。
	LocalPlaybackKey string     `json:"-"`
	LocalDeleteAfter *time.Time `json:"localDeleteAfter,omitempty" gorm:"index"`
	LocalDeletedAt   *time.Time `json:"localDeletedAt,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
}
