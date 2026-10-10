package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestCloudAgentReadTextRuntimeReadsResourceOutsideCheckpoint(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	// A service read inside the checkpoint transaction would exhaust this pool.
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s.repo = s.repo.WithContext(ctx)

	content := "第一章\n林逸在石殿中醒来。"
	objectKey := "text-runtime/novel.txt"
	if err := os.MkdirAll(filepath.Join(s.dataDir, "resources", filepath.Dir(objectKey)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dataDir, "resources", objectKey), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	for _, resource := range []model.Resource{
		{ID: "owned-text", UserID: "user", Kind: "file", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: objectKey, MimeType: "text/plain", Size: int64(len(content))},
		{ID: "foreign-text", UserID: "other-user", Kind: "file", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: objectKey, MimeType: "text/plain", Size: int64(len(content))},
	} {
		if err := db.Create(&resource).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvas := model.CanvasProject{ID: "agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"note","type":"text","title":"Note","metadata":{"content":"/api/resources/owned-text/file"}},{"id":"foreign","type":"text","metadata":{"storageKey":"resource:foreign-text"}}],"connections":[]}`}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	root, err := s.CreateCloudAgentRun("user", agentTestRequest(), "")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		args, want string
		next       int
		more, fail bool
	}{
		{args: `{"nodeId":"note","maxChars":4}`, want: "第一章\n", next: 4, more: true},
		{args: `{"nodeId":"note","offset":4}`, want: "林逸在石殿中醒来。", next: len([]rune(content))},
		{args: `{"nodeId":"foreign"}`, fail: true},
	}
	calls := make([]cloudAgentCall, len(cases))
	for i, tc := range cases {
		calls[i].ID = fmt.Sprintf("read-text-%d", i)
		calls[i].Function.Name = "canvas_read_text"
		calls[i].Function.Arguments = tc.args
	}
	run, err := s.repo.CloudAgent("user", root.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	state.Calls, state.CallIndex = calls, 0
	state.Canonical.Messages = append(state.Canonical.Messages, map[string]any{"role": "assistant", "content": "", "tool_calls": calls})
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	for i, tc := range cases {
		result, err := s.executeCloudAgentRuntimeTool(ctx, "user", root.ID, calls[i])
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		payload, ok := result.(map[string]any)
		if !ok {
			t.Fatalf("unexpected bridge result: %#v", result)
		}
		var view map[string]any
		if err := json.Unmarshal([]byte(stringValue(payload["content"])), &view); err != nil {
			t.Fatal(err)
		}
		if tc.fail {
			if view["error"] == nil || view["content"] != nil {
				t.Fatalf("foreign resource was exposed: %#v", view)
			}
		} else if view["error"] != nil || view["content"] != tc.want || view["nextOffset"] != float64(tc.next) || view["hasMore"] != tc.more {
			t.Fatalf("call %d returned wrong text page: %#v", i, view)
		}
	}
	stored, err := s.repo.CanvasProjectForUser("user", canvas.ID)
	if err != nil || stored.PayloadJSON != canvas.PayloadJSON {
		t.Fatalf("text read changed canvas: %v", err)
	}
}
