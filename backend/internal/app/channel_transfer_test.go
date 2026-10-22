package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func seedTransferChannel(t *testing.T, svc *Service, admin *model.User) string {
	t.Helper()
	channel, err := svc.CreateSystemChannel(admin, ChannelRequest{
		Name: "迁移渠道", BaseURL: "https://8.8.8.8/v1", APIKey: "secret-api-key", SecretKey: "secret-sk",
		Headers: []OutboundHeader{{Name: "X-Token", Value: "secret-header"}}, ProxyURL: "http://user:secret-proxy@8.8.4.4:8080",
	})
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	if _, err := svc.SaveAdminChannelModel(admin, channel.ID, "", ChannelModelRequest{
		ModelKey: "gpt-test", DisplayName: "GPT Test", Icon: "OpenAI", Description: "说明", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "gpt-test"),
		PriceTiers:       []ChannelModelPriceTierRequest{{BillingMode: "fixed_request", UnitPriceMicrocredits: 120000, PriceConfigured: true, Enabled: &enabled}}, Enabled: &enabled,
	}); err != nil {
		t.Fatal(err)
	}
	return channel.ID
}

func TestExportSystemChannelsOmitsSecrets(t *testing.T) {
	svc, _ := newChannelModelTestService(t)
	svc.dataDir = t.TempDir()
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	seedTransferChannel(t, svc, admin)
	exported, err := svc.ExportSystemChannels(admin, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := MarshalSystemChannelExport(exported)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, secret := range []string{"secret-api-key", "secret-sk", "secret-header", "secret-proxy"} {
		if strings.Contains(text, secret) {
			t.Fatalf("export leaked %q: %s", secret, text)
		}
	}
	if len(exported.Channels) != 1 || len(exported.Channels[0].Models) != 1 || exported.Channels[0].Models[0].Icon != "OpenAI" || len(exported.Channels[0].Models[0].PriceTiers) != 1 {
		t.Fatalf("export = %s", text)
	}
	if _, err := svc.ExportSystemChannels(&model.User{ID: "u", Role: model.UserRoleUser}, nil); err == nil {
		t.Fatal("non-admin export accepted")
	}
}

func TestExportSystemChannelsRejectsQueryParametersInBaseURL(t *testing.T) {
	svc, _ := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	if _, err := svc.CreateSystemChannel(admin, ChannelRequest{
		Name: "query-channel", BaseURL: "https://8.8.8.8/v1?api_key=secret-query",
	}); err != nil {
		t.Fatalf("create channel fixture: %v", err)
	}
	if _, err := svc.ExportSystemChannels(admin, nil); err == nil {
		t.Fatal("channel export accepted a Base URL with query parameters")
	} else if strings.Contains(err.Error(), "secret-query") {
		t.Fatal("channel export error exposed the query credential")
	}
}

func TestImportSystemChannelsCreatesDisabledAndKeepsExistingSecrets(t *testing.T) {
	source, _ := newChannelModelTestService(t)
	source.dataDir = t.TempDir()
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	seedTransferChannel(t, source, admin)
	exported, err := source.ExportSystemChannels(admin, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(exported)
	var payload SystemChannelExport
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}

	// 新环境：渠道新建为停用、无密钥，模型与价格档完整还原。
	target, _ := newChannelModelTestService(t)
	target.dataDir = t.TempDir()
	result, err := target.ImportSystemChannels(admin, payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.CreatedChannels) != 1 || result.SavedModels != 1 || len(result.Errors) != 0 {
		t.Fatalf("result = %#v", result)
	}
	channels, _ := target.repo.SystemChannels(true)
	if len(channels) != 1 || channels[0].Enabled || channels[0].APIKey != "" {
		t.Fatalf("imported channel = %#v", channels)
	}
	items, _ := target.repo.ChannelModels(channels[0].ID, true)
	if len(items) != 1 || items[0].Icon != "OpenAI" || items[0].Description != "说明" || len(items[0].PriceTiers) != 1 || items[0].PriceTiers[0].UnitPriceMicrocredits != 120000 {
		t.Fatalf("imported models = %#v", items)
	}

	// 已有环境：按名称合并，保留原有密钥，价格按文件更新。
	payload.Channels[0].Models[0].PriceTiers[0].UnitPriceMicrocredits = 200000
	result, err = source.ImportSystemChannels(admin, payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.UpdatedChannels) != 1 || len(result.Errors) != 0 {
		t.Fatalf("merge result = %#v", result)
	}
	existing, _ := source.repo.SystemChannels(true)
	if len(existing) != 1 {
		t.Fatalf("merge created duplicate channel: %#v", existing)
	}
	if err := source.decryptSystemChannelSecrets(&existing[0]); err != nil {
		t.Fatal(err)
	}
	if existing[0].APIKey != "secret-api-key" || !existing[0].Enabled {
		t.Fatalf("merge changed credentials or state: %#v", existing[0])
	}
	merged, _ := source.repo.ChannelModels(existing[0].ID, true)
	if len(merged) != 1 || merged[0].PriceTiers[0].UnitPriceMicrocredits != 200000 {
		t.Fatalf("merged models = %#v", merged)
	}

	if _, err := target.ImportSystemChannels(admin, SystemChannelExport{Format: "other", Version: 1}); err == nil {
		t.Fatal("foreign file accepted")
	}
}
