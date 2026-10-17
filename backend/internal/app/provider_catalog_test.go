package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/providercatalog"
)

func catalogTestBody(baseURL string) string {
	return fmt.Sprintf(`{
  "schemaVersion": 1,
  "tags": [{"id":"relay","label":"中转站","tone":"violet"}],
  "providers": [
    {"id":"acme","name":"Acme 中转","tags":["relay"],"rank":1,
     "startsAt":"2025-06-01T00:00:00Z","endsAt":"2025-07-01T00:00:00Z",
     "connection":{"baseUrl":%q},
     "models":[
       {"modelKey":"chat-a","displayName":"Chat A","capability":"text","protocol":"chat-completion",
        "priceTiers":[{"billingMode":"token","inputPerMillion":2,"outputPerMillion":8,"cachedPerMillion":0.5}]},
       {"modelKey":"video-a","displayName":"Video A","capability":"video","protocol":"newapi",
        "priceTiers":[{"selector":{"operation":"text_to_video","vquality":"720p","videoSeconds":"5"},"billingMode":"fixed_request","cost":1.2}]},
       {"modelKey":"unknown-a","capability":"image","protocol":"no-such-protocol","priceTiers":[{"cost":1}]}
     ]},
    {"id":"expired","name":"Expired","startsAt":"2025-01-01T00:00:00Z","endsAt":"2025-02-01T00:00:00Z",
     "connection":{"baseUrl":%q},
     "models":[{"modelKey":"chat-b","capability":"text","protocol":"chat-completion","priceTiers":[{"billingMode":"token","inputPerMillion":1,"outputPerMillion":1}]}]}
  ]
}`, baseURL, baseURL)
}

func newProviderCatalogTestService(t *testing.T) (*Service, func()) {
	t.Helper()
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewTLSServer(http.NotFoundHandler())
	catalogServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(catalogTestBody(upstream.URL + "/v1")))
	}))
	svc, _ := newChannelModelTestService(t)
	svc.dataDir = t.TempDir()
	now := time.Date(2025, 6, 15, 0, 0, 0, 0, time.UTC)
	svc.providerCatalog = providercatalog.NewSourceForTest(catalogServer.URL, "", catalogServer.Client(), filepath.Join(svc.dataDir, "catalog.json"), func() time.Time { return now })
	return svc, func() { catalogServer.Close(); upstream.Close() }
}

func TestAdminProviderCatalogFiltersExpiredAndMarksUnsupported(t *testing.T) {
	svc, cleanup := newProviderCatalogTestService(t)
	defer cleanup()
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	if _, err := svc.AdminProviderCatalog(context.Background(), &model.User{ID: "u", Role: model.UserRoleUser}, false); err == nil {
		t.Fatal("non-admin must be rejected")
	}
	view, err := svc.AdminProviderCatalog(context.Background(), admin, false)
	if err != nil {
		t.Fatal(err)
	}
	if view.Source != providercatalog.SourceLive || len(view.Providers) != 1 || view.Providers[0].ID != "acme" {
		t.Fatalf("view = %#v", view)
	}
	models := view.Providers[0].Models
	if len(models) != 3 || !models[0].Supported || !models[1].Supported || models[2].Supported || models[2].UnsupportedReason == "" {
		t.Fatalf("models = %#v", models)
	}
	if models[1].PriceTiers[0].CostUnitMicrocredits != 1_200_000 {
		t.Fatalf("video cost = %#v", models[1].PriceTiers[0])
	}
}

func TestInstallProviderCatalogCreatesPricedChannel(t *testing.T) {
	svc, cleanup := newProviderCatalogTestService(t)
	defer cleanup()
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	override := 50.0
	channel, err := svc.InstallProviderCatalog(context.Background(), admin, "acme", ProviderCatalogInstallRequest{
		APIKey: "sk-test", MarkupPercent: 30,
		Models: []ProviderCatalogInstallModel{{ModelKey: "chat-a", MarkupPercent: &override}, {ModelKey: "video-a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if channel.Name != "Acme 中转" || channel.CatalogProvider != "acme" || !channel.HasAPIKey || !channel.Enabled {
		t.Fatalf("channel = %#v", channel)
	}
	stored, err := svc.repo.AdminSystemChannel(channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.APIKey == "sk-test" || stored.APIKey == "" {
		t.Fatal("api key must be stored encrypted")
	}
	items, err := svc.repo.ChannelModels(channel.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d", len(items))
	}
	byKey := map[string]model.ChannelModel{}
	for _, item := range items {
		byKey[item.ModelKey] = item
	}
	chat := byKey["chat-a"]
	if !chat.Enabled || !chat.PriceConfigured || chat.CatalogModelKey != "chat-a" || len(chat.PriceTiers) != 1 {
		t.Fatalf("chat = %#v", chat)
	}
	tier := chat.PriceTiers[0]
	if tier.CostPricing.InputTokenPriceMicrocredits != 2_000_000 || tier.InputTokenPriceMicrocredits != 3_000_000 || tier.OutputTokenPriceMicrocredits != 12_000_000 || tier.CachedTokenPriceMicrocredits != 750_000 {
		t.Fatalf("chat tier = %#v", tier)
	}
	video := byKey["video-a"]
	if len(video.PriceTiers) != 1 || video.PriceTiers[0].CostPricing.UnitPriceMicrocredits != 1_200_000 || video.PriceTiers[0].UnitPriceMicrocredits != 1_560_000 {
		t.Fatalf("video tiers = %#v", video.PriceTiers)
	}
}

func TestInstallProviderCatalogRejectsInvalidSelections(t *testing.T) {
	svc, cleanup := newProviderCatalogTestService(t)
	defer cleanup()
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	cases := []struct {
		name     string
		provider string
		req      ProviderCatalogInstallRequest
		want     string
	}{
		{"expired", "expired", ProviderCatalogInstallRequest{APIKey: "k", Models: []ProviderCatalogInstallModel{{ModelKey: "chat-b"}}}, "推广期"},
		{"not recommended", "acme", ProviderCatalogInstallRequest{APIKey: "k", Models: []ProviderCatalogInstallModel{{ModelKey: "other"}}}, "推荐列表"},
		{"unsupported", "acme", ProviderCatalogInstallRequest{APIKey: "k", Models: []ProviderCatalogInstallModel{{ModelKey: "unknown-a"}}}, "不支持"},
		{"missing key", "acme", ProviderCatalogInstallRequest{Models: []ProviderCatalogInstallModel{{ModelKey: "chat-a"}}}, "API Key"},
		{"bad markup", "acme", ProviderCatalogInstallRequest{APIKey: "k", MarkupPercent: 2000, Models: []ProviderCatalogInstallModel{{ModelKey: "chat-a"}}}, "加价率"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.InstallProviderCatalog(context.Background(), admin, tc.provider, tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want contains %q", err, tc.want)
			}
		})
	}
	channels, err := svc.repo.SystemChannels(true)
	if err != nil || len(channels) != 0 {
		t.Fatalf("failed installs must not create channels: %d, %v", len(channels), err)
	}
}
