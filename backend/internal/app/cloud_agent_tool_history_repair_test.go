package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func canonicalCallMessage(ids ...string) map[string]any {
	calls := make([]interface{}, 0, len(ids))
	for _, id := range ids {
		calls = append(calls, map[string]interface{}{"id": id, "function": map[string]interface{}{"name": "generate_media", "arguments": "{}"}})
	}
	return map[string]any{"role": "assistant", "content": "", "tool_calls": calls}
}

// 补齐的「未执行」结果落库后，真实回执才追加到历史末尾：同一调用出现两份结果，
// 原先第二份会以「工具结果没有对应的工具调用」判死整轮。真实回执必须留在调用后面。
func TestRepairCanonicalHistoryKeepsLateReceiptInPlace(t *testing.T) {
	receipt := `{"taskSubmitted":true,"taskId":"paid-task"}`
	messages := []map[string]any{
		{"role": "user", "content": "生成视频"},
		canonicalCallMessage("media"),
		{"role": "tool", "tool_call_id": "media", "content": cloudAgentPiUnansweredCallText},
		{"role": "user", "content": "继续"},
		{"role": "tool", "tool_call_id": "media", "content": receipt},
	}
	repaired := repairCanonicalUnansweredCalls(messages)
	if err := validateCanonicalAgentHistory(&canonicalAgentRequest{Messages: repaired}, false); err != nil {
		t.Fatalf("repaired history still invalid: %v", err)
	}
	if len(repaired) != 4 || stringField(repaired[2], "content") != receipt {
		t.Fatalf("late receipt not moved into the call slot: %#v", repaired)
	}
	if stringField(messages[2], "content") != cloudAgentPiUnansweredCallText {
		t.Fatal("repair mutated input history")
	}
}

func TestRepairCanonicalHistoryKeepsFirstRealResult(t *testing.T) {
	messages := []map[string]any{
		canonicalCallMessage("read"),
		{"role": "tool", "tool_call_id": "read", "content": `{"ok":1}`},
		{"role": "tool", "tool_call_id": "read", "content": `{"ok":2}`},
	}
	repaired := repairCanonicalUnansweredCalls(messages)
	if len(repaired) != 2 || stringField(repaired[1], "content") != `{"ok":1}` {
		t.Fatalf("duplicate real result handling changed: %#v", repaired)
	}
}

// 调用所在消息已不在历史里时，结果原文转成运行状态数据消息，放在当前批次的结果之后。
func TestRepairCanonicalHistoryTurnsOrphanResultIntoData(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": "继续"},
		canonicalCallMessage("current"),
		{"role": "tool", "tool_call_id": "evicted", "content": `{"taskSubmitted":true,"taskId":"old-task"}`},
		{"role": "tool", "tool_call_id": "current", "content": `{}`},
		{"role": "user", "content": "下一步"},
	}
	repaired := repairCanonicalUnansweredCalls(messages)
	if err := validateCanonicalAgentHistory(&canonicalAgentRequest{Messages: repaired}, false); err != nil {
		t.Fatalf("repaired history still invalid: %v", err)
	}
	if len(repaired) != 5 || stringField(repaired[2], "tool_call_id") != "current" {
		t.Fatalf("orphan was not removed from the tool block: %#v", repaired)
	}
	note := stringField(repaired[3], "content")
	if stringField(repaired[3], "role") != "user" || !strings.Contains(note, "orphan_tool_results") || !strings.Contains(note, "old-task") {
		t.Fatalf("orphan facts were lost: %#v", repaired[3])
	}
}

func TestRepairCanonicalHistoryDropsUnusableCallIDs(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": "开始"},
		{"role": "assistant", "content": "先读取", "tool_calls": []interface{}{
			map[string]interface{}{"id": "a", "call_id": "b", "function": map[string]interface{}{"name": "canvas_get_state", "arguments": "{}"}},
			map[string]interface{}{"id": "ok", "function": map[string]interface{}{"name": "canvas_get_state", "arguments": "{}"}},
			map[string]interface{}{"id": "ok", "function": map[string]interface{}{"name": "canvas_get_state", "arguments": "{}"}},
		}},
		{"role": "tool", "tool_call_id": "ok", "content": "{}"},
	}
	repaired := repairCanonicalUnansweredCalls(messages)
	if err := validateCanonicalAgentHistory(&canonicalAgentRequest{Messages: repaired}, false); err != nil {
		t.Fatalf("repaired history still invalid: %v", err)
	}
	if calls := canonicalAgentToolCalls(repaired[1]["tool_calls"]); len(calls) != 1 {
		t.Fatalf("unusable calls kept: %#v", calls)
	}
}

// 运行时历史里的调用 ID 别名冲突原先直接让模型请求失败，且每一步都会重复失败。
func TestCloudAgentPiCanonicalSurvivesConflictingCallID(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": "整理画布"},
		{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": "a", "call_id": "b", "name": "canvas_get_state", "arguments": map[string]any{}}}},
		{"role": "toolResult", "toolCallId": "a", "content": "{}"},
		{"role": "user", "content": "继续"},
	}
	canonical, err := cloudAgentPiCanonicalForModelRequest(messages, canonicalAgentRequest{SystemPrompt: "Agent system prompt"})
	if err != nil {
		t.Fatalf("conflicting call id still fails the step: %v", err)
	}
	if err := validateCanonicalAgentHistory(&canonical, false); err != nil {
		t.Fatalf("history still invalid: %v", err)
	}
}

// 审批暂停留下的「等待审批」占位在批准执行后应换成服务端保存的真实回执。
func TestRepairRuntimeHistoryReplacesPausePlaceholderWithReceipt(t *testing.T) {
	receipt := `{"taskSubmitted":true,"taskId":"paid-task"}`
	messages := []map[string]any{
		{"role": "user", "content": "生成视频"},
		{"role": "assistant", "content": []any{runtimeToolCallPart("media", "generate_media")}},
		{"role": "toolResult", "toolCallId": "media", "content": []any{map[string]any{"type": "text", "text": cloudAgentPiApprovalPauseText}}, "isError": true, "details": map[string]any{"paused": true}},
		{"role": "user", "content": "用户已批准"},
	}
	server := []map[string]any{
		{"role": "user", "content": "生成视频"},
		canonicalCallMessage("media"),
		{"role": "tool", "tool_call_id": "media", "content": receipt},
	}
	repaired := repairRuntimeUnansweredCalls(messages, server)
	if runtimeContentText(repaired[2]["content"]) != receipt || repaired[2]["isError"] != false {
		t.Fatalf("pause placeholder kept after receipt was saved: %#v", repaired[2])
	}
	if runtimeContentText(messages[2]["content"]) != cloudAgentPiApprovalPauseText {
		t.Fatal("repair mutated runtime transcript")
	}
}

// 回执只能接到同一工具的调用上；别的工具的结果不能冒充已执行。
func TestRepairRuntimeHistoryIgnoresReceiptFromOtherTool(t *testing.T) {
	messages := []map[string]any{
		{"role": "assistant", "content": []any{runtimeToolCallPart("call_0", "generate_media")}},
	}
	server := []map[string]any{
		{"role": "assistant", "content": "", "tool_calls": []interface{}{map[string]interface{}{"id": "call_0", "function": map[string]interface{}{"name": "canvas_get_state", "arguments": "{}"}}}},
		{"role": "tool", "tool_call_id": "call_0", "content": `{"nodes":[]}`},
	}
	repaired := repairRuntimeUnansweredCalls(messages, server)
	if !strings.Contains(runtimeContentText(repaired[1]["content"]), cloudAgentToolErrorApprovalDeferred) {
		t.Fatalf("receipt from another tool was attached: %#v", repaired[1])
	}
}

const inheritableSessionJSONL = `{"type":"session","version":3,"id":"s0","timestamp":"2026-10-26T00:00:00Z","cwd":"/"}
{"type":"message","id":"m1","parentId":"s0","message":{"role":"user","content":[{"type":"text","text":"整理画布"}]}}
{"type":"message","id":"m2","parentId":"m1","message":{"role":"assistant","content":[{"type":"text","text":"已整理"}],"stopReason":"stop"}}
`

func TestCloudAgentInheritablePiSessionOnlyFromCompletedRuns(t *testing.T) {
	for _, status := range []string{"failed", "cancelled", "rejected"} {
		if got := cloudAgentInheritablePiSession(status, inheritableSessionJSONL); got != "" {
			t.Fatalf("%s parent session was inherited", status)
		}
	}
	if got := cloudAgentInheritablePiSession("completed", inheritableSessionJSONL); got != inheritableSessionJSONL {
		t.Fatal("completed parent session was not inherited")
	}
	if got := cloudAgentInheritablePiSession("completed", "{not json"); got != "" {
		t.Fatal("unreadable session was inherited")
	}
}

func TestCloudAgentContinuationSkipsSessionOfFailedParent(t *testing.T) {
	for _, tc := range []struct {
		status  string
		inherit bool
	}{{"completed", true}, {"failed", false}, {"cancelled", false}} {
		t.Run(tc.status, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			if err := db.Create(&model.CanvasProject{ID: "agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[]}`}).Error; err != nil {
				t.Fatal(err)
			}
			req := agentTestRequest()
			root, err := s.CreateCloudAgentRun("user", req, "")
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", root.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"上一轮回复"}`}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.CloudAgentExecution{}).Where("id = ?", root.ID).Updates(map[string]any{"status": tc.status, "cleanup_pending": false}).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.repo.SaveCloudAgentPiSession(&model.CloudAgentPiSession{RunID: root.ID, UserID: "user", SessionJSONL: inheritableSessionJSONL, UpdatedAt: time.Now()}, 0); err != nil {
				t.Fatal(err)
			}
			next := req
			next.IdempotencyKey = "agent-next-" + tc.status
			child, err := s.CreateCloudAgentRun("user", next, root.ID)
			if err != nil {
				t.Fatal(err)
			}
			var task model.Task
			if err := db.First(&task, "id = ?", child.ID).Error; err != nil {
				t.Fatal(err)
			}
			var input struct {
				PiSessionJSONL string                `json:"piSessionJSONL"`
				TextHistory    []providerTextMessage `json:"textHistory"`
			}
			if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
				t.Fatal(err)
			}
			if (input.PiSessionJSONL != "") != tc.inherit {
				t.Fatalf("inherited=%v, want %v", input.PiSessionJSONL != "", tc.inherit)
			}
			if !tc.inherit {
				handoff := false
				for _, message := range input.TextHistory {
					handoff = handoff || isCloudAgentContinuationMessage(message)
				}
				if !handoff {
					t.Fatalf("fresh session lost the parent handoff frame: %+v", input.TextHistory)
				}
			}
		})
	}
}

func TestCloudAgentMediaSizeRatioMaterializedAsPixelsIsSameSpec(t *testing.T) {
	input := map[string]any{"mode": "image", "config": map[string]any{"size": "1824x1024"}, "capabilityOptions": map[string]any{"size": "1824x1024"}}
	if err := validateCloudAgentResolvedMediaOptions(map[string]any{"size": "16:9"}, input); err != nil {
		t.Fatalf("ratio materialized as preset pixels was rejected: %v", err)
	}
	for _, requested := range []string{"9:16", "1:1", "1024x1024"} {
		if err := validateCloudAgentResolvedMediaOptions(map[string]any{"size": requested}, input); err == nil {
			t.Fatalf("different frame %q accepted", requested)
		}
	}
	ratioModel := map[string]any{"mode": "image", "config": map[string]any{"size": "1:1"}, "capabilityOptions": map[string]any{"size": "1:1"}}
	if err := validateCloudAgentResolvedMediaOptions(map[string]any{"size": "2048x2048"}, ratioModel); err == nil {
		t.Fatal("pixels collapsed to a ratio must still be reported")
	}
}

// 批准后报价已过期：没有提交任务和订单，运行继续，恢复提示说明提交前未通过，而不是"已执行一次"。
func TestCloudAgentExpiredApprovalQuoteContinuesWithoutCharge(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentTool(run, &state); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if state.Approval == nil || state.Approval.Prepared == nil {
		t.Fatalf("approval was not prepared: %s %s", run.Status, run.FailureMessage)
	}
	approvalID := state.Approval.ID
	state.Approval.Prepared.Quote.ExpiresAt = time.Now().Add(-time.Minute)
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DecideCloudAgentApproval("user", run.ID, approvalID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if run.Status != "running" {
		t.Fatalf("expired quote terminated the run: %s %s", run.Status, run.FailureMessage)
	}
	var tasks, orders int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks)
	db.Model(&model.BillingOrder{}).Where("capability = ?", "video").Count(&orders)
	if tasks != 0 || orders != 0 || state.MediaTaskID != "" {
		t.Fatalf("expired approval created paid work: tasks=%d orders=%d", tasks, orders)
	}
	last := stringField(state.Canonical.Messages[len(state.Canonical.Messages)-1], "content")
	if !strings.Contains(last, "approval_stale") || !strings.Contains(last, `"taskSubmitted":false`) {
		t.Fatalf("stale approval receipt missing: %s", last)
	}
	if !strings.Contains(state.PiResumePrompt, "提交前校验未通过") || strings.Contains(state.PiResumePrompt, "已执行一次") {
		t.Fatalf("resume prompt misreports the approval: %s", state.PiResumePrompt)
	}
	if repair := state.ToolRepairs["generate_media"]; repair.Attempt != 1 {
		t.Fatalf("stale approval must count toward the repair limit: %+v", repair)
	}
}
