package protocol

import (
	"strings"
	"testing"
)

func providerKindManifest(kind, capabilities string) []byte {
	return []byte(`{
		"apiVersion":"yingce.plugin/v2",
		"id":"provider-kind-test","version":"1.0.0","name":"Provider Kind Test","author":"Test","documentation":"# Provider Kind Test",
		"contributes":{"providers":[{"id":"provider-kind-test","label":"Provider Kind Test","kind":"` + kind + `","capabilities":` + capabilities + `,"scopes":["canvas"],"create":{"method":"POST","path":"/tasks"},"response":{"taskIdPaths":["task_id"]}}]}
	}`)
}

func TestManifestProviderKindProjectsToMetadata(t *testing.T) {
	adapter, err := LoadManifest(providerKindManifest("processing", `["video"]`))
	if err != nil {
		t.Fatal(err)
	}
	if !adapter.Metadata().Kind.IsProcessing() {
		t.Fatalf("metadata kind = %q, want processing", adapter.Metadata().Kind)
	}
	generation, err := LoadManifest(providerKindManifest("", `["video"]`))
	if err != nil {
		t.Fatal(err)
	}
	if generation.Metadata().Kind.IsProcessing() {
		t.Fatal("empty kind must stay a generation provider")
	}
}

func TestManifestProviderKindRejectsInvalidDeclarations(t *testing.T) {
	cases := map[string][]byte{
		"unknown kind":            providerKindManifest("transcode", `["video"]`),
		"processing text":         providerKindManifest("processing", `["text"]`),
		"processing multi-output": providerKindManifest("processing", `["video","image"]`),
	}
	for name, manifest := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadManifest(manifest); err == nil || !strings.Contains(err.Error(), "kind") && !strings.Contains(err.Error(), "processing") {
				t.Fatalf("LoadManifest error = %v, want kind validation failure", err)
			}
		})
	}
}
