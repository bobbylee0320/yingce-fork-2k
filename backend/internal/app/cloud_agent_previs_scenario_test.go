package app

import (
	"math"
	"testing"
)

func strPtr(value string) *string { return &value }
func boolPtr(value bool) *bool    { return &value }

// 端到端剧本：只用 Agent 的 patch 操作，从空场景搭出客厅并排一段 5 秒戏：
// 女1 牵着儿童走到男1 身边，扇男1 一巴掌，男1 被打偏头；女2 坐在沙发旁看。
func TestCloudAgentPrevisLivingRoomSlapScenario(t *testing.T) {
	scene, err := cloudAgentPrevisSceneCreateTemplate(cloudAgentPrevisSceneCreateArgs{SceneID: "room", Title: "客厅冲突", TemplateID: "empty"})
	if err != nil {
		t.Fatal(err)
	}
	box := func(id, name string, position, scale []float64, color string) cloudAgentPrevisPatchOperation {
		p, s := position, scale
		return cloudAgentPrevisPatchOperation{Type: "object_add", ID: id, Name: strPtr(name), Kind: "primitive", Primitive: "box", Position: &p, Scale: &s, Color: strPtr(color)}
	}
	actor := func(id, name, archetype string, position []float64, yaw float64, color string) cloudAgentPrevisPatchOperation {
		p, r := position, []float64{0, yaw, 0}
		return cloudAgentPrevisPatchOperation{Type: "object_add", ID: id, Name: strPtr(name), Kind: "actor", Archetype: archetype, Position: &p, Rotation: &r, Color: strPtr(color)}
	}
	ops := []cloudAgentPrevisPatchOperation{
		// 房子：地板 + 三面墙（box 比 plane 稳定，有厚度、不会背面消失）
		box("floor", "地板", []float64{0, 0.025, 0}, []float64{8, 0.05, 7}, "#b9a68f"),
		box("wall-back", "后墙", []float64{0, 1.4, -3.5}, []float64{8, 2.8, 0.12}, "#e3ddd2"),
		box("wall-left", "左墙", []float64{-4, 1.4, 0}, []float64{0.12, 2.8, 7}, "#e3ddd2"),
		box("wall-right", "右墙", []float64{4, 1.4, 0}, []float64{0.12, 2.8, 7}, "#e3ddd2"),
		box("sofa", "沙发", []float64{-1.6, 0.42, -2.6}, []float64{2.2, 0.85, 0.9}, "#6b7f9e"),
		box("tv-stand", "电视柜", []float64{1.8, 0.25, -3.2}, []float64{1.8, 0.5, 0.45}, "#5a4a3c"),
		box("tv", "电视", []float64{1.8, 0.95, -3.3}, []float64{1.4, 0.8, 0.08}, "#1d1f22"),
		box("table", "餐桌", []float64{2.4, 0.38, 1.6}, []float64{1.6, 0.76, 0.9}, "#8a6a4f"),
		box("stool-1", "凳子 1", []float64{1.8, 0.23, 2.4}, []float64{0.4, 0.45, 0.4}, "#8a6a4f"),
		box("stool-2", "凳子 2", []float64{3.0, 0.23, 2.4}, []float64{0.4, 0.45, 0.4}, "#8a6a4f"),
		actor("woman-1", "女1", "woman", []float64{-3, 0, 1.2}, math.Pi/2, "#d84949"),
		actor("child-1", "儿童1", "child", []float64{-3, 0, 1.75}, math.Pi/2, "#dfae3f"),
		actor("man-1", "男1", "man", []float64{1.2, 0, 0.6}, -math.Pi/2, "#2f7de1"),
		actor("woman-2", "女2", "woman", []float64{-0.4, 0, -2.0}, 0.3, "#8b5cf6"),
		// 走位：女1 和儿童同速并排走到男1 面前（停在 0.6m 处）
		{Type: "object_motion_path_set", ID: "woman-1", PathPoints: [][]float64{{-3, 0, 1.2}, {-1, 0, 0.9}, {0.6, 0, 0.6}}, PathSpeed: "walk", StartDelay: float64Ptr(0), OrientToPath: boolPtr(true)},
		{Type: "object_motion_path_set", ID: "child-1", PathPoints: [][]float64{{-3, 0, 1.75}, {-1, 0, 1.45}, {0.4, 0, 1.15}}, PathSpeed: "walk", StartDelay: float64Ptr(0), OrientToPath: boolPtr(true)},
		// 动作：牵手（上半身，可叠加走路）→ 扇巴掌 → 被打
		{Type: "actor_motion_add", ID: "woman-1", Motion: "hold_hand", Time: float64Ptr(0), Duration: float64Ptr(2.8), KeyframeID: strPtr("w1-hold")},
		{Type: "actor_motion_add", ID: "child-1", Motion: "hold_hand", Time: float64Ptr(0), Duration: float64Ptr(2.8), KeyframeID: strPtr("c1-hold")},
		{Type: "actor_motion_add", ID: "woman-1", Motion: "slap", Time: float64Ptr(3.0), Duration: float64Ptr(1.4), KeyframeID: strPtr("w1-slap")},
		{Type: "actor_motion_add", ID: "man-1", Motion: "hit_react", Time: float64Ptr(3.35), Duration: float64Ptr(1.4), KeyframeID: strPtr("m1-hit")},
		{Type: "actor_motion_add", ID: "woman-2", Motion: "look_around", Time: float64Ptr(0), Duration: float64Ptr(3), KeyframeID: strPtr("w2-look")},
		{Type: "actor_motion_add", ID: "child-1", Motion: "cry", Time: float64Ptr(3.6), Duration: float64Ptr(1.4), KeyframeID: strPtr("c1-cry")},
	}
	for index, op := range ops {
		if _, err := cloudAgentPrevisApplyPatchOperation(scene, op, index); err != nil {
			t.Fatalf("op %d (%s %s) failed: %v", index, op.Type, op.ID, err)
		}
	}
	cloudAgentPrevisGroundScene(scene)
	if err := cloudAgentPrevisValidateScene(scene); err != nil {
		t.Fatalf("scene invalid: %v", err)
	}
	objects := creationMaps(scene["objects"])
	if len(objects) != 14 {
		t.Fatalf("expected 14 objects, got %d", len(objects))
	}
	// 女1 走完必须在镜头 5 秒内，且最终停在男1 面前、面朝 +X（男1 方向）
	woman := cloudAgentPrevisFindByID(objects, "woman-1")
	keys := creationMaps(woman["keyframes"])
	last := keys[len(keys)-1]
	if at := numberValue(last["time"], -1); at <= 0 || at > 3.0 {
		t.Fatalf("woman-1 must arrive before the slap at 3s, arrived at %v", at)
	}
	position, _ := cloudAgentPrevisNumberVec3(cloudAgentPrevisMapTransform(last)["position"])
	if math.Hypot(position[0]-1.2, position[2]-0.6) > 0.7 || position[1] != 0 {
		t.Fatalf("woman-1 must end next to man-1 on the ground, got %v", position)
	}
	// 所有道具底面不得低于地面
	for _, object := range objects {
		pos, _ := cloudAgentPrevisNumberVec3(cloudAgentPrevisMapTransform(object)["position"])
		if pos[1] < 0 {
			t.Fatalf("%s is underground: %v", stringValue(object["name"]), pos)
		}
	}
	if motions := creationMaps(woman["motions"]); len(motions) != 2 {
		t.Fatalf("woman-1 should have hold_hand + slap, got %d", len(motions))
	}
}
