package protocol

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func loadLaoliMediaAdapter(t *testing.T, providerID string) Adapter {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "laoli-media-api", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapters, err := LoadInstalledProviders(data, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, adapter := range adapters {
		if adapter.Metadata().ID == providerID {
			return adapter
		}
	}
	t.Fatalf("provider %q was not loaded", providerID)
	return nil
}

func TestLaoliOpenAIImageGenerationEditAndAsyncMapping(t *testing.T) {
	adapter := loadLaoliMediaAdapter(t, "laoli-image-openai")
	request := GenerationRequest{
		Capability: CapabilityImage,
		Model:      "gpt-image-2.5",
		Prompt:     "A lighthouse",
		ImageParameters: map[string]any{
			"size":            "2048x2048",
			"imageResolution": "2k",
			"count":           1,
		},
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if create.Path != "/v1/images/generations" || create.ContentType != "application/json" {
		t.Fatalf("generation request = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != request.Model || body["prompt"] != request.Prompt || body["n"] != float64(1) || body["size"] != "2048x2048" || body["resolution"] != "2K" || body["response_format"] != "url" {
		t.Fatalf("generation body = %#v", body)
	}

	editRequest := request
	editRequest.ImageParameters = nil
	editRequest.Resolution = "2K"
	editRequest.ImageCount = 1
	editRequest.Images = []MediaReference{
		{URL: "https://cdn.example/one.png", Name: "one.png", Role: "edit_source", Order: 0},
		{URL: "https://cdn.example/two.png", Name: "two.png", Role: "edit_source", Order: 1},
	}
	edit, err := adapter.BuildCreate(context.Background(), RequestContext{Request: editRequest})
	if err != nil {
		t.Fatal(err)
	}
	if edit.Path != "/v1/images/edits" || edit.ContentType != "multipart/form-data" || len(edit.Files) != 2 {
		t.Fatalf("edit request = %#v", edit)
	}
	for i, want := range []string{"https://cdn.example/one.png", "https://cdn.example/two.png"} {
		if edit.Files[i].Name != "image" || edit.Files[i].Reference.URL != want {
			t.Fatalf("edit file %d = %#v", i, edit.Files[i])
		}
	}
	maskedRequest := request
	maskedRequest.Images = append(append([]MediaReference{}, editRequest.Images...), MediaReference{URL: "https://cdn.example/mask.png", Name: "mask.png", Role: "mask", Order: 2})
	masked, err := adapter.BuildCreate(context.Background(), RequestContext{Request: maskedRequest})
	if err != nil {
		t.Fatal(err)
	}
	if len(masked.Files) != 3 || masked.Files[0].Name != "image" || masked.Files[1].Name != "image" || masked.Files[2].Name != "mask" || masked.Files[2].MIMEType != "image/png" {
		t.Fatalf("masked edit files = %#v", masked.Files)
	}
	_, err = adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Capability: CapabilityImage,
		Model:      "gpt-image-2.5",
		Prompt:     "Edit image",
		Images:     []MediaReference{{URL: "https://cdn.example/mask.png", Role: "mask"}},
	}})
	if err == nil {
		t.Fatal("mask without source image was accepted")
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"image-task-1","status":"queued"}`))
	if err != nil || created.TaskID != "image-task-1" || created.Status != StatusPending {
		t.Fatalf("async create = %#v, err=%v", created, err)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil || poll.Path != "/v1/images/tasks/image-task-1" {
		t.Fatalf("image poll = %#v, err=%v", poll, err)
	}
	completed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"image-task-1","status":"completed","data":[{"url":"https://signed.example/image.png"}]}`))
	if err != nil || completed.Status != StatusSucceeded || completed.Result == nil || len(completed.Result.Images) != 1 || completed.Result.Images[0].URL != "https://signed.example/image.png" {
		t.Fatalf("image completion = %#v, err=%v", completed, err)
	}

	inline, err := adapter.ParseCreate(context.Background(), []byte(`{"data":[{"b64_json":"aW1hZ2U=","mime_type":"image/webp"}]}`))
	if err != nil || inline.Result == nil || len(inline.Result.Images) != 1 || inline.Result.Images[0].DataURL != "data:image/webp;base64,aW1hZ2U=" {
		t.Fatalf("inline image result = %#v, err=%v", inline, err)
	}
}

func TestLaoliOpenAIAsyncImageParametersMapCountAndResolution(t *testing.T) {
	adapter := loadLaoliMediaAdapter(t, "laoli-image-openai-async")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Capability: CapabilityImage,
		Model:      "gpt-image-2.5-sr-flare",
		Prompt:     "A red lighthouse",
		ImageParameters: map[string]any{
			"size":            "2048x2048",
			"imageResolution": "4k",
			"count":           1,
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/v1/images/generations/async" {
		t.Fatalf("async path = %q", spec.Path)
	}
	body := manifestTestBody(t, spec)
	if body["model"] != "gpt-image-2.5-sr-flare" || body["prompt"] != "A red lighthouse" || body["n"] != float64(1) || body["size"] != "2048x2048" || body["resolution"] != "4K" {
		t.Fatalf("async image body = %#v", body)
	}
}

func TestLaoliGeminiImageMapping(t *testing.T) {
	adapter := loadLaoliMediaAdapter(t, "laoli-image-gemini")
	request := GenerationRequest{
		Capability: CapabilityImage,
		Model:      "nano-banana-2",
		Prompt:     "A blue heron",
		Images:     []MediaReference{{DataURL: "data:image/jpeg;base64,aW1hZ2U=", Kind: "image"}},
		ImageParameters: map[string]any{
			"size":            "16:9",
			"imageResolution": "2k",
		},
	}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/v1beta/models/nano-banana-2:generateContent" || spec.Auth.Type != "google-api-key" {
		t.Fatalf("Gemini request = %#v", spec)
	}
	body := manifestTestBody(t, spec)
	contents := body["contents"].([]any)
	parts := contents[0].(map[string]any)["parts"].([]any)
	inline := parts[1].(map[string]any)["inlineData"].(map[string]any)
	imageConfig := body["generationConfig"].(map[string]any)["imageConfig"].(map[string]any)
	if parts[0].(map[string]any)["text"] != request.Prompt || inline["mimeType"] != "image/jpeg" || inline["data"] != "aW1hZ2U=" || imageConfig["aspectRatio"] != "16:9" || imageConfig["imageSize"] != "2K" {
		t.Fatalf("Gemini request body = %#v", body)
	}
	result, err := adapter.ParseCreate(context.Background(), []byte(`{"candidates":[{"content":{"parts":[{"text":"A quiet sky"},{"inlineData":{"mimeType":"image/webp","data":"aW1hZ2U="}}]}}],"usageMetadata":{"candidatesTokenCount":4}}`))
	if err != nil || result.Status != StatusSucceeded || result.Result == nil || len(result.Result.Images) != 1 || result.Result.Images[0].DataURL != "data:image/webp;base64,aW1hZ2U=" {
		t.Fatalf("Gemini image result = %#v, err=%v", result, err)
	}
}

func TestLaoliVideoAsyncMappingAndIdempotency(t *testing.T) {
	adapter := loadLaoliMediaAdapter(t, "laoli-video")
	request := GenerationRequest{
		Capability:  CapabilityVideo,
		Model:       "原生人脸2.5",
		Prompt:      "@图片1 and @音频1",
		Duration:    5,
		Resolution:  "720p",
		AspectRatio: "16:9",
		Images:      []MediaReference{{URL: "https://cdn.example/ref.png", Kind: "image", Order: 0}},
		Audios:      []MediaReference{{URL: "https://cdn.example/ref.wav", Kind: "audio", Order: 0}},
		Extra:       map[string]any{"idempotencyKey": "a1b2c3d4-1234-4234-9234-aabbccddeeff"},
	}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/v1/videos" || spec.Headers["Idempotency-Key"] != request.Extra["idempotencyKey"] {
		t.Fatalf("video create = %#v", spec)
	}
	body := manifestTestBody(t, spec)
	images := body["reference_images"].([]any)
	audios := body["reference_audios"].([]any)
	if body["model"] != request.Model || body["seconds"] != float64(5) || body["resolution"] != "720p" || body["aspect_ratio"] != "16:9" || images[0] != request.Images[0].URL || audios[0] != request.Audios[0].URL {
		t.Fatalf("video create body = %#v", body)
	}
	if _, exists := body["enable_audio"]; exists {
		t.Fatalf("non-Wan model must not receive enable_audio: %#v", body)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"video-task-1","status":"queued"}`))
	if err != nil || created.TaskID != "video-task-1" || created.Status != StatusPending {
		t.Fatalf("video create response = %#v, err=%v", created, err)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil || poll.Path != "/v1/videos/video-task-1" {
		t.Fatalf("video poll = %#v, err=%v", poll, err)
	}
	completed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"video-task-1","status":"completed","video_url":"https://signed.example/video.mp4"}`))
	if err != nil || completed.Status != StatusSucceeded || completed.Result == nil || len(completed.Result.Videos) != 1 || !completed.Result.Videos[0].Ephemeral {
		t.Fatalf("video completion = %#v, err=%v", completed, err)
	}
	resultAdapter := adapter.(ResultAdapter)
	result, err := resultAdapter.BuildResult(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil || result.Path != "/v1/videos/video-task-1/content" || result.Headers["Accept"] != "video/mp4" || result.Auth.Type != "bearer" {
		t.Fatalf("video binary result = %#v, err=%v", result, err)
	}

	failure, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"video-task-1","status":"failed","error":{"message":"素材不可用","code":"INVALID_MEDIA"}}`))
	if err != nil || failure.Status != StatusFailed || failure.Message != "素材不可用" {
		t.Fatalf("video failure = %#v, err=%v", failure, err)
	}

	if adapter.Metadata().IdempotentCreate {
		t.Fatal("video create must not retry automatically when the upstream result is unknown")
	}
}
