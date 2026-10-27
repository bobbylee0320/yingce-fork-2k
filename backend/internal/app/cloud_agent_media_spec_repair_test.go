package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestCloudAgentMediaSpecMismatchHasRepairableField(t *testing.T) {
	for _, tc := range []struct{ key, field, requested, resolved string }{
		{"size", "size", "9:16", "16:9"},
		{"videoSeconds", "durationSeconds", "8", "5"},
		{"vquality", "quality", "1080p", "720p"},
		{"imageResolution", "imageResolution", "4k", "2k"},
		{"videoGenerateAudio", "videoGenerateAudio", "true", "false"},
		{"count", "count", "2", "1"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			input := map[string]any{"mode": "video", "config": map[string]any{tc.key: tc.resolved}}
			err := validateCloudAgentResolvedMediaOptions(map[string]any{tc.key: tc.requested}, input)
			var fieldErr *cloudAgentFieldArgumentError
			var argumentErr *cloudAgentArgumentError
			if !errors.As(err, &fieldErr) || fieldErr.Field != tc.field || fieldErr.Issue != "invalid_value" || !errors.As(cloudAgentWrapMediaAdmissionError(err), &argumentErr) {
				t.Fatalf("spec mismatch cannot enter bounded repair: %v", err)
			}
			if message := cloudAgentSafeToolError(err); !strings.Contains(message, tc.requested) || !strings.Contains(message, tc.resolved) {
				t.Fatalf("spec mismatch lost actionable values: %q", message)
			}
		})
	}
}

func TestCloudAgentMediaSpecResolutionAlias(t *testing.T) {
	input := map[string]any{
		"mode": "image", "config": map[string]any{"quality": "", "imageResolution": "2k"},
		"capabilityOptions": map[string]any{"imageResolution": "2k"},
	}
	if err := validateCloudAgentResolvedMediaOptions(map[string]any{"quality": "2K"}, input); err != nil {
		t.Fatalf("equivalent resolution alias rejected: %v", err)
	}
	for _, requested := range []map[string]any{{"quality": "4k"}, {"quality": "high"}, {"quality": "2k", "imageResolution": "4k"}} {
		if err := validateCloudAgentResolvedMediaOptions(requested, input); err == nil {
			t.Fatalf("changed explicit resolution accepted: %#v", requested)
		}
	}
}

func TestCloudAgentMediaSpecRepairIsBoundedAndNeverSubmits(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	err := validateCloudAgentResolvedMediaOptions(map[string]any{"videoSeconds": "8"}, map[string]any{"mode": "video", "config": map[string]any{"videoSeconds": "5"}})
	for attempt := 1; attempt <= cloudAgentToolAttemptLimit; attempt++ {
		// 模拟模型下一次仍提出相同错误规格，跨真实数据库检查点保留修正次数。
		state.Calls, state.CallIndex = []cloudAgentCall{agentMediaCall(a)}, 0
		if err := s.cloudAgentMediaError(run, &state, "admission", false, false, err); err != nil {
			t.Fatal(err)
		}
		run, state = agentInterjectionState(t, s, run.ID)
		if attempt < cloudAgentToolAttemptLimit && run.Status != "running" {
			t.Fatalf("repairable mismatch terminated run: %s %s", run.Status, run.FailureMessage)
		}
		if attempt == cloudAgentToolAttemptLimit && run.Status != "failed" {
			t.Fatal("repeated mismatch exceeded repair limit")
		}
		if state.Approval != nil || state.MediaTaskID != "" {
			t.Fatal("mismatched spec reached approval or submission")
		}
	}
	var tasks, orders int64
	if err := db.Model(&model.Task{}).Where("type IN ?", []string{"canvas_image", "canvas_video"}).Count(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.BillingOrder{}).Where("capability IN ?", []string{"image", "video"}).Count(&orders).Error; err != nil {
		t.Fatal(err)
	}
	if tasks != 0 || orders != 0 {
		t.Fatalf("failed admission created paid work: tasks=%d orders=%d", tasks, orders)
	}
}

func TestCloudAgentMediaSpecRepairStillRequiresApproval(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	run, state := agentMediaRun(t, s, a, "request_approval")
	mismatch := validateCloudAgentResolvedMediaOptions(map[string]any{"videoSeconds": "8"}, map[string]any{"mode": "video", "config": map[string]any{"videoSeconds": "5"}})
	if err := s.cloudAgentMediaError(run, &state, "admission", false, false, mismatch); err != nil {
		t.Fatal(err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if state.ActiveTaskID == "" {
		t.Fatal("mismatch did not schedule a model correction")
	}
	a.Duration = 5
	corrected := agentMediaCall(a)
	corrected.ID = "corrected-media"
	body, err := json.Marshal(map[string]any{"toolCalls": []cloudAgentCall{corrected}})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", state.ActiveTaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(body)}).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
			t.Fatal(err)
		}
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if run.Status != "waiting_approval" || state.Approval == nil || state.MediaTaskID != "" {
		t.Fatalf("corrected spec bypassed or failed approval: %s %s", run.Status, run.FailureMessage)
	}
	var tasks int64
	if err := db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatalf("correction submitted media before approval: tasks=%d err=%v", tasks, err)
	}
	approvalID := state.Approval.ID
	approveAgentMediaDraft(t, s, run.ID)
	if err := s.DecideCloudAgentApproval("user", run.ID, approvalID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks).Error; err != nil || tasks != 1 {
		t.Fatalf("corrected approval must submit once: tasks=%d err=%v", tasks, err)
	}
}
