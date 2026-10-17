package canvas

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func waitPresenceEvent(t *testing.T, session *RealtimeSession, match func(RealtimeEvent) bool) RealtimeEvent {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-session.Events:
			if match(event) {
				return event
			}
		case <-timer.C:
			t.Fatal("realtime event not delivered")
			return RealtimeEvent{}
		}
	}
}

func TestCanvasRealtimePresenceAndScopeIsolation(t *testing.T) {
	hub := NewRealtimeHub(nil)
	a, _, err := hub.Open(context.Background(), "user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, peers, err := hub.Open(context.Background(), "user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	foreign, _, _ := hub.Open(context.Background(), "other", "canvas")
	defer foreign.Close()
	other, _, _ := hub.Open(context.Background(), "user", "other")
	defer other.Close()
	if len(peers) != 2 || a.ID() == b.ID() {
		t.Fatalf("unexpected roster: %+v", peers)
	}
	if err := a.Update(&PresencePoint{X: 12, Y: -3}, []PresenceNode{{ID: "node", PresencePoint: PresencePoint{X: 40, Y: 60}, Width: 240, Height: 160}}); err != nil {
		t.Fatal(err)
	}
	event := waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Peer != nil && e.Peer.ID == a.ID() && e.Peer.Cursor != nil })
	if event.Peer.Cursor.X != 12 || len(event.Peer.Drag) != 1 {
		t.Fatalf("lost presence: %+v", event)
	}
	if err := a.Update(&PresencePoint{X: math.NaN()}, nil); err == nil {
		t.Fatal("accepted non-finite position")
	}
	hub.Changed("user", "canvas")
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Type == "invalidate" })
	for _, isolated := range []*RealtimeSession{foreign, other} {
		for len(isolated.Events) > 0 {
			if event := <-isolated.Events; event.Type == "invalidate" || (event.Peer != nil && event.Peer.ID == a.ID()) {
				t.Fatal("cross-scope presence leak")
			}
		}
	}
	a.Close()
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Type == "leave" && e.PeerID == a.ID() })
}

func TestCanvasRealtimeAcrossRedisInstances(t *testing.T) {
	binary, err := exec.LookPath("redis-server")
	if err != nil {
		t.Skip("redis-server unavailable")
	}
	dir, err := os.MkdirTemp("", "canvas-presence-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "r.sock")
	cmd := exec.Command(binary, "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700", "--save", "", "--appendonly", "no", "--dir", dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	client := redis.NewClient(&redis.Options{Network: "unix", Addr: socket, MaxRetries: -1, ContextTimeoutEnabled: true})
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for client.Ping(ctx).Err() != nil {
		if ctx.Err() != nil {
			t.Fatal("temporary Redis did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}
	hubA, hubB := NewRealtimeHub(client), NewRealtimeHub(client)
	a, _, err := hubA.Open(ctx, "user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, _, err := hubB.Open(ctx, "user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if a.Snapshot().Number != 1 || b.Snapshot().Number != 2 {
		t.Fatalf("instances assigned inconsistent device numbers: %d / %d", a.Snapshot().Number, b.Snapshot().Number)
	}
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Peer != nil && e.Peer.ID == a.ID() })
	if err := a.Update(&PresencePoint{X: 88, Y: 99}, nil); err != nil {
		t.Fatal(err)
	}
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Peer != nil && e.Peer.Cursor != nil && e.Peer.Cursor.X == 88 })
	hubA.Changed("user", "canvas")
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Type == "invalidate" })
	a.Close()
	waitPresenceEvent(t, b, func(e RealtimeEvent) bool { return e.Type == "leave" && e.PeerID == a.ID() })
	c, _, err := hubA.Open(ctx, "user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Snapshot().Number != 1 || b.Snapshot().Number != 2 {
		t.Fatal("released number was not reused without renumbering another device")
	}
	if err := client.ZAdd(ctx, b.room+":devices", redis.Z{Score: 0, Member: b.deviceMember()}).Err(); err != nil {
		t.Fatal(err)
	}
	b.Heartbeat()
	select {
	case <-b.Done():
	default:
		t.Fatal("expired device number retained its connection")
	}
}

func TestCanvasRealtimeDeviceNumbersStayConsistentAndReuseDepartedSlots(t *testing.T) {
	hub := NewRealtimeHub(nil)
	open := func() (*RealtimeSession, []CanvasPresence) {
		t.Helper()
		s, peers, err := hub.Open(context.Background(), "user", "canvas")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.Close)
		return s, peers
	}
	a, _ := open()
	b, roster := open()
	c, _ := open()
	if a.Snapshot().Number != 1 || b.Snapshot().Number != 2 || c.Snapshot().Number != 3 {
		t.Fatal("device numbers are not unique")
	}
	for _, peer := range roster {
		if peer.ID == a.ID() && peer.Number != 1 || peer.ID == b.ID() && peer.Number != 2 {
			t.Fatalf("view-dependent numbering: %+v", roster)
		}
	}
	b.Close()
	d, _ := open()
	if d.Snapshot().Number != 2 || c.Snapshot().Number != 3 {
		t.Fatal("joining device changed existing numbers")
	}
	if err := c.Update(&PresencePoint{X: 30, Y: 40}, nil); err != nil {
		t.Fatal(err)
	}
	event := waitPresenceEvent(t, a, func(e RealtimeEvent) bool { return e.Peer != nil && e.Peer.ID == c.ID() && e.Peer.Cursor != nil })
	if event.Peer.Number != 3 {
		t.Fatal("broadcast changed device identity")
	}
}
