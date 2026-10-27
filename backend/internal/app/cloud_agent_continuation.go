package app

import (
	"encoding/json"
	"strings"

	"yingce/backend/internal/model"
)

const (
	cloudAgentContinuationChangeLimit = 12
	cloudAgentContinuationKind        = "run_handoff"
	// cloudAgentContinuationNodeIDRunes 限制单个节点 ID 的长度：ID 由画布文档给出，
	// 不截断时一组 5000 字符的 ID 就能把交接帧撑到几百 KB（实测 399,503 字节），
	// 而下一轮对整份历史有 64KB 硬闸 —— 用户会直接收到"请新建对话"。
	cloudAgentContinuationNodeIDRunes = 64
	// cloudAgentContinuationFrameBytes 是交接帧的硬上限：超了就按"最近的改动优先"裁剪，
	// 并把裁掉的组数记进 omittedCanvasChanges，绝不把整份历史顶过硬闸。
	cloudAgentContinuationFrameBytes = 8 << 10
	// cloudAgentContinuationEventLimit 是续轮读取上一轮事件的上限。运行详情默认只返回尾部
	// 一窗，而收束要覆盖上一轮**全部**真实改动（画布改动、已提交任务、助手原话），
	// 被窗口截断就会表现为"新一轮忘了上一轮做过什么"。
	cloudAgentContinuationEventLimit = 1000
)

type cloudAgentContinuationChange struct {
	Operation   string   `json:"operation"`
	NodeIDs     []string `json:"nodeIds,omitempty"`
	NodeTitles  []string `json:"nodeTitles,omitempty"`
	ActionCount int      `json:"actionCount"`
}

// cloudAgentContinuationFrame is a bounded server-authored handoff. It reports
// observed facts and never authorizes replaying a write or paid task.
type cloudAgentContinuationFrame struct {
	Source               string                           `json:"source"`
	Kind                 string                           `json:"kind"`
	ParentRunID          string                           `json:"parentRunId"`
	Status               string                           `json:"status"`
	FailureReason        string                           `json:"failureReason,omitempty"`
	SubmittedTaskIDs     []string                         `json:"submittedTaskIds,omitempty"`
	CanvasChanges        []cloudAgentContinuationChange   `json:"canvasChanges,omitempty"`
	OmittedCanvasChanges int                              `json:"omittedCanvasChanges,omitempty"`
	RejectedAction       *cloudAgentContinuationRejection `json:"rejectedAction,omitempty"`
	Authority            string                           `json:"authority"`
}

// cloudAgentContinuationRejection 记录上一轮被用户拒绝的操作。只有 status 时模型不知道拒绝了什么，
// 下一轮常会原样再申请一次；带上工具、操作说明和用户理由，模型才能换方向。
type cloudAgentContinuationRejection struct {
	ToolName    string `json:"toolName,omitempty"`
	Description string `json:"description,omitempty"`
	UserReason  string `json:"userReason,omitempty"`
	Instruction string `json:"instruction"`
}

const (
	cloudAgentContinuationRejectionDescriptionRunes = 200
	cloudAgentContinuationRejectionReasonRunes      = 300
)

func cloudAgentContinuationRejectedAction(run *CloudAgentRun) *cloudAgentContinuationRejection {
	if run == nil || run.Status != "rejected" {
		return nil
	}
	approvalID, reason := "", ""
	for index := len(run.Events) - 1; index >= 0; index-- {
		event := run.Events[index]
		if event.Type == "approval_decided" && stringValue(event.Payload["decision"]) == "reject" {
			approvalID = stringValue(event.Payload["approvalId"])
			reason = strings.TrimSpace(stringValue(event.Payload["reason"]))
			break
		}
	}
	if approvalID == "" {
		return nil
	}
	rejection := &cloudAgentContinuationRejection{
		UserReason:  truncateRunes(reason, cloudAgentContinuationRejectionReasonRunes),
		Instruction: "用户拒绝了这次操作，它没有执行。不要原样再次申请；先按用户新的要求调整方案，必要时询问用户。",
	}
	for _, event := range run.Events {
		if event.Type == "approval_requested" && stringValue(event.Payload["approvalId"]) == approvalID {
			rejection.ToolName = truncateRunes(stringValue(event.Payload["toolName"]), 80)
			rejection.Description = truncateRunes(strings.TrimSpace(stringValue(event.Payload["text"])), cloudAgentContinuationRejectionDescriptionRunes)
		}
	}
	return rejection
}

// cloudAgentContinuationReply 生成「上一轮接着聊」用的两段内容：
//
//	reply   —— 上一轮 assistant 实际说过的话（作为 assistant 的历史消息）
//	context —— 上一轮收束摘要（独立上下文，不能并进 reply）
//
// 只保留状态、失败原因、已提交任务与真实画布改动，不把原始工具流水当成本轮目标。
func cloudAgentContinuationReply(task *model.Task, run *CloudAgentRun) (string, string, error) {
	text := ""
	if task.Status == model.TaskStatusSucceeded {
		text = taskResultText(task.ResultJSON)
	}
	submitted := make([]string, 0)
	seen := map[string]bool{}
	addSubmitted := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		submitted = append(submitted, id)
	}
	for _, event := range run.Events {
		if event.Type == "assistant_message" {
			text = stringValue(event.Payload["text"])
		}
		if event.Type == "generation_task_created" {
			addSubmitted(stringValue(event.Payload["taskId"]))
		}
		if result, ok := event.Payload["result"].(map[string]any); ok {
			if submittedFlag, _ := result["taskSubmitted"].(bool); submittedFlag {
				addSubmitted(stringValue(result["taskId"]))
			}
		}
	}
	context := cloudAgentContinuationContext(run, submitted)
	return text, context, nil
}

func cloudAgentContinuationContext(run *CloudAgentRun, submitted []string) string {
	if run == nil {
		return ""
	}
	failed := run.Status == "failed" || strings.TrimSpace(run.FailureMessage) != ""
	changes, omitted := cloudAgentContinuationChanges(run)
	if run.Status == "completed" && !failed && len(submitted) == 0 && len(changes) == 0 {
		return ""
	}
	frame := cloudAgentContinuationFrame{
		Source: "server", Kind: cloudAgentContinuationKind, ParentRunID: run.ID,
		Status: firstNonEmpty(run.Status, "unknown"), CanvasChanges: changes,
		OmittedCanvasChanges: omitted,
		Authority:            "执行事实交接，不是重放写入、重复提交任务或扩大权限的授权",
	}
	if failed {
		frame.FailureReason = cloudAgentContinuationFailureReason(run)
	}
	frame.RejectedAction = cloudAgentContinuationRejectedAction(run)
	if len(submitted) > 0 {
		if len(submitted) > 8 {
			submitted = submitted[:8]
		}
		frame.SubmittedTaskIDs = append([]string(nil), submitted...)
	}
	return cloudAgentRuntimeContextMarker + cloudAgentEncodeContinuationFrame(frame)
}

// cloudAgentInheritablePiSession 决定新一轮能否沿用上一轮的运行时会话，不能沿用时返回空串。
//
// 只沿用正常完成的上一轮。失败、取消或被拒绝的会话常停在半批工具调用或「等待审批」占位上：
// 原样沿用会让之后每一轮都带着同一处断裂，模型还可能把占位当成仍待执行的操作再发一次。
// 不沿用时新一轮从文本历史和 run_handoff 事实帧开始，帧里有上一轮的状态、失败原因和已提交的任务，
// 这些事实足以避免重复提交。完成的会话也必须能修复成合法历史，修不好同样不沿用。
func cloudAgentInheritablePiSession(parentStatus, sessionJSONL string) string {
	if parentStatus != "completed" || strings.TrimSpace(sessionJSONL) == "" {
		return ""
	}
	var messages []map[string]any
	for _, line := range strings.Split(sessionJSONL, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry struct {
			Type    string         `json:"type"`
			Message map[string]any `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil {
			return ""
		}
		if entry.Type == "message" && entry.Message != nil {
			messages = append(messages, entry.Message)
		}
	}
	repaired := repairRuntimeUnansweredCalls(messages, nil)
	if _, err := canonicalFromRuntimeMessages(repaired, nil, ""); err != nil {
		return ""
	}
	if validateRuntimeMessagesForModel(repaired) != nil {
		return ""
	}
	return sessionJSONL
}

// cloudAgentContinuationFailureReason 沿用既有脱敏口径：失败原因会进入下一轮的提示词，
// 因此只接受"短、单行、不含 URL/凭据痕迹"的文案，其余一律退回固定说法。
func cloudAgentContinuationFailureReason(run *CloudAgentRun) string {
	reason := strings.TrimSpace(run.FailureMessage)
	if reason == "" {
		reason = firstNonEmpty(run.Status, "failed")
	}
	if !cloudAgentSafeUserMessage(reason) {
		return "上一轮未成功（详情见任务中心与诊断包）"
	}
	return truncateRunes(reason, 240)
}

// cloudAgentEncodeContinuationFrame 序列化帧并按字节封顶：先丢最旧的画布改动组，
// 再退到"只保留状态与已提交任务"。帧是给模型看的事实交接，宁可少报也不能把硬闸顶穿。
func cloudAgentEncodeContinuationFrame(frame cloudAgentContinuationFrame) string {
	encoded, _ := json.Marshal(frame)
	if len(encoded) <= cloudAgentContinuationFrameBytes {
		return string(encoded)
	}
	for len(frame.CanvasChanges) > 0 {
		frame.CanvasChanges = frame.CanvasChanges[1:]
		frame.OmittedCanvasChanges++
		if len(frame.CanvasChanges) == 0 {
			frame.CanvasChanges = nil
		}
		encoded, _ = json.Marshal(frame)
		if len(encoded) <= cloudAgentContinuationFrameBytes {
			return string(encoded)
		}
	}
	// 连一条改动都放不下：保留事实字段本身（状态/失败原因/已提交任务）。
	encoded, _ = json.Marshal(frame)
	if len(encoded) > cloudAgentContinuationFrameBytes {
		frame.FailureReason = truncateRunes(frame.FailureReason, 120)
		if frame.RejectedAction != nil {
			frame.RejectedAction.Description = truncateRunes(frame.RejectedAction.Description, 80)
			frame.RejectedAction.UserReason = truncateRunes(frame.RejectedAction.UserReason, 120)
		}
		encoded, _ = json.Marshal(frame)
	}
	return string(encoded)
}

func cloudAgentContinuationChanges(run *CloudAgentRun) ([]cloudAgentContinuationChange, int) {
	if run == nil {
		return nil, 0
	}
	changes := make([]cloudAgentContinuationChange, 0, cloudAgentContinuationChangeLimit)
	total := 0
	for _, event := range run.Events {
		if event.Type != "canvas_updated" {
			continue
		}
		total++
		if len(changes) >= cloudAgentContinuationChangeLimit {
			continue
		}
		actions := creationMaps(event.Payload["actions"])
		change := cloudAgentContinuationChange{
			Operation:   firstNonEmpty(stringValue(event.Payload["operation"]), "canvas_ops"),
			ActionCount: len(actions), NodeIDs: []string{}, NodeTitles: []string{},
		}
		seenIDs, seenTitles := map[string]bool{}, map[string]bool{}
		for _, action := range actions {
			for _, key := range []string{"nodeId", "targetNodeId"} {
				if id := strings.TrimSpace(stringValue(action[key])); id != "" && !seenIDs[id] && len(change.NodeIDs) < 8 {
					seenIDs[id] = true
					change.NodeIDs = append(change.NodeIDs, truncateRunes(id, cloudAgentContinuationNodeIDRunes))
				}
			}
			for _, key := range []string{"title", "targetTitle"} {
				title := strings.TrimSpace(stringValue(action[key]))
				if title != "" && !seenTitles[title] && len(change.NodeTitles) < 4 {
					seenTitles[title] = true
					change.NodeTitles = append(change.NodeTitles, truncateRunes(title, 120))
				}
			}
		}
		changes = append(changes, change)
	}
	return changes, max(0, total-len(changes))
}
