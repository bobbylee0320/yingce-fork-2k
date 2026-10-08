package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestMinimaxH3OfficialRuntimeDownloadsHDResult(t *testing.T) {
	allowLoopbackProviderTest(t)
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	adapter, ok := center.registrySnapshot().Resolve("minimaxh3-video")
	if !ok {
		t.Fatal("official protocol was not loaded")
	}
	createCalls, pollCalls, downloadCalls := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing bearer authentication")
		}
		switch r.URL.Path {
		case "/v1/videos/generations":
			createCalls++
			if r.Method != http.MethodPost {
				t.Error("incorrect create method")
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			materials, _ := body["materials"].([]any)
			if body["function_mode"] != "omni_reference" || len(materials) != 3 {
				t.Errorf("body=%#v", body)
			}
			for index, name := range []string{"角色A", "场景", "配乐"} {
				if index < len(materials) && materials[index].(map[string]any)["name"] != name {
					t.Errorf("materials=%v", materials)
				}
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"task_id":"cgt-hd","status":"pending"}`))
		case "/v1/tasks/cgt-hd":
			pollCalls++
			w.Header().Set("Content-Type", "application/json")
			if pollCalls == 1 {
				_, _ = w.Write([]byte(`{"task_id":"cgt-hd","status":"finalizing","result_urls":["https://cdn.example/preview.mp4"]}`))
			} else {
				_, _ = w.Write([]byte(`{"task_id":"cgt-hd","status":"success","result_urls":["https://cdn.example/preview.mp4"],"source_urls":["https://cdn.example/hd.mp4"]}`))
			}
		case "/v1/tasks/cgt-hd/download":
			downloadCalls++
			if pollCalls != 2 || r.URL.Query().Get("index") != "0" {
				t.Error("download before success or invalid index")
			}
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("hd-original"))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	input := canvasGenerationInput{
		Mode: "video", Prompt: "@角色A 在 @场景 里行走，背景音乐用 @配乐",
		Config:          providerConfig{BaseURL: server.URL, APIKey: "test-key", Model: "minimaxH3", InterfaceType: "minimaxh3-video", VideoSeconds: "8", VQuality: "720p", Size: "16:9"},
		ReferenceImages: []providerMedia{{URL: "https://cdn.example/actor.jpg", Name: "角色A"}},
		ReferenceVideos: []providerMedia{{URL: "https://cdn.example/street.mp4", Name: "场景"}},
		ReferenceAudios: []providerMedia{{URL: "https://cdn.example/music.mp3", Name: "配乐"}},
	}
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, adapter, fastVideoPollPolicy())
	if err != nil {
		t.Fatal(err)
	}
	video, _ := result["video"].(map[string]interface{})
	if result["mode"] != "video" || video["dataUrl"] != "data:video/mp4;base64,aGQtb3JpZ2luYWw=" || createCalls != 1 || pollCalls != 2 || downloadCalls != 1 {
		t.Fatalf("result=%#v calls=%d/%d/%d", result, createCalls, pollCalls, downloadCalls)
	}
	catalog := (&Service{pluginRuntime: center}).PluginProviderCatalog(string(protocol.SurfaceAdminSystemChannel), "video", false)
	found := false
	for _, item := range catalog {
		if item.ID == "minimaxh3-video" {
			found = item.Enabled && item.BaseURL == "https://dnyovzpgyokm.sealosbja.site"
		}
	}
	if !found {
		t.Fatal("protocol is missing from selectable catalog")
	}
}

func TestMinimaxH3RuntimePreservesTaskFailure(t *testing.T) {
	allowLoopbackProviderTest(t)
	adapter, ok := loadOfficialFallbackRegistry().Resolve("minimaxh3-video")
	if !ok {
		t.Fatal("protocol unavailable")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/videos/generations" {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"task_id":"failed-task","status":"pending"}`))
		} else if r.URL.Path == "/v1/tasks/failed-task" {
			_, _ = w.Write([]byte(`{"status":"failed","fail_reason":"参考图含未认证人脸"}`))
		} else {
			t.Errorf("unexpected download %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	_, err := runProtocolAdapterTaskWithPolicy(context.Background(), canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, APIKey: "test-key", Model: "minimaxH3", InterfaceType: "minimaxh3-video"}}, adapter, fastVideoPollPolicy())
	if err == nil || !strings.Contains(err.Error(), "参考图含未认证人脸") {
		t.Fatalf("err=%v", err)
	}
}
