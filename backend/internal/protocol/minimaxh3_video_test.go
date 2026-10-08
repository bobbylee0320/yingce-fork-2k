package protocol

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestMinimaxH3VideoModes(t *testing.T) {
	adapter := officialPackageAdapter(t, "minimaxh3-video.yingce-plugin", "minimaxh3-video")
	cases := []struct {
		name    string
		request GenerationRequest
		mode    string
	}{
		{name: "text", request: GenerationRequest{}, mode: "first_last_frames"},
		{name: "unnamed single frame", request: GenerationRequest{Images: []MediaReference{{URL: "https://cdn.example/first.jpg"}}}, mode: "first_last_frames"},
		{name: "explicit frames out of order", request: GenerationRequest{Images: []MediaReference{
			{URL: "https://cdn.example/last.jpg", Role: "last_frame", Order: 1},
			{URL: "https://cdn.example/first.jpg", Role: "first_frame", Order: 2},
		}}, mode: "first_last_frames"},
		{name: "multiple keyframes", request: GenerationRequest{Images: []MediaReference{
			{URL: "https://cdn.example/last.jpg", Order: 2}, {URL: "https://cdn.example/first.jpg", Order: 1},
		}, ProviderOptions: map[string]map[string]any{"minimaxh3-video": {"function_mode": "multi_frame"}}}, mode: "multi_frame"},
		{name: "image only omni", request: GenerationRequest{Images: []MediaReference{{URL: "https://cdn.example/first.jpg", Role: "reference_image", Name: "角色A"}}}, mode: "omni_reference"},
		{name: "all modalities", request: GenerationRequest{
			Images:          []MediaReference{{URL: "https://cdn.example/first.jpg", Name: "角色A", Role: "reference_image"}},
			Videos:          []MediaReference{{URL: "https://cdn.example/street.mp4", Name: "场景"}},
			Audios:          []MediaReference{{URL: "https://cdn.example/music.mp3", Name: "配乐"}},
			ProviderOptions: map[string]map[string]any{"minimaxh3-video": {"channel": "lumen", "face": map[string]any{"enabled": false}}},
		}, mode: "omni_reference"},
		{name: "unnamed media aliases", request: GenerationRequest{
			Images: []MediaReference{{URL: "https://cdn.example/last.jpg", Order: 2}, {URL: "https://cdn.example/first.jpg", Order: 1}},
			Videos: []MediaReference{{URL: "https://cdn.example/street.mp4"}},
			Audios: []MediaReference{{URL: "https://cdn.example/music.mp3"}},
		}, mode: "omni_reference"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.request.Model = "minimaxH3"
			tc.request.Prompt = "@角色A 在 @场景 里走路，配乐用 @配乐"
			tc.request.Duration = 8
			tc.request.Resolution = "1080P"
			tc.request.AspectRatio = "9:16"
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: tc.request})
			if err != nil {
				t.Fatal(err)
			}
			body := manifestTestBody(t, spec)
			if spec.Method != "POST" || spec.Path != "/v1/videos/generations" || spec.Auth.Type != "bearer" || body["function_mode"] != tc.mode {
				t.Fatalf("spec=%#v body=%#v", spec, body)
			}
			if body["model"] != "minimaxH3" || body["prompt"] != tc.request.Prompt || body["ratio"] != "9:16" || body["duration"] != float64(8) || body["video_resolution"] != "1080p" {
				t.Fatalf("shared fields=%#v", body)
			}
			for _, field := range []string{"content", "image_urls", "aspect_ratio", "resolution", "size", "generate_audio", "watermark"} {
				if _, ok := body[field]; ok {
					t.Fatalf("unexpected Ark/unsupported field %s", field)
				}
			}
			switch tc.mode {
			case "first_last_frames":
				if _, ok := body["materials"]; ok {
					t.Fatal("mixed materials")
				}
				if _, ok := body["multi_frames"]; ok {
					t.Fatal("mixed multi_frames")
				}
				if len(tc.request.Images) > 0 && body["first_frame_url"] != "https://cdn.example/first.jpg" {
					t.Fatalf("first=%v", body)
				}
				if len(tc.request.Images) == 2 && body["end_frame_url"] != "https://cdn.example/last.jpg" {
					t.Fatalf("last=%v", body)
				}
			case "multi_frame":
				frames := body["multi_frames"].([]any)
				if frames[0] != "https://cdn.example/first.jpg" || frames[1] != "https://cdn.example/last.jpg" {
					t.Fatalf("frames=%v", frames)
				}
				if _, ok := body["first_frame_url"]; ok {
					t.Fatal("mixed first frame")
				}
			case "omni_reference":
				materials := body["materials"].([]any)
				if len(materials) != len(tc.request.Images)+len(tc.request.Videos)+len(tc.request.Audios) {
					t.Fatalf("materials=%v", materials)
				}
				for _, field := range []string{"first_frame_url", "end_frame_url", "multi_frames"} {
					if _, ok := body[field]; ok {
						t.Fatalf("mixed field %s", field)
					}
				}
				if tc.name == "all modalities" {
					for index, kind := range []string{"image", "video", "audio"} {
						item := materials[index].(map[string]any)
						if item["type"] != kind || item["name"] != []string{"角色A", "场景", "配乐"}[index] {
							t.Fatalf("item=%v", item)
						}
					}
					if body["channel"] != "lumen" || body["face"].(map[string]any)["enabled"] != false {
						t.Fatalf("options=%v", body)
					}
				}
				if tc.name == "unnamed media aliases" {
					for index, name := range []string{"image_file_1", "image_file_2", "video_file_1", "audio_file_1"} {
						if materials[index].(map[string]any)["name"] != name {
							t.Fatalf("alias=%v", materials)
						}
					}
				}
			}
		})
	}
}

func TestMinimaxH3VideoRejectInvalidReferences(t *testing.T) {
	adapter := officialPackageAdapter(t, "minimaxh3-video.yingce-plugin", "minimaxh3-video")
	media := MediaReference{URL: "https://cdn.example/ref.jpg"}
	cases := []GenerationRequest{
		{Images: []MediaReference{{DataURL: "data:image/png;base64,aA=="}}},
		{Images: []MediaReference{{URL: "file:///tmp/image.png"}}},
		{Images: []MediaReference{{URL: media.URL, Role: "last_frame"}}},
		{Images: []MediaReference{{URL: media.URL, Role: "first_frame"}}, Videos: []MediaReference{{URL: "https://cdn.example/ref.mp4"}}},
		{Images: []MediaReference{media}, ProviderOptions: map[string]map[string]any{"minimaxh3-video": {"function_mode": "multi_frame"}}},
		{Images: []MediaReference{media, media, media}},
		{Images: []MediaReference{{URL: media.URL, Metadata: map[string]any{"bytes": 20*1024*1024 + 1}}}},
		{Audios: []MediaReference{{URL: "https://cdn.example/ref.mp3", Metadata: map[string]any{"durationMs": 15001}}}},
		{Images: make([]MediaReference, 31)},
		{Videos: make([]MediaReference, 11)},
		{Audios: make([]MediaReference, 11)},
		{ProviderOptions: map[string]map[string]any{"minimaxh3-video": {"function_mode": "unknown"}}},
		{AspectRatio: "adaptive"},
		{Resolution: "bad"},
		{Prompt: strings.Repeat("字", 8001)},
	}
	for index, request := range cases {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			request.Model = "minimaxH3"
			if request.Prompt == "" {
				request.Prompt = "test"
			}
			for _, items := range [][]MediaReference{request.Images, request.Videos, request.Audios} {
				for i := range items {
					if items[i].URL == "" && items[i].DataURL == "" {
						items[i].URL = media.URL
					}
				}
			}
			if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
}

func TestMinimaxH3VideoPollAndHDDownload(t *testing.T) {
	adapter := officialPackageAdapter(t, "minimaxh3-video.yingce-plugin", "minimaxh3-video")
	created, err := adapter.ParseCreate(context.Background(), []byte(`{"task_id":"cgt-test","status":"pending"}`))
	if err != nil || created.TaskID != "cgt-test" || created.Status != StatusPending {
		t.Fatalf("create=%#v err=%v", created, err)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil || poll.Path != "/v1/tasks/cgt-test" {
		t.Fatalf("poll=%#v err=%v", poll, err)
	}
	for _, status := range []string{"pending", "submitted", "generating", "post_processing", "finalizing", "success", "failed"} {
		t.Run(status, func(t *testing.T) {
			body := []byte(fmt.Sprintf(`{"status":%q,"result_urls":["https://cdn.example/preview.mp4"],"source_urls":["https://cdn.example/hd.mp4"],"fail_reason":"真实失败原因"}`, status))
			result, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "cgt-test"}, body)
			want := StatusProcessing
			switch status {
			case "pending", "submitted":
				want = StatusPending
			case "success":
				want = StatusSucceeded
			case "failed":
				want = StatusFailed
			}
			if err != nil || result.Status != want || result.TaskID != "cgt-test" || result.Result != nil {
				t.Fatalf("result=%#v err=%v", result, err)
			}
			if status == "failed" && result.Message != "真实失败原因" {
				t.Fatalf("message=%s", result.Message)
			}
		})
	}
	download, err := adapter.(ResultAdapter).BuildResult(context.Background(), PollContext{TaskID: "cgt-test"})
	if err != nil || download.Method != "GET" || download.Path != "/v1/tasks/cgt-test/download" || len(download.Query["index"]) != 1 || download.Query["index"][0] != "0" || download.Auth.Type != "bearer" || !adapter.(ResultCapability).ResultAvailable() {
		t.Fatalf("download=%#v err=%v", download, err)
	}
	if _, err := adapter.BuildCancel(context.Background(), PollContext{TaskID: "cgt-test"}); err == nil {
		t.Fatal("invented cancellation endpoint")
	}
	failed, err := adapter.ParseCreate(context.Background(), []byte(`{"error":"余额不足"}`))
	if err != nil || failed.Status != StatusFailed || failed.Message != "余额不足" {
		t.Fatalf("error=%#v err=%v", failed, err)
	}
}
