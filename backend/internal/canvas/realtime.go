package canvas

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"yingce/backend/internal/kernel"
)

type PresencePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type PresenceNode struct {
	ID string `json:"id"`
	PresencePoint
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type CanvasPresence struct {
	ID        string         `json:"id"`
	Number    int            `json:"number"`
	Cursor    *PresencePoint `json:"cursor"`
	Drag      []PresenceNode `json:"drag"`
	UpdatedAt int64          `json:"updatedAt"`
}

type RealtimeEvent struct {
	Type   string          `json:"type"`
	Peer   *CanvasPresence `json:"peer,omitempty"`
	PeerID string          `json:"peerId,omitempty"`
}

type realtimeEnvelope struct {
	RealtimeEvent
	Source string `json:"source"`
}

// Presence is ephemeral; cursor and drag messages never enter the database.
type RealtimeHub struct {
	mu    sync.Mutex
	rooms map[string]map[string]*RealtimeSession
	redis *redis.Client
	id    string
}

type RealtimeSession struct {
	hub    *RealtimeHub
	room   string
	peer   CanvasPresence
	mu     sync.Mutex
	Events chan RealtimeEvent
	ctx    context.Context
	cancel context.CancelFunc
	pubsub *redis.PubSub
	once   sync.Once
}

func NewRealtimeHub(client *redis.Client) *RealtimeHub {
	return &RealtimeHub{rooms: make(map[string]map[string]*RealtimeSession), redis: client, id: kernel.NewID()}
}

func realtimeRoom(userID, canvasID string) string {
	return "canvas:realtime:v1:" + base64.RawURLEncoding.EncodeToString([]byte(userID)) + ":" + base64.RawURLEncoding.EncodeToString([]byte(canvasID))
}

func (h *RealtimeHub) Open(ctx context.Context, userID, canvasID string) (*RealtimeSession, []CanvasPresence, error) {
	ctx, cancel := context.WithCancel(ctx)
	s := &RealtimeSession{hub: h, room: realtimeRoom(userID, canvasID), peer: CanvasPresence{ID: kernel.NewID(), UpdatedAt: time.Now().UnixMilli()}, Events: make(chan RealtimeEvent, 128), ctx: ctx, cancel: cancel}
	if h.redis != nil {
		s.pubsub = h.redis.Subscribe(ctx, s.room)
		ready, stop := context.WithTimeout(ctx, 3*time.Second)
		_, err := s.pubsub.Receive(ready)
		stop()
		if err != nil {
			cancel()
			_ = s.pubsub.Close()
			return nil, nil, err
		}
		if err := s.claimDeviceNumber(); err != nil {
			cancel()
			_ = s.pubsub.Close()
			return nil, nil, err
		}
	}
	h.mu.Lock()
	if len(h.rooms[s.room]) >= 64 {
		h.mu.Unlock()
		cancel()
		if s.pubsub != nil {
			_ = s.pubsub.Close()
			s.releaseDeviceNumber()
		}
		return nil, nil, errors.New("此画布打开的窗口过多")
	}
	if h.rooms[s.room] == nil {
		h.rooms[s.room] = make(map[string]*RealtimeSession)
	}
	peers := make([]CanvasPresence, 0, len(h.rooms[s.room])+1)
	used := make(map[int]bool)
	for _, existing := range h.rooms[s.room] {
		peer := existing.Snapshot()
		peers = append(peers, peer)
		used[peer.Number] = true
	}
	if h.redis == nil {
		s.peer.Number = 1
		for used[s.peer.Number] {
			s.peer.Number++
		}
	}
	h.rooms[s.room][s.peer.ID] = s
	peers = append(peers, s.Snapshot())
	h.mu.Unlock()
	if s.pubsub != nil {
		go s.receive()
	}
	peer := s.Snapshot()
	h.publish(s.room, RealtimeEvent{Type: "peer", Peer: &peer})
	// Other instances answer with their participants, including idle cursors.
	h.publish(s.room, RealtimeEvent{Type: "hello", PeerID: peer.ID})
	return s, peers, nil
}

func (h *RealtimeHub) Changed(userID, canvasID string) {
	h.publish(realtimeRoom(userID, canvasID), RealtimeEvent{Type: "invalidate"})
}

func (h *RealtimeHub) deliver(room string, event RealtimeEvent) {
	if event.Type == "hello" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, session := range h.rooms[room] {
		select {
		case session.Events <- event:
		default:
			session.cancel() // Slow consumers reconnect and read a fresh snapshot.
		}
	}
}

func (h *RealtimeHub) publish(room string, event RealtimeEvent) {
	h.deliver(room, event)
	if h.redis == nil {
		return
	}
	data, err := json.Marshal(realtimeEnvelope{RealtimeEvent: event, Source: h.id})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := h.redis.Publish(ctx, room, data).Err(); err != nil {
		slog.Warn("画布实时通知发送失败，客户端将通过状态校验恢复", "error", err)
	}
}

func (s *RealtimeSession) receive() {
	for {
		message, err := s.pubsub.ReceiveMessage(s.ctx)
		if err != nil {
			s.cancel()
			return
		}
		var event realtimeEnvelope
		if json.Unmarshal([]byte(message.Payload), &event) != nil || event.Source == s.hub.id {
			continue
		}
		if event.Type == "hello" {
			peer := s.Snapshot()
			s.hub.publish(s.room, RealtimeEvent{Type: "peer", Peer: &peer})
			continue
		}
		select {
		case s.Events <- event.RealtimeEvent:
		case <-s.ctx.Done():
			return
		default:
			s.cancel()
			return
		}
	}
}

func (s *RealtimeSession) ID() string               { return s.peer.ID }
func (s *RealtimeSession) Done() <-chan struct{}    { return s.ctx.Done() }
func (s *RealtimeSession) Snapshot() CanvasPresence { s.mu.Lock(); defer s.mu.Unlock(); return s.peer }

func validPresenceNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= 1e8
}

func (s *RealtimeSession) Update(cursor *PresencePoint, drag []PresenceNode) error {
	if cursor != nil && (!validPresenceNumber(cursor.X) || !validPresenceNumber(cursor.Y)) {
		return errors.New("光标坐标无效")
	}
	if len(drag) > 100 {
		return errors.New("拖拽预览节点过多")
	}
	seen := make(map[string]bool, len(drag))
	for _, node := range drag {
		if node.ID == "" || len(node.ID) > 160 || seen[node.ID] || !validPresenceNumber(node.X) || !validPresenceNumber(node.Y) || !validPresenceNumber(node.Width) || !validPresenceNumber(node.Height) || node.Width <= 0 || node.Height <= 0 {
			return errors.New("拖拽预览无效")
		}
		seen[node.ID] = true
	}
	s.mu.Lock()
	s.peer.Cursor, s.peer.Drag, s.peer.UpdatedAt = cursor, drag, time.Now().UnixMilli()
	peer := s.peer
	s.mu.Unlock()
	s.hub.publish(s.room, RealtimeEvent{Type: "peer", Peer: &peer})
	return nil
}

func (s *RealtimeSession) Heartbeat() {
	if !s.renewDeviceNumber() {
		s.cancel()
		return
	}
	s.mu.Lock()
	s.peer.UpdatedAt = time.Now().UnixMilli()
	peer := s.peer
	s.mu.Unlock()
	s.hub.publish(s.room, RealtimeEvent{Type: "peer", Peer: &peer})
}

func (s *RealtimeSession) Close() {
	s.once.Do(func() {
		s.cancel()
		if s.pubsub != nil {
			_ = s.pubsub.Close()
			s.releaseDeviceNumber()
		}
		s.hub.mu.Lock()
		delete(s.hub.rooms[s.room], s.peer.ID)
		if len(s.hub.rooms[s.room]) == 0 {
			delete(s.hub.rooms, s.room)
		}
		s.hub.mu.Unlock()
		s.hub.publish(s.room, RealtimeEvent{Type: "leave", PeerID: s.peer.ID})
	})
}
