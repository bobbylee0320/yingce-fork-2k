package workbench

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestEnsureBuiltinCatalogPublishesImageAndVideoPresets(t *testing.T) {
	svc, db, _ := newWorkbenchTest(t)
	if err := svc.EnsureBuiltinCatalog(); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{KindImage, KindVideo} {
		tools, err := svc.PublicTools(kind)
		if err != nil {
			t.Fatal(err)
		}
		if len(tools) == 0 {
			t.Fatalf("no builtin %s tools", kind)
		}
		for _, tool := range tools {
			if len(tool.Presets) != 3 {
				t.Fatalf("tool %s has %d public presets, want 3", tool.ID, len(tool.Presets))
			}
			for _, preset := range tool.Presets {
				if preset.ToolID != tool.ID || preset.PromptTemplate == "" || !preset.Enabled {
					t.Fatalf("unusable public preset: %#v", preset)
				}
			}
		}
	}
	var count int64
	if err := db.Model(&model.WorkbenchTool{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count < 2 {
		t.Fatalf("tool count=%d", count)
	}
}

func TestEnsureBuiltinCatalogIsRepeatableAndPreservesAdminState(t *testing.T) {
	svc, db, _ := newWorkbenchTest(t)
	seedTools, seedPresets, err := builtinCatalog()
	if err != nil {
		t.Fatal(err)
	}
	editedTool := seedTools[0]
	editedTool.Name = "管理员自定义名称"
	editedTool.Enabled = false
	editedTool.Version = 9
	editedPreset := seedPresets[0]
	editedPreset.Name = "管理员自定义预设"
	editedPreset.PromptTemplate = "管理员自己的提示词"
	editedPreset.Enabled = false
	editedPreset.Version = 6
	if err := db.Create(&editedTool).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&editedPreset).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.EnsureBuiltinCatalog(); err != nil {
		t.Fatal(err)
	}
	var firstTools, firstPresets int64
	if err := db.Model(&model.WorkbenchTool{}).Count(&firstTools).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkbenchPreset{}).Count(&firstPresets).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.EnsureBuiltinCatalog(); err != nil {
		t.Fatal(err)
	}
	var secondTools, secondPresets int64
	if err := db.Model(&model.WorkbenchTool{}).Count(&secondTools).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkbenchPreset{}).Count(&secondPresets).Error; err != nil {
		t.Fatal(err)
	}
	if firstTools != secondTools || firstPresets != secondPresets {
		t.Fatalf("repeat seed changed counts: tools %d/%d presets %d/%d", firstTools, secondTools, firstPresets, secondPresets)
	}
	var gotTool model.WorkbenchTool
	if err := db.First(&gotTool, "id = ?", editedTool.ID).Error; err != nil {
		t.Fatal(err)
	}
	if gotTool.Name != editedTool.Name || gotTool.Enabled != editedTool.Enabled || gotTool.Version != editedTool.Version {
		t.Fatalf("admin tool changed: %#v", gotTool)
	}
	var gotPreset model.WorkbenchPreset
	if err := db.First(&gotPreset, "id = ?", editedPreset.ID).Error; err != nil {
		t.Fatal(err)
	}
	if gotPreset.Name != editedPreset.Name || gotPreset.PromptTemplate != editedPreset.PromptTemplate || gotPreset.Enabled != editedPreset.Enabled || gotPreset.Version != editedPreset.Version {
		t.Fatalf("admin preset changed: %#v", gotPreset)
	}
}
