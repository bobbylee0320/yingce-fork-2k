package providercatalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCachedReadsDoNotWaitForRefresh(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	now := time.Now()
	source := NewSourceForTest(server.URL, "", server.Client(), "", func() time.Time { return now })
	source.loaded = true
	source.snapshot = Snapshot{Catalog: &Catalog{SchemaVersion: 1}, FetchedAt: now.Add(-time.Hour), ETag: "v1", State: SourceCache}
	result := source.Get(context.Background())
	if result.Catalog == nil {
		t.Fatal("cached catalog missing")
	}
	<-started
	read := make(chan Snapshot, 1)
	go func() { read <- source.Get(context.Background()) }()
	select {
	case cached := <-read:
		if cached.Catalog == nil {
			t.Error("cached catalog missing during refresh")
		}
	case <-time.After(time.Second):
		t.Error("cached read blocked by network refresh")
	}
	source.mu.Lock()
	done := source.inflight
	source.mu.Unlock()
	close(release)
	<-done
}

func TestFailedGetBacksOffAndExplicitRefreshRetries(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusBadGateway) }))
	defer server.Close()
	now := time.Now()
	source := NewSourceForTest(server.URL, "", server.Client(), "", func() time.Time { return now })
	source.Get(context.Background())
	source.Get(context.Background())
	if calls != 1 {
		t.Fatalf("failed Get retried without cooldown: %d", calls)
	}
	source.Refresh(context.Background())
	if calls != 2 {
		t.Fatalf("explicit refresh did not retry: %d", calls)
	}
	now = now.Add(31 * time.Second)
	source.Get(context.Background())
	if calls != 3 {
		t.Fatalf("Get did not retry after cooldown: %d", calls)
	}
}
