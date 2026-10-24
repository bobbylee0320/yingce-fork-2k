package app

import (
	"encoding/json"
	"errors"
	"testing"

	"gorm.io/gorm"

	"yingce/backend/internal/model"
)

func TestCloudAgentCanvasHashIgnoresNodeTimestamps(t *testing.T) {
	plain := map[string]any{"nodes": []any{layoutNode("text-1", "text", 0, 0)}, "connections": []any{}}
	if got, want := cloudAgentCanvasHash(plain), creationHash(plain); got != want {
		t.Fatalf("没有节点时间戳的画布哈希应保持不变：%s != %s", got, want)
	}

	stamped := layoutNode("text-1", "text", 0, 0)
	stamped["createdAt"] = "2026-10-21T08:00:00.000Z"
	stamped["updatedAt"] = "2026-10-21T08:00:01.000Z"
	withTimestamps := map[string]any{"nodes": []any{stamped}, "connections": []any{}}
	if cloudAgentCanvasHash(withTimestamps) != cloudAgentCanvasHash(plain) {
		t.Fatal("只补写节点 createdAt/updatedAt 不应改变画布哈希")
	}
	if _, ok := stamped["updatedAt"]; !ok {
		t.Fatal("计算哈希不应修改原文档")
	}

	edited := layoutNode("text-1", "text", 0, 0, map[string]any{"content": "用户改过"})
	edited["updatedAt"] = "2026-10-21T08:00:01.000Z"
	if cloudAgentCanvasHash(map[string]any{"nodes": []any{edited}, "connections": []any{}}) == cloudAgentCanvasHash(plain) {
		t.Fatal("时间戳以外的内容变化仍必须改变画布哈希")
	}
}

func timestampCanvasFixture(t *testing.T) (*Service, func(func(node map[string]any))) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	nodes := []any{layoutNode("text-1", "text", 0, 0), layoutNode("text-2", "text", 5, 5)}
	encode := func() string {
		raw, err := json.Marshal(map[string]any{"nodes": nodes, "connections": []any{}})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	if err := db.Create(&model.CanvasProject{ID: "layout-canvas", UserID: "user", PayloadJSON: encode()}).Error; err != nil {
		t.Fatal(err)
	}
	// 模拟浏览器自动保存：写入新内容并推进 revision。
	return s, func(change func(node map[string]any)) {
		for _, node := range nodes {
			change(node.(map[string]any))
		}
		if err := db.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ?", "layout-canvas", "user").
			Updates(map[string]any{"payload_json": encode(), "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func currentCanvasHash(t *testing.T, s *Service) string {
	t.Helper()
	canvas, err := s.repo.CanvasProjectForUser("user", "layout-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	return cloudAgentCanvasHash(doc)
}

// 前端合并 Agent 写入后会给节点补写 createdAt/updatedAt 并自动保存（点「同意」前还会强制保存一次），
// 模型手上的快照不应因此被判为过期。
func TestCloudAgentArrangeNodesAcceptsSnapshotAfterTimestampAutosave(t *testing.T) {
	s, mutate := timestampCanvasFixture(t)
	snapshot := currentCanvasHash(t, s)
	mutate(func(node map[string]any) {
		node["createdAt"] = "2026-10-21T08:00:00.000Z"
		node["updatedAt"] = "2026-10-21T08:00:01.000Z"
	})
	if _, err := applyCloudAgentArrangeNodes(s.repo, "user", "layout-canvas", arrangeCall(t, map[string]any{
		"snapshotHash": snapshot,
		"mode":         "row",
	}), mustRuntimePolicy(t, s)); err != nil {
		t.Fatalf("只有节点时间戳变化时整理应成功：%v", err)
	}
}

func TestCloudAgentArrangeNodesStillRejectsContentChange(t *testing.T) {
	s, mutate := timestampCanvasFixture(t)
	snapshot := currentCanvasHash(t, s)
	mutate(func(node map[string]any) {
		node["title"] = "用户改了标题"
		node["updatedAt"] = "2026-10-21T08:00:01.000Z"
	})
	var staleErr *cloudAgentFieldArgumentError
	if _, err := applyCloudAgentArrangeNodes(s.repo, "user", "layout-canvas", arrangeCall(t, map[string]any{
		"snapshotHash": snapshot,
		"mode":         "row",
	}), mustRuntimePolicy(t, s)); !errors.As(err, &staleErr) || staleErr.Issue != "stale_snapshot" {
		t.Fatalf("节点内容变化仍应按过期快照拒绝：%v", err)
	}
}
