package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

// 线上实际出现的模型合同：只有 16:9 / 9:16 / 1:1 三档像素值，没有 3:4。
func pixelOnlyImageSpec() CapabilitySpec {
	return CapabilitySpec{
		Capability: "image",
		Options:    map[string]OptionConstraint{"size": {Values: []any{"auto", "1824x1024", "1024x1824", "1024x1024"}}},
		ImageSize: &CapabilityImageSize{Parameter: "size", Presets: []CapabilityImageSizePreset{
			{Tier: "1k", Ratio: "16:9", Size: "1824x1024", Width: 1824, Height: 1024},
			{Tier: "1k", Ratio: "9:16", Size: "1024x1824", Width: 1024, Height: 1824},
			{Tier: "1k", Ratio: "1:1", Size: "1024x1024", Width: 1024, Height: 1024},
		}},
	}
}

func TestDramaImageSizeSnapsToDeclaredPreset(t *testing.T) {
	spec := pixelOnlyImageSpec()
	defaults := map[string]any{"size": "1824x1024"}
	cases := map[string]string{"9:16": "1024x1824", "16:9": "1824x1024", "1:1": "1024x1024", "4:3": "1024x1024"}
	for ratio, want := range cases {
		if got := dramaImageSizeFor(spec, defaults, ratio); got != want {
			t.Fatalf("%s => %q, want %q", ratio, got, want)
		}
	}
	// 3:4 与 9:16、1:1 等距，任选其一都必须是模型接受的值，绝不能原样发出比例。
	if got := dramaImageSizeFor(spec, defaults, "3:4"); got != "1024x1824" && got != "1024x1024" {
		t.Fatalf("3:4 must snap to an accepted pixel size, got %q", got)
	}
}

func TestDramaImageSizeKeepsRatioModelsAndOmitsUndeclared(t *testing.T) {
	ratioSpec := CapabilitySpec{Capability: "image", Options: map[string]OptionConstraint{"size": {Values: []any{"1:1", "3:4", "9:16"}}}}
	if got := dramaImageSizeFor(ratioSpec, nil, "3:4"); got != "3:4" {
		t.Fatalf("declared ratio must pass through, got %q", got)
	}
	if got := dramaImageSizeFor(ratioSpec, nil, "16:9"); got != "9:16" && got != "1:1" {
		t.Fatalf("missing ratio snaps to the nearest declared value, got %q", got)
	}
	if got := dramaImageSizeFor(CapabilitySpec{Capability: "image"}, nil, "9:16"); got != "" {
		t.Fatalf("models without a size option use their own default, got %q", got)
	}
}

func TestDramaAssetSchemesRenderWithoutPlaceholders(t *testing.T) {
	for _, scheme := range production.AssetSchemes() {
		assets := production.AssetSettings{Mode: scheme.Mode}.Normalized()
		if assets.CharacterRatio != scheme.Ratio || assets.CharacterPrompt == "" || assets.ScenePrompt == "" {
			t.Fatalf("scheme %s should fill defaults: %+v", scheme.Mode, assets)
		}
		for _, kind := range []string{"character", "scene"} {
			prompt := production.CastImagePrompt(assets, kind, "林逸", "黑发少年，青色道袍", "国风动画", "冷色调")
			if strings.Contains(prompt, "{{") || !strings.Contains(prompt, "林逸") || !strings.Contains(prompt, "国风动画") {
				t.Fatalf("%s/%s rendered badly: %s", scheme.Mode, kind, prompt)
			}
		}
	}
	custom := production.AssetSettings{Mode: production.AssetModeCustom, CharacterPrompt: "{{角色名称}} {{未知变量}}"}.Normalized()
	if problem := production.ValidateAssetPrompts(custom); !strings.Contains(problem, "{{未知变量}}") {
		t.Fatalf("unknown placeholder must be rejected: %q", problem)
	}
	if custom.CharacterRatio != production.AssetImageRatio {
		t.Fatalf("custom scheme keeps a valid ratio: %q", custom.CharacterRatio)
	}
}

func TestDramaJobDetailKeepsEveryAttempt(t *testing.T) {
	svc, fake := newDramaTestService(t)
	fake.fail = func(req CreateTaskRequest) bool { return req.Type == "canvas_video" }
	projectID := createTestDrama(t, svc, DramaReviewAuto).Project.ID
	runDramaTicks(t, svc, projectID, 14)
	jobs, err := svc.DramaJobs("usr-drama", projectID, 200)
	if err != nil {
		t.Fatal(err)
	}
	var failed, succeeded *DramaJobView
	for index := range jobs {
		if jobs[index].Kind == model.DramaJobSegmentVideo && jobs[index].Status == model.DramaJobFailed && failed == nil {
			failed = &jobs[index]
		}
		if jobs[index].Kind == model.DramaJobCastImage && jobs[index].Status == model.DramaJobSucceeded && succeeded == nil {
			succeeded = &jobs[index]
		}
	}
	if failed == nil || succeeded == nil {
		t.Fatalf("expected a failed video job and a finished frame job: %+v", jobs)
	}
	detail, err := svc.DramaJobDetail("usr-drama", projectID, failed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Attempts) == 0 || !strings.Contains(detail.Attempts[0].Error, "上游拒绝") || detail.Target == "" {
		t.Fatalf("failed job must list its rejected submissions: %+v", detail)
	}
	detail, err = svc.DramaJobDetail("usr-drama", projectID, succeeded.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Attempts) != 1 || detail.Attempts[0].Task == nil || len(detail.Attempts[0].Task.ResourceIDs) != 1 || detail.Attempts[0].Task.Prompt == "" {
		t.Fatalf("finished job must show its task, prompt and output: %+v", detail.Attempts)
	}
	if _, err := svc.DramaJobDetail("someone-else", projectID, succeeded.ID); err == nil {
		t.Fatal("job detail must be scoped to the project owner")
	}
}

func TestDramaListFiltersAndCountsByStatus(t *testing.T) {
	svc, _ := newDramaTestService(t)
	createTestDrama(t, svc, DramaReviewAuto)
	page, err := svc.ListDramas("usr-drama", DramaListRequest{Page: 1, PageSize: 24})
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]DramaListItem)
	counts := page["statusCounts"].(map[string]int64)
	if len(items) != 1 || page["total"].(int64) != 1 || counts["all"] != 1 {
		t.Fatalf("list must only count drama projects: %+v", page)
	}
	page, _ = svc.ListDramas("usr-drama", DramaListRequest{Page: 1, PageSize: 24, Query: "不存在的书名"})
	if len(page["items"].([]DramaListItem)) != 0 {
		t.Fatalf("search must filter by name: %+v", page)
	}
	page, _ = svc.ListDramas("usr-drama", DramaListRequest{Page: 1, PageSize: 24, Status: model.DramaStatusCompleted})
	if page["total"].(int64) != 0 {
		t.Fatalf("status filter must apply: %+v", page)
	}
	if _, err := svc.ListDramas("usr-drama", DramaListRequest{Page: 1, PageSize: 24, Status: "bogus"}); err == nil {
		t.Fatal("unknown status must be rejected")
	}
}
