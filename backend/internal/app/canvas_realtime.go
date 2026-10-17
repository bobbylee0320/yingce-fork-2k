package app

import (
	"context"
	"errors"
	"gorm.io/gorm"
	"net/http"

	"yingce/backend/internal/canvas"
	"yingce/backend/internal/kernel"
)

type CanvasRealtimeSession = canvas.RealtimeSession
type CanvasPresence = canvas.CanvasPresence
type CanvasPresencePoint = canvas.PresencePoint
type CanvasPresenceNode = canvas.PresenceNode

func (s *Service) OpenCanvasRealtime(ctx context.Context, userID, canvasID string) (*CanvasRealtimeSession, []CanvasPresence, error) {
	if _, err := s.UserCanvasProjectMetadata(userID, canvasID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, kernel.NotFound("画布不存在或无权访问")
		}
		return nil, nil, err
	}
	if s.canvasRealtime == nil {
		return nil, nil, kernel.NewAppError(http.StatusServiceUnavailable, "画布实时服务尚未就绪")
	}
	session, peers, err := s.canvasRealtime.Open(ctx, userID, canvasID)
	if err != nil {
		return nil, nil, kernel.NewAppError(http.StatusServiceUnavailable, "画布实时连接暂不可用，请稍后重试")
	}
	return session, peers, nil
}
