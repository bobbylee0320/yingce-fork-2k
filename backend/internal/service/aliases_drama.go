package service

import "yingce/backend/internal/app"

type (
	CreateDramaRequest           = app.CreateDramaRequest
	UpdateDramaSettingsRequest   = app.UpdateDramaSettingsRequest
	UpdateDramaShotRequest       = app.UpdateDramaShotRequest
	UpdateDramaSegmentRequest    = app.UpdateDramaSegmentRequest
	DramaSegmentView             = app.DramaSegmentView
	UpdateDramaCastRequest       = app.UpdateDramaCastRequest
	DramaEstimateRequest         = app.DramaEstimateRequest
	GenerateDramaSegmentsRequest = app.GenerateDramaSegmentsRequest
	DramaListRequest             = app.DramaListRequest
	RegenerateDramaCastsRequest  = app.RegenerateDramaCastsRequest
	ReleaseDramaMediaRequest     = app.ReleaseDramaMediaRequest
)
