package providercatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	DefaultURL      = "https://ai.yingce.tv/v1/catalog.json"
	DefaultLogoBase = "https://ai.yingce.tv"
	// 只有管理员打开目录时才会读取；超过该时间按需同步刷新一次。
	staleAfter = 5 * time.Minute
)

type SourceState string

const (
	SourceLive        SourceState = "live"
	SourceCache       SourceState = "cache"
	SourceUnavailable SourceState = "unavailable"
	SourceDisabled    SourceState = "disabled"
)

// Snapshot 是最近一次成功解析的目录。
type Snapshot struct {
	Catalog   *Catalog
	ETag      string
	FetchedAt time.Time
	State     SourceState
	LastError string
}

type persisted struct {
	ETag      string          `json:"etag"`
	FetchedAt time.Time       `json:"fetchedAt"`
	Body      json.RawMessage `json:"body"`
}

// Source 负责拉取、缓存和落盘目录快照。HTTP 客户端由调用方注入，
// 以复用统一的 SSRF 校验出站链路。
type Source struct {
	url      string
	logoBase string
	disabled bool
	path     string
	client   *http.Client
	now      func() time.Time

	mu       sync.Mutex
	snapshot Snapshot
	loaded   bool
	retryAt  time.Time
	inflight chan struct{}
}

func NewSource(dataDir string, client *http.Client) *Source {
	source := &Source{
		url:      DefaultURL,
		logoBase: DefaultLogoBase,
		disabled: strings.TrimSpace(os.Getenv("CANVAS_PROVIDER_CATALOG_DISABLED")) == "1",
		client:   client,
		now:      time.Now,
	}
	if strings.TrimSpace(dataDir) != "" {
		source.path = filepath.Join(dataDir, "provider-catalog", "catalog.json")
	}
	return source
}

// NewSourceForTest 允许测试指定目录地址与时间。
func NewSourceForTest(url string, logoBase string, client *http.Client, path string, now func() time.Time) *Source {
	return &Source{url: url, logoBase: logoBase, client: client, path: path, now: now}
}

func (s *Source) Now() time.Time { return s.now() }

// Get 有缓存时立即返回；过期缓存后台刷新，绝不让网络 I/O 持有快照锁。
func (s *Source) Get(ctx context.Context) Snapshot {
	s.mu.Lock()
	if s.disabled {
		s.mu.Unlock()
		return Snapshot{State: SourceDisabled}
	}
	s.loadLocked()
	stale := s.snapshot.Catalog == nil || s.now().Sub(s.snapshot.FetchedAt) > staleAfter
	if !stale || s.now().Before(s.retryAt) {
		result := s.snapshot
		s.mu.Unlock()
		return result
	}
	if s.snapshot.Catalog != nil {
		result := s.snapshot
		if s.inflight == nil {
			s.inflight = make(chan struct{})
			go s.refresh(context.Background())
		}
		s.mu.Unlock()
		return result
	}
	s.mu.Unlock()
	return s.Refresh(ctx)
}

// Refresh 并发请求共享一次拉取，等待者取消不影响其他请求。
func (s *Source) Refresh(ctx context.Context) Snapshot {
	s.mu.Lock()
	if s.disabled {
		s.mu.Unlock()
		return Snapshot{State: SourceDisabled}
	}
	s.loadLocked()
	done := s.inflight
	if done == nil {
		done = make(chan struct{})
		s.inflight = done
		go s.refresh(context.Background())
	}
	s.mu.Unlock()
	select {
	case <-done:
	case <-ctx.Done():
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot
}

func (s *Source) loadLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.path == "" {
		return
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var stored persisted
	if json.Unmarshal(raw, &stored) != nil {
		return
	}
	catalog, _, err := Parse(stored.Body, s.logoBase)
	if err != nil {
		return
	}
	s.snapshot = Snapshot{Catalog: catalog, ETag: stored.ETag, FetchedAt: stored.FetchedAt, State: SourceCache}
}

func (s *Source) refresh(ctx context.Context) {
	s.mu.Lock()
	previous := s.snapshot
	s.mu.Unlock()
	body, etag, notModified, err := s.fetch(ctx, previous)
	var catalog *Catalog
	if err == nil && !notModified {
		var warnings []string
		catalog, warnings, err = Parse(body, s.logoBase)
		for _, warning := range warnings {
			log.Printf("provider catalog: %s", warning)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() { close(s.inflight); s.inflight = nil }()
	if err != nil {
		s.markFailureLocked(err)
		return
	}
	s.retryAt = time.Time{}
	if notModified && s.snapshot.Catalog != nil {
		s.snapshot.FetchedAt = s.now()
		s.snapshot.State = SourceLive
		s.snapshot.LastError = ""
		return
	}
	s.snapshot = Snapshot{Catalog: catalog, ETag: etag, FetchedAt: s.now(), State: SourceLive}
	s.persistLocked(body)
}

func (s *Source) markFailureLocked(err error) {
	log.Printf("provider catalog refresh failed: %v", err)
	s.snapshot.LastError = err.Error()
	s.retryAt = s.now().Add(30 * time.Second)
	if s.snapshot.Catalog != nil {
		s.snapshot.State = SourceCache
	} else {
		s.snapshot.State = SourceUnavailable
	}
}

func (s *Source) fetch(ctx context.Context, previous Snapshot) ([]byte, string, bool, error) {
	if s.client == nil {
		return nil, "", false, errors.New("目录客户端未初始化")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("Accept", "application/json")
	if previous.Catalog != nil && previous.ETag != "" {
		req.Header.Set("If-None-Match", previous.ETag)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, "", false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, previous.ETag, true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", false, fmt.Errorf("目录服务返回 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxCatalogBytes+1))
	if err != nil {
		return nil, "", false, err
	}
	if len(body) > MaxCatalogBytes {
		return nil, "", false, errors.New("目录超过 2MB 上限")
	}
	return body, resp.Header.Get("ETag"), false, nil
}

func (s *Source) persistLocked(body []byte) {
	if s.path == "" {
		return
	}
	raw, err := json.Marshal(persisted{ETag: s.snapshot.ETag, FetchedAt: s.snapshot.FetchedAt, Body: body})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}
