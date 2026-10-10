package app

import (
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

// storyboardHandleGuidanceDocument 提供独立分镜夹具，区分素材输入、镜头输出和整表引用。
func storyboardHandleGuidanceDocument(t *testing.T) map[string]any {
	t.Helper()
	doc, err := creationDocument(`{"nodes":[{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"r1","assetBindings":[{"nodeId":"asset","role":"environment"}],"imageNodeId":"output"},{"id":"r2"}]}}},{"id":"asset","type":"image","metadata":{"assetCategory":"environment"}},{"id":"output","type":"image","metadata":{}}],"connections":[{"id":"input","fromNodeId":"asset","toNodeId":"script","toHandleId":"row:r1"},{"id":"output-edge","fromNodeId":"script","toNodeId":"output","fromHandleId":"row:r1"},{"id":"context","fromNodeId":"asset","toNodeId":"script","toHandleId":"storyboard:context"},{"id":"unrelated","fromNodeId":"asset","toNodeId":"script","toHandleId":"row:r2"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestAgentStoryboardHandleErrorsIdentifyTheWrongField(t *testing.T) {
	for _, tc := range []struct{ name, from, to, fromHandle, toHandle, field, issue, guidance string }{
		{"asset source handle", "asset", "script", "row:r1", "", "fromHandleId", "invalid_node_handle", "省略 fromHandleId"},
		{"output target handle", "script", "output", "", "row:r1", "toHandleId", "invalid_node_handle", "分镜来源的 fromHandleId"},
		{"shot number is not row id", "asset", "script", "", "row:9", "toHandleId", "not_found", "不要用镜头编号代替"},
		{"missing row prefix", "asset", "script", "", "r1", "toHandleId", "invalid_handle", "row:<真实rowId>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := storyboardHandleGuidanceDocument(t)
			ops := []agentCanvasOp{{Type: "connect_nodes", ID: "new-edge", FromNodeID: tc.from, ToNodeID: tc.to, FromHandleID: tc.fromHandle, ToHandleID: tc.toHandle}}
			_, err := applyCloudAgentCanvasPlan(doc, ops)
			var fieldErr *cloudAgentFieldArgumentError
			if !errors.As(err, &fieldErr) || fieldErr.Field != "ops[0]."+tc.field || fieldErr.Issue != tc.issue || !strings.Contains(err.Error(), tc.guidance) {
				t.Fatalf("wrong handle feedback: %v", err)
			}
			if len(creationMaps(doc["connections"])) != 4 {
				t.Fatal("rejected handle created or exchanged a connection")
			}
			// 校验模型实际收到的错误回执，不能附上与连线无关的新增节点模板。
			call := cloudAgentCall{ID: "bad-handle"}
			call.Function.Name = "canvas_apply_ops"
			state := cloudAgentRuntime{Request: CloudAgentRequest{PermissionMode: "auto", ContextScope: []string{"canvas"}}, Calls: []cloudAgentCall{call}}
			cloudAgentRecordToolResult(&model.CloudAgentExecution{ID: "run"}, &state, call, nil, err)
			result := state.Events[0].Payload["result"].(map[string]any)
			if result["field"] != "ops[0]."+tc.field || !strings.Contains(stringValue(result["guidance"]), "本次连线未执行") {
				t.Fatal("tool receipt lost actionable feedback")
			}
			example := result["exampleArguments"].(map[string]any)["ops"].([]any)[0].(map[string]any)
			if example["type"] != "connect_nodes" {
				t.Fatal("wrong correction template")
			}
			wantHandle := tc.field
			if tc.issue == "invalid_node_handle" {
				if wantHandle == "fromHandleId" {
					wantHandle = "toHandleId"
				} else {
					wantHandle = "fromHandleId"
				}
			}
			if example[wantHandle] == nil {
				t.Fatal("correction template uses the wrong endpoint")
			}
		})
	}
}

func TestAgentStoryboardRowBindingDoesNotConflictWithWholeNodeReference(t *testing.T) {
	doc := storyboardHandleGuidanceDocument(t)
	doc["connections"] = []any{map[string]any{"id": "generic", "fromNodeId": "asset", "toNodeId": "script"}}
	storyboard := cloudAgentNodeByID(creationMaps(doc["nodes"]), "script")["metadata"].(map[string]any)["storyboard"].(map[string]any)
	row := creationMaps(storyboard["rows"])[0]
	row["assetBindings"], row["imageNodeId"] = []any{}, ""
	ops := []agentCanvasOp{{Type: "connect_nodes", ID: "row-binding", FromNodeID: "asset", ToNodeID: "script", ToHandleID: "row:r1"}}
	if _, err := applyCloudAgentCanvasPlan(doc, ops); err != nil {
		t.Fatal(err)
	}
	bindings := creationMaps(row["assetBindings"])
	if len(bindings) != 1 || bindings[0]["nodeId"] != "asset" || row["imageNodeId"] != "" || len(creationMaps(doc["connections"])) != 2 {
		t.Fatal("row binding was confused with output or generic reference")
	}
	if _, err := applyCloudAgentCanvasPlan(doc, []agentCanvasOp{{Type: "connect_nodes", ID: "duplicate-row", FromNodeID: "asset", ToNodeID: "script", ToHandleID: "row:r1"}}); err == nil {
		t.Fatal("duplicate row binding accepted")
	}
}

func TestAgentToolDescriptionIncludesBothStoryboardDirections(t *testing.T) {
	tools, _ := platformToolSchema(t)
	for _, tool := range tools {
		fn := tool["function"].(map[string]any)
		if fn["name"] != "canvas_apply_ops" {
			continue
		}
		description := stringValue(fn["description"])
		for _, phrase := range []string{"镜头绑定示例", `"toHandleId":"row:<rowId>"`, "输出示例", `"fromHandleId":"row:<rowId>"`, "不是镜头编号"} {
			if !strings.Contains(description, phrase) {
				t.Fatalf("missing tool guidance %s", phrase)
			}
		}
		return
	}
	t.Fatal("canvas tool not exposed")
}
