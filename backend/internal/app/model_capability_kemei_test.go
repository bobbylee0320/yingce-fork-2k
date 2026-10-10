package app

import "testing"

func TestKemeiSeedreamDefaultsAreValidAndUseOfficialTiers(t *testing.T) {
	for _, name := range []string{"doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915"} {
		profile := DefaultModelCapabilityConfigForModel("km-kemei-seedream", name).Image
		if err := validateImageCapabilityConfig(profile); err != nil {
			t.Fatal(err)
		}
		if profile.References.MaxImages != 10 || profile.References.MaskSupported || profile.MaxOutputs != 1 || profile.Size.Default != "2048x2048" || len(profile.Size.Presets) != 24 || profile.Quality.Supported || profile.TransparentBackground.Supported {
			t.Fatalf("defaults: %#v", profile)
		}
		for _, preset := range profile.Size.Presets {
			if preset.Tier == "4k" {
				t.Fatal("unsupported 4K default")
			}
			if preset.Size == "2816x1584" && preset.Tier != "2k" {
				t.Fatal("official 2K must not become 4K")
			}
		}
	}
}
