package protocol

import (
	"context"
	"testing"
)

func TestKemeiSeedreamRequestDefaultsAndReferences(t *testing.T) {
	adapter := officialPackageAdapter(t, "km-kemei-seedream.yingce-plugin", "km-kemei-seedream")
	for _, name := range []string{"doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915"} {
		request := GenerationRequest{Model: name, Prompt: "暖色书房中的橘猫", ImageCount: 1, Quality: "high"}
		spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
		if err != nil {
			t.Fatal(err)
		}
		body := manifestTestBody(t, spec)
		if spec.Path != "/v1/images/generations" || body["model"] != name || body["n"] != float64(1) || body["size"] != "2K" || body["response_format"] != "url" || body["output_format"] != "jpeg" || body["watermark"] != false {
			t.Fatalf("defaults = %#v", body)
		}
		for _, key := range []string{"image", "quality", "resolution", "seed", "stream", "web_search", "sequential_image_generation"} {
			if _, exists := body[key]; exists {
				t.Fatalf("unexpected %s: %#v", key, body)
			}
		}
		request.Images = []MediaReference{{URL: "https://example.com/b.png", Order: 2}, {DataURL: "data:image/png;base64,aA==", Order: 1}}
		request.AspectRatio = "16:9"
		spec, err = adapter.BuildCreate(context.Background(), RequestContext{Request: request})
		if err != nil {
			t.Fatal(err)
		}
		body = manifestTestBody(t, spec)
		images := body["image"].([]any)
		if body["size"] != "2816x1584" || len(images) != 2 || images[0] != request.Images[1].DataURL {
			t.Fatalf("references = %#v", body)
		}
		for _, size := range []string{"1K", "1.5K", "2K", "2352x1008", "2816x1584", "1536x1536"} {
			request.AspectRatio = size
			if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request}); err != nil {
				t.Fatalf("size %s: %v", size, err)
			}
		}
	}
}

func TestKemeiSeedreamRejectsUnsupportedAndOutOfRangeRequests(t *testing.T) {
	adapter := officialPackageAdapter(t, "km-kemei-seedream.yingce-plugin", "km-kemei-seedream")
	base := GenerationRequest{Model: "doubao-seedream-5-0-pro-260628", Prompt: "橘猫", ImageCount: 1, AspectRatio: "2048x2048"}
	for _, tc := range []struct {
		name   string
		change func(*GenerationRequest)
	}{
		{"wrong model", func(r *GenerationRequest) { r.Model = "midjourney-1k" }},
		{"multiple outputs", func(r *GenerationRequest) { r.ImageCount = 2 }},
		{"empty prompt", func(r *GenerationRequest) { r.Prompt = " " }},
		{"too small", func(r *GenerationRequest) { r.AspectRatio = "512x512" }},
		{"4k", func(r *GenerationRequest) { r.AspectRatio = "4K" }},
		{"too large", func(r *GenerationRequest) { r.AspectRatio = "2880x2880" }},
		{"bad dimensions", func(r *GenerationRequest) { r.AspectRatio = "2048x2048x1" }},
		{"mask", func(r *GenerationRequest) {
			r.Images = []MediaReference{{URL: "https://example.com/a.png", Role: "mask"}}
		}},
		{"too many references", func(r *GenerationRequest) {
			for i := 0; i < 11; i++ {
				r.Images = append(r.Images, MediaReference{URL: "https://example.com/a.png"})
			}
		}},
		{"oversize reference", func(r *GenerationRequest) {
			r.Images = []MediaReference{{URL: "https://example.com/a.png", Metadata: map[string]any{"bytes": 30*1024*1024 + 1}}}
		}},
		{"unsupported format", func(r *GenerationRequest) {
			r.ProviderOptions = map[string]map[string]any{"km-kemei-seedream": {"output_format": "webp"}}
		}},
		{"group generation", func(r *GenerationRequest) {
			r.ProviderOptions = map[string]map[string]any{"km-kemei-seedream": {"sequential_image_generation": "auto"}}
		}},
		{"transparent text", func(r *GenerationRequest) {
			r.ProviderOptions = map[string]map[string]any{"km-kemei-seedream": {"background": "transparent", "output_format": "png"}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := base
			tc.change(&request)
			if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Fatal("invalid request accepted")
			}
		})
	}
}

func TestKemeiSeedreamLayerResultsAndErrors(t *testing.T) {
	adapter := officialPackageAdapter(t, "km-kemei-seedream.yingce-plugin", "km-kemei-seedream")
	request := GenerationRequest{Model: "doubao-seedream-5-0-flash-260915", AspectRatio: "auto", Images: []MediaReference{{URL: "https://example.com/source.png"}}, ProviderOptions: map[string]map[string]any{"km-kemei-seedream": {"layer_decomposition": true, "output_format": "png"}}}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil || manifestTestBody(t, spec)["size"] != "auto" {
		t.Fatalf("layer request: %#v %v", spec, err)
	}
	result, err := adapter.ParseCreate(context.Background(), []byte(`{"data":[{"url":"https://example.com/base.png","z_index":0},{"b64_json":"aA==","z_index":1}],"usage":{"generated_images":2}}`))
	if err != nil || result.Status != StatusSucceeded || result.Result == nil || len(result.Result.Images) != 2 {
		t.Fatalf("results: %#v %v", result, err)
	}
	result, err = adapter.ParseCreate(context.Background(), []byte(`{"error":{"code":"invalid_size","message":"尺寸不合法"}}`))
	if err != nil || result.Status != StatusFailed || result.Message != "尺寸不合法" {
		t.Fatalf("error: %#v %v", result, err)
	}
}
