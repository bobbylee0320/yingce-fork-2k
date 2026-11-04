package protocol

import (
	"context"
	"testing"
)

func TestSuanliAIAsyncVideoMapsUnifiedFieldsToSuanliAI(t *testing.T) {
	adapter := officialPackageAdapter(t, "suanliai-async-video.yingce-plugin", "suanliai-async-video")
	request := GenerationRequest{
		Capability:  CapabilityVideo,
		Model:       "video-model",
		Prompt:      "保持人物外观，镜头缓慢推进",
		Duration:    8,
		Resolution:  "720p",
		AspectRatio: "16:9",
		Images:      []MediaReference{{URL: "https://cdn.example/character.jpg", Role: "reference_image", Order: 1}},
		Videos:      []MediaReference{{URL: "https://cdn.example/motion.mp4", Role: "reference_video", Order: 2}},
		Audios:      []MediaReference{{URL: "https://cdn.example/voice.mp3", Role: "reference_voice", Order: 3}},
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{BaseURL: "https://suanliai.top", Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/videos" || create.Auth.Type != "bearer" {
		t.Fatalf("create spec = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != request.Model || body["prompt"] != request.Prompt || body["seconds"] != float64(8) || body["size"] != "1280x720" {
		t.Fatalf("create body = %#v", body)
	}
	if _, exists := body["resolution"]; exists {
		t.Fatalf("SuanliAI request must map resolution to size: %#v", body)
	}
	if _, exists := body["aspect_ratio"]; exists {
		t.Fatalf("SuanliAI request must map aspect ratio to size: %#v", body)
	}
	if _, exists := body["input_reference"]; exists {
		t.Fatalf("omni references must not emit input_reference: %#v", body)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"task_id":"task_1","status":"queued","progress":0}`))
	if err != nil || created.TaskID != "task_1" || created.Status != StatusPending {
		t.Fatalf("create response = %#v, err=%v", created, err)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{BaseURL: "https://suanliai.top", TaskID: created.TaskID})
	if err != nil || poll.Path != "/v1/videos/task_1" {
		t.Fatalf("poll spec = %#v, err=%v", poll, err)
	}
	completed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"task_id":"task_1","status":"completed","progress":100}`))
	if err != nil || completed.Status != StatusSucceeded {
		t.Fatalf("completed response = %#v, err=%v", completed, err)
	}
	result, ok := adapter.(ResultAdapter)
	if !ok || !adapter.(ResultCapability).ResultAvailable() {
		t.Fatal("SuanliAI plugin must expose authenticated content download")
	}
	download, err := result.BuildResult(context.Background(), PollContext{BaseURL: "https://suanliai.top", TaskID: created.TaskID})
	if err != nil || download.Path != "/v1/videos/task_1/content" || download.Auth.Type != "bearer" {
		t.Fatalf("result spec = %#v, err=%v", download, err)
	}
}
