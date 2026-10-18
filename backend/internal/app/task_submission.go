package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func taskSubmissionHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func taskSubmissionError(err error) error {
	if errors.Is(err, repository.ErrTaskSubmissionConflict) || errors.Is(err, repository.ErrTaskSubmissionDeleted) || errors.Is(err, repository.ErrTaskRetryUnconfirmed) {
		return NewAppError(409, err.Error())
	}
	return err
}

func (s *Service) prepareTaskSubmission(userID string, req CreateTaskRequest) (*model.TaskSubmissionReceipt, *model.Task, error) {
	metadata, _ := req.Input["metadata"].(map[string]any)
	operationID := metadataString(metadata, "clientOperationId")
	retryOf := metadataString(metadata, "retryOf")
	// Existing creation tabs already carry a stable message identity.
	if operationID == "" && metadataString(metadata, "source") == "create-page" && metadataString(metadata, "conversationId") != "" && metadataString(metadata, "messageId") != "" {
		identity, _ := json.Marshal([]any{metadata["conversationId"], metadata["messageId"], metadata["batchIndex"]})
		operationID = "creation:" + string(identity)
	}
	if operationID == "" && retryOf == "" {
		return nil, nil, nil
	}
	if len(operationID) > 512 || len(retryOf) > 36 {
		return nil, nil, BadAuthRequest("生成操作标识无效")
	}
	key := "operation:" + operationID
	if retryOf != "" {
		key = "retry:" + retryOf
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		return nil, nil, err
	}
	var fingerprint map[string]any
	if err := json.Unmarshal(encoded, &fingerprint); err != nil {
		return nil, nil, err
	}
	if input, ok := fingerprint["input"].(map[string]any); ok {
		if meta, ok := input["metadata"].(map[string]any); ok {
			for _, name := range []string{"clientOperationId", "conversationId", "messageId", "retryOf", "attemptGroupId"} {
				delete(meta, name)
			}
		}
	}
	encoded, err = json.Marshal(fingerprint)
	if err != nil {
		return nil, nil, err
	}
	receipt := &model.TaskSubmissionReceipt{UserID: userID, KeyHash: taskSubmissionHash(key), OperationHash: taskSubmissionHash(operationID), RequestHash: taskSubmissionHash(string(encoded)), RetryOf: retryOf}
	existing, err := s.repo.TaskSubmission(userID, receipt.KeyHash)
	if err == nil {
		if existing.RequestHash != receipt.RequestHash {
			return nil, nil, taskSubmissionError(repository.ErrTaskSubmissionConflict)
		}
		task, err := s.repo.TaskForUser(userID, existing.TaskID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, taskSubmissionError(repository.ErrTaskSubmissionDeleted)
		}
		return nil, task, err
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil, err
	}
	if retryOf != "" {
		parent, err := s.repo.TaskForUser(userID, retryOf)
		if err != nil {
			return nil, nil, NotFound("原生成任务不存在")
		}
		if parent.AgentRunID != "" || parent.GenerationID != "" || parent.CreationSubmissionID != nil || strings.HasPrefix(parent.Operation, "cloud_agent") || taskHasAgentOrigin(parent.InputJSON) {
			return nil, nil, BadAuthRequest("请通过原创作审批入口重试任务")
		}
		if parent.Type != req.Type || parent.ProjectID != req.ProjectID {
			return nil, nil, BadAuthRequest("重试任务与原任务不匹配")
		}
		if parent.Status == model.TaskStatusQueued || parent.Status == model.TaskStatusRunning || parent.Status == model.TaskStatusSucceeded {
			return nil, parent, nil
		}
		if parent.MediaRecoveryJSON != "" {
			return nil, nil, BadAuthRequest("作品已生成，请重试保存，不要重复生成")
		}
		if isContentModerationFailure(parent.Error) {
			return nil, nil, BadAuthRequest(contentModerationRetryMessage)
		}
	}
	return receipt, nil, nil
}

// Resolving a lost creation response is read-only and scoped to the current user.
func (s *Service) ResolveTaskSubmissions(userID string, operationIDs []string) ([]model.Task, error) {
	if len(operationIDs) == 0 || len(operationIDs) > 15 {
		return nil, BadAuthRequest("每次最多查询 15 个生成操作")
	}
	tasks := make([]model.Task, 0, len(operationIDs))
	for _, operationID := range operationIDs {
		if strings.TrimSpace(operationID) == "" || len(operationID) > 512 {
			return nil, BadAuthRequest("生成操作标识无效")
		}
		receipt, err := s.repo.TaskSubmissionForOperation(userID, taskSubmissionHash(operationID))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		task, err := s.repo.TaskForUser(userID, receipt.TaskID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, *taskForOutput(*task))
	}
	return tasks, nil
}
