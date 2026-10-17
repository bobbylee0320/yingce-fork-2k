package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestCloudAgentMinimalMediaIntentMaterializesStableDraftBeforeApproval(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	run, state := agentMediaRun(t, s, a, "auto")
	state.event(run.ID, "tool_completed", map[string]any{
		"toolName": "model_list", "arguments": `{"mode":"video","referenceNodeIds":[]}`,
		"result": map[string]any{"models": []map[string]any{{"capability": "video", "selection": map[string]any{"channelId": "channel", "channelModelKey": "seedance-test"}}}},
	})
	call := cloudAgentCall{ID: "minimal-media"}
	call.Function.Name, call.Function.Arguments = "generate_media", `{"mode":"video","prompt":"猫在花园散步","referenceNodeIds":[]}`
	_, first, err := s.prepareCloudAgentMedia(run, &state, call)
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := s.prepareCloudAgentMedia(run, &state, call)
	if err != nil || first.Args.NodeID != second.Args.NodeID || first.Args.NodeID == "" || first.Args.Title != "视频创作" || first.Args.ChannelModelKey != "seedance-test" {
		t.Fatalf("minimal intent was not deterministically materialized: first=%+v second=%+v err=%v", first, second, err)
	}
	state.Calls = []cloudAgentCall{call}
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if run.Status != "waiting_approval" || state.Approval == nil {
		t.Fatalf("minimal intent did not reach standard approval: status=%s failure=%s", run.Status, run.FailureMessage)
	}
	var admitted cloudAgentMediaArgs
	if err := json.Unmarshal([]byte(state.Approval.Call.Function.Arguments), &admitted); err != nil {
		t.Fatal(err)
	}
	if admitted.NodeID != first.Args.NodeID || admitted.Duration <= 0 || admitted.Size == "" {
		t.Fatalf("approval lacks the actual resolved configuration: %+v", admitted)
	}
	var tasks int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks)
	if tasks != 0 {
		t.Fatal("materialization submitted before approval")
	}
	approvalID := state.Approval.ID
	approveAgentMediaDraft(t, s, run.ID)
	if err := s.DecideCloudAgentApproval("user", run.ID, approvalID, "approve", ""); err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks)
	if tasks != 1 {
		t.Fatalf("approval replay submitted %d tasks", tasks)
	}
}

func TestCloudAgentUniqueModelMaterializationDoesNotGuess(t *testing.T) {
	modelItem := map[string]any{"capability": "image", "selection": map[string]any{"logicalModelId": "image-model"}}
	for _, test := range []struct {
		name         string
		models       []map[string]any
		latestQuery  string
		latestFailed bool
		transient    bool
		want         bool
	}{
		{"unique", []map[string]any{modelItem}, `{"mode":"image","referenceNodeIds":[]}`, false, false, true},
		{"ambiguous", []map[string]any{modelItem, modelItem}, `{"mode":"image","referenceNodeIds":[]}`, false, false, false},
		{"empty", nil, `{"mode":"image","referenceNodeIds":[]}`, false, false, false},
		{"different references", []map[string]any{modelItem}, `{"mode":"image","referenceNodeIds":["other"]}`, false, false, false},
		{"different mode", []map[string]any{modelItem}, `{"mode":"video","referenceNodeIds":[]}`, false, false, false},
		{"latest query failed", []map[string]any{modelItem}, `{"mode":"image","referenceNodeIds":[]}`, true, false, false},
		{"transient references not queried", []map[string]any{modelItem}, `{"mode":"image","referenceNodeIds":[]}`, false, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := cloudAgentRuntime{}
			// A newer incompatible/empty query must not fall back to this old result.
			state.event("run", "tool_completed", map[string]any{"toolName": "model_list", "arguments": `{"mode":"image","referenceNodeIds":[]}`, "result": map[string]any{"models": []map[string]any{modelItem}}})
			state.event("run", "tool_completed", map[string]any{"toolName": "model_list", "arguments": test.latestQuery, "result": map[string]any{"models": test.models}})
			if test.latestFailed {
				state.event("run", "tool_failed", map[string]any{"toolName": "model_list"})
			}
			a := cloudAgentMediaArgs{Mode: "image"}
			if test.transient {
				a.ReferenceTransientIDs = []string{"temporary"}
			}
			if got := cloudAgentApplyUniqueModelListSelection(&state, `{}`, &a); got != test.want {
				t.Fatalf("materialization=%v want=%v args=%+v", got, test.want, a)
			}
		})
	}
}

func TestCloudAgentDraftAcceptsScopedUserSpecificationChange(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	doc["nodes"] = append(creationMaps(doc["nodes"]), map[string]any{"id": a.NodeID, "type": "video", "title": "保留这个名字", "metadata": map[string]any{
		"status": "idle", "size": "16:9", "seconds": "6", "generateAudio": "false", "channelId": "channel", "channelModelKey": "seedance-test",
	}})
	raw, _ := json.Marshal(doc)
	if err := db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	a.SnapshotHash, a.Size = cloudAgentMediaContentHash(doc), "9:16"
	a.ConfigurationChange = &cloudAgentMediaConfigurationChange{Fields: []string{"size"}, UserInstruction: "改成9:16"}
	run, state := agentMediaRun(t, s, a, "auto")
	state.Canonical.Messages = []map[string]any{{"role": "user", "content": "这个草稿改成9:16，其他不变"}}
	// Omitted model and title inherit the draft rather than forcing another read or model turn.
	var fields map[string]any
	call := agentMediaCall(a)
	json.Unmarshal([]byte(call.Function.Arguments), &fields)
	for _, key := range []string{"logicalModelId", "channelId", "channelModelKey", "title"} {
		delete(fields, key)
	}
	raw, _ = json.Marshal(fields)
	call.Function.Arguments = string(raw)
	_, plan, err := s.prepareCloudAgentMedia(run, &state, call)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Args.Size != "9:16" || plan.Args.Duration != 6 || *plan.Args.VideoGenerateAudio || plan.Args.ChannelModelKey != "seedance-test" || plan.Args.Title != "保留这个名字" {
		t.Fatalf("scoped change altered other settings: %+v", plan.Args)
	}
	preview, _ := json.Marshal(cloudAgentMediaApprovalPreview(plan, "test model"))
	if !strings.Contains(string(preview), "改成9:16") {
		t.Fatal("existing approval lost the specification change source")
	}
	state.Calls = []cloudAgentCall{call}
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if state.Approval == nil {
		t.Fatalf("scoped change did not reach approval: %s", run.FailureMessage)
	}
	seconds := 8
	audio := false
	settings := CloudAgentMediaSettings{ChannelID: "channel", ChannelModelKey: "seedance-test", Size: "16:9", DurationSeconds: &seconds, VideoGenerateAudio: &audio}
	if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", "", &settings); err != nil {
		t.Fatal(err)
	}
	_, state = agentInterjectionState(t, s, run.ID)
	var edited cloudAgentMediaArgs
	if err := json.Unmarshal([]byte(state.Approval.Call.Function.Arguments), &edited); err != nil {
		t.Fatal(err)
	}
	if edited.ConfigurationChange != nil || edited.Size != "16:9" || edited.Duration != 8 {
		t.Fatalf("direct user edits retained stale Agent provenance or settings: %+v", edited)
	}
}

func TestCloudAgentApprovalDefaultDurationCannotBypassBudget(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	a.Duration = 1
	run, state := agentMediaRun(t, s, a, "auto")
	state.Request.Budget.MaxVideoSeconds = 1
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, state = agentInterjectionState(t, s, run.ID)
	if state.Approval == nil {
		t.Fatalf("one-second video did not reach approval: %s", run.FailureMessage)
	}
	useDefault := 0
	settings := CloudAgentMediaSettings{ChannelID: a.ChannelID, ChannelModelKey: a.ChannelModelKey, Size: a.Size, DurationSeconds: &useDefault, VideoGenerateAudio: a.VideoGenerateAudio}
	if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", "", &settings); err == nil {
		t.Fatal("model default duration bypassed the user's one-second budget")
	}
	var tasks int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&tasks)
	if tasks != 0 {
		t.Fatal("over-budget approval submitted a paid task")
	}
}

func TestCloudAgentSpecificationChangeRejectsUntrustedOrIncompleteEvidence(t *testing.T) {
	for _, test := range []struct {
		name   string
		change cloudAgentMediaConfigurationChange
	}{
		{"invented quote", cloudAgentMediaConfigurationChange{Fields: []string{"size"}, UserInstruction: "改成9:16"}},
		{"empty quote", cloudAgentMediaConfigurationChange{Fields: []string{"size"}}},
		{"unknown field", cloudAgentMediaConfigurationChange{Fields: []string{"permissionMode"}, UserInstruction: "生成角色图"}},
		{"duplicate field", cloudAgentMediaConfigurationChange{Fields: []string{"size", "size"}, UserInstruction: "生成角色图"}},
		{"missing value", cloudAgentMediaConfigurationChange{Fields: []string{"quality"}, UserInstruction: "生成角色图"}},
		{"wrong mode", cloudAgentMediaConfigurationChange{Fields: []string{"durationSeconds"}, UserInstruction: "生成角色图"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := cloudAgentRuntime{Canonical: canonicalAgentRequest{Messages: []map[string]any{
				{"role": "user", "content": "改成9:16"}, // older request
				{"role": "user", "content": "生成角色图"},
				{"role": "assistant", "content": "改成9:16"},
				cloudAgentRuntimeMessage(cloudAgentRuntimeContext{Kind: cloudAgentContextPendingPlan, LatestUserMessage: "改成9:16"}),
			}}}
			a := cloudAgentMediaArgs{Mode: "image", Size: "9:16", Duration: 8, ConfigurationChange: &test.change}
			var fieldErr *cloudAgentFieldArgumentError
			if err := validateCloudAgentMediaConfigurationChange(&a, &state); !errors.As(err, &fieldErr) {
				t.Fatalf("invalid change lost internal repair feedback: %v", err)
			}
		})
	}
}

func TestCloudAgentExplicitUnsupportedQualityIsNeverDropped(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "nano-banana-pro")
	profile.Image.Quality = ImageQualityConfig{Supported: false, Default: "auto"}
	for _, row := range []any{
		&model.ChannelModel{ID: "no-quality-model", ChannelID: "channel", ModelKey: "nano-banana-pro", Capability: "image", Protocol: model.ChannelInterfaceGeminiImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "no-quality-tier", ChannelModelID: "no-quality-model", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 1, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	a.Mode, a.ChannelModelKey, a.Duration, a.VideoGenerateAudio = "image", "nano-banana-pro", 0, nil
	a.ConfigurationChange = &cloudAgentMediaConfigurationChange{Fields: []string{"quality"}, UserInstruction: "质量要high"}
	a.Quality = "high"
	run, state := agentMediaRun(t, s, a, "auto")
	state.Canonical.Messages = []map[string]any{{"role": "user", "content": "生成角色图，质量要high"}}
	req, plan, err := s.prepareCloudAgentMedia(run, &state, agentMediaCall(a))
	if err != nil || plan.Args.Quality != "high" {
		t.Fatalf("explicit user quality was silently removed: plan=%+v err=%v", plan, err)
	}
	req.creationPrepare = &creationTaskPreparation{}
	task, err := s.CreateTask("user", req)
	if err == nil && applyCloudAgentResolvedMediaDefaults(&req, plan, task) == nil {
		t.Fatal("unsupported user specification bypassed pre-approval admission")
	}
}
