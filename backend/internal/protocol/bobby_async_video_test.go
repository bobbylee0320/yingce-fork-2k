package protocol

import (
	"context"
	"testing"
)

func TestBobbyAsyncVideoMatchesPublishedVideoContract(t *testing.T) {
	adapter := officialPackageAdapter(t, "bobby-async-video.yingce-plugin", "bobby-async-video")
	if adapter.Metadata().Name != "bobby异步视频插件" {
		t.Fatalf("plugin name = %q", adapter.Metadata().Name)
	}

	firstFrame := GenerationRequest{
		Capability:  CapabilityVideo,
		Model:       "video-model",
		Prompt:      "A short cinematic scene",
		Duration:    5,
		AspectRatio: "16:9",
		Resolution:  "720p",
		Images:      []MediaReference{{URL: "https://cdn.example/first.jpg", Role: "first_frame", Order: 1}},
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{BaseURL: "https://newapi.bobby707.xyz", Request: firstFrame})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/videos" || create.ContentType != "application/json" || create.Auth.Type != "bearer" {
		t.Fatalf("create spec = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != firstFrame.Model || body["prompt"] != firstFrame.Prompt || body["seconds"] != float64(5) || body["resolution"] != "720p" || body["aspect_ratio"] != "16:9" || body["input_reference"] != "https://cdn.example/first.jpg" {
		t.Fatalf("first-frame create body = %#v", body)
	}
	for _, field := range []string{"reference_images", "reference_videos", "reference_audios"} {
		if _, exists := body[field]; exists {
			t.Fatalf("first-frame mode must omit %s: %#v", field, body)
		}
	}

	omni := GenerationRequest{
		Capability: CapabilityVideo,
		Model:      "video-model",
		Prompt:     "Use the references",
		Duration:   8,
		Images:     []MediaReference{{URL: "https://cdn.example/ref.png", Role: "reference_image", Order: 1}},
		Videos:     []MediaReference{{URL: "https://cdn.example/ref.mp4", Order: 2}},
		Audios:     []MediaReference{{URL: "https://cdn.example/ref.mp3", Order: 3}},
	}
	omniCreate, err := adapter.BuildCreate(context.Background(), RequestContext{BaseURL: "https://newapi.bobby707.xyz", Request: omni})
	if err != nil {
		t.Fatal(err)
	}
	omniBody := manifestTestBody(t, omniCreate)
	assertSingleURLObject := func(field, key, want string) {
		t.Helper()
		items, ok := omniBody[field].([]any)
		if !ok || len(items) != 1 {
			t.Fatalf("%s = %#v", field, omniBody[field])
		}
		item, ok := items[0].(map[string]any)
		if !ok || item[key] != want {
			t.Fatalf("%s = %#v, want %s=%q", field, items[0], key, want)
		}
	}
	assertSingleURLObject("reference_images", "image_url", "https://cdn.example/ref.png")
	assertSingleURLObject("reference_videos", "video_url", "https://cdn.example/ref.mp4")
	assertSingleURLObject("reference_audios", "audio_url", "https://cdn.example/ref.mp3")
	if _, exists := omniBody["input_reference"]; exists {
		t.Fatalf("omni mode must omit input_reference: %#v", omniBody)
	}

	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"public-video-id","object":"video","status":"queued","progress":0}`))
	if err != nil {
		t.Fatal(err)
	}
	if created.TaskID != "public-video-id" || created.Status != StatusPending {
		t.Fatalf("create response = %#v", created)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{BaseURL: "https://newapi.bobby707.xyz", TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Method != "GET" || poll.Path != "/v1/videos/public-video-id" || poll.Auth.Type != "bearer" {
		t.Fatalf("poll spec = %#v", poll)
	}
	unknown, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"public-video-id","status":"unknown"}`))
	if err != nil || unknown.Status != StatusPending {
		t.Fatalf("unknown task response = %#v, err=%v", unknown, err)
	}
	completed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"public-video-id","status":"completed","progress":100}`))
	if err != nil || completed.Status != StatusSucceeded {
		t.Fatalf("completed task response = %#v, err=%v", completed, err)
	}
	result, ok := adapter.(ResultAdapter)
	if !ok || !adapter.(ResultCapability).ResultAvailable() {
		t.Fatal("plugin must expose the authenticated /content result operation")
	}
	download, err := result.BuildResult(context.Background(), PollContext{BaseURL: "https://newapi.bobby707.xyz", TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if download.Method != "GET" || download.Path != "/v1/videos/public-video-id/content" || download.Headers["Accept"] != "video/mp4" || download.Auth.Type != "bearer" {
		t.Fatalf("result download spec = %#v", download)
	}
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, []byte(`{"id":"public-video-id","status":"failed","error":{"message":"model unavailable","code":"model_error"}}`))
	if err != nil || failed.Status != StatusFailed || failed.Message != "model unavailable" {
		t.Fatalf("failed task response = %#v, err=%v", failed, err)
	}
}

func TestBobbyAsyncVideoRejectsUndocumentedFrameCombinations(t *testing.T) {
	adapter := officialPackageAdapter(t, "bobby-async-video.yingce-plugin", "bobby-async-video")
	base := GenerationRequest{Capability: CapabilityVideo, Model: "video-model", Prompt: "test", Duration: 5}
	for _, test := range []struct {
		name    string
		images  []MediaReference
		videos  []MediaReference
		wantErr string
	}{
		{
			name: "first frame mixed with reference media",
			images: []MediaReference{
				{URL: "https://cdn.example/first.jpg", Role: "first_frame"},
				{URL: "https://cdn.example/ref.jpg", Role: "reference_image"},
			},
			wantErr: "input_reference 单首帧模式不能与 reference_* 全能参考素材混用。",
		},
		{
			name:    "undocumented last frame",
			images:  []MediaReference{{URL: "https://cdn.example/last.jpg", Role: "last_frame"}},
			wantErr: "本站通用视频文档没有定义独立 last_frame 字段，请移除尾帧或使用目标模型专用协议。",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := base
			request.Images, request.Videos = test.images, test.videos
			_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("BuildCreate error = %v, want %q", err, test.wantErr)
			}
		})
	}
}
