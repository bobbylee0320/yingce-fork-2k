package handler

import (
	"net/http"
	"strconv"

	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

// dramaRoute 统一短剧接口的鉴权、请求体上限和响应封装；业务校验与归属检查全部在 service 内完成。
func dramaRoute(svc *service.Service, bodyLimit int64, fn func(c *gin.Context, userID string) (any, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if bodyLimit > 0 {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, bodyLimit)
		}
		data, err := fn(c, user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, data)
	}
}

func bindDramaJSON(c *gin.Context, target any) error {
	if err := c.ShouldBindJSON(target); err != nil {
		return service.BadAuthRequest("请求格式错误")
	}
	return nil
}

func registerDramaRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/dramas", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		page, err := parsePositiveQueryInt(c.Query("page"), 1)
		if err != nil {
			return nil, service.BadAuthRequest("页码无效")
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 24)
		if err != nil || pageSize > 100 {
			return nil, service.BadAuthRequest("每页数量无效")
		}
		return svc.ListDramas(userID, service.DramaListRequest{Page: page, PageSize: pageSize, Query: c.Query("q"), Status: c.Query("status")})
	}))
	r.GET("/dramas/asset-schemes", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaAssetSchemes(), nil
	}))
	r.GET("/dramas/models", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaModelCatalog()
	}))
	r.POST("/dramas/estimate", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaEstimateRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.EstimateDrama(req)
	}))
	// 小说正文随创建请求一次提交；600 万字 UTF-8 约 18MB，留出 JSON 转义余量。
	r.POST("/dramas", dramaRoute(svc, 32<<20, func(c *gin.Context, userID string) (any, error) {
		var req service.CreateDramaRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.CreateDrama(userID, req)
	}))
	r.DELETE("/dramas/:id", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return gin.H{"deleted": true}, svc.DeleteDrama(userID, c.Param("id"))
	}))
	r.GET("/dramas/:id", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaSummary(userID, c.Param("id"))
	}))
	r.PATCH("/dramas/:id/settings", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.UpdateDramaSettingsRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.UpdateDramaSettings(userID, c.Param("id"), req)
	}))
	r.POST("/dramas/:id/start", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.SetDramaRunning(userID, c.Param("id"), true)
	}))
	r.POST("/dramas/:id/pause", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.SetDramaRunning(userID, c.Param("id"), false)
	}))
	r.POST("/dramas/:id/retry-failed", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.RetryFailedDrama(userID, c.Param("id"))
	}))
	r.GET("/dramas/:id/jobs", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		limit, err := parsePositiveQueryInt(c.Query("limit"), 60)
		if err != nil {
			return nil, service.BadAuthRequest("数量无效")
		}
		jobs, err := svc.DramaJobs(userID, c.Param("id"), limit)
		return gin.H{"jobs": jobs}, err
	}))
	r.POST("/dramas/:id/media/release", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.ReleaseDramaMediaRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ReleaseDramaMedia(userID, c.Param("id"), req)
	}))
	r.GET("/dramas/:id/jobs/:jobId", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaJobDetail(userID, c.Param("id"), c.Param("jobId"))
	}))
	r.POST("/dramas/:id/cast/regenerate-all", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.RegenerateDramaCastsRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.RegenerateDramaCasts(userID, c.Param("id"), req)
	}))
	r.GET("/dramas/:id/chapters/:chapterId", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		chapter, err := svc.DramaChapter(userID, c.Param("id"), c.Param("chapterId"))
		return gin.H{"chapter": chapter}, err
	}))
	r.GET("/dramas/:id/episodes/:episodeId", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaEpisodeDetail(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.PATCH("/dramas/:id/episodes/:episodeId", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req struct {
			Title string `json:"title"`
		}
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		episode, err := svc.UpdateDramaEpisodeTitle(userID, c.Param("id"), c.Param("episodeId"), req.Title)
		return gin.H{"episode": episode}, err
	}))
	r.POST("/dramas/:id/episodes/:episodeId/approve", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.ApproveDramaEpisode(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.POST("/dramas/:id/episodes/:episodeId/rescript", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.RescriptDramaEpisode(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.POST("/dramas/:id/episodes/:episodeId/segments/generate", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.GenerateDramaSegmentsRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.GenerateDramaSegments(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
	r.POST("/dramas/:id/episodes/:episodeId/segments/prompts", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.GenerateDramaSegmentsRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.RequestDramaSegmentPrompts(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
	r.POST("/dramas/:id/episodes/:episodeId/segments/:index/reprocess", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		index, err := strconv.Atoi(c.Param("index"))
		if err != nil || index < 0 {
			return nil, service.BadAuthRequest("剧情段序号无效")
		}
		return svc.ReprocessDramaSegmentVideo(userID, c.Param("id"), c.Param("episodeId"), index)
	}))
	r.PATCH("/dramas/:id/episodes/:episodeId/segments/:index", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		index, err := strconv.Atoi(c.Param("index"))
		if err != nil || index < 0 {
			return nil, service.BadAuthRequest("剧情段序号无效")
		}
		var req service.UpdateDramaSegmentRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return gin.H{"saved": true}, svc.UpdateDramaSegment(userID, c.Param("id"), c.Param("episodeId"), index, req)
	}))
	r.PATCH("/dramas/:id/shots/:shotId", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.UpdateDramaShotRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		shot, err := svc.UpdateDramaShot(userID, c.Param("id"), c.Param("shotId"), req)
		return gin.H{"shot": shot}, err
	}))
	r.GET("/dramas/:id/cast", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		casts, err := svc.DramaCasts(userID, c.Param("id"))
		return gin.H{"cast": casts}, err
	}))
	r.PATCH("/dramas/:id/cast/:castId", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.UpdateDramaCastRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		cast, err := svc.UpdateDramaCast(userID, c.Param("id"), c.Param("castId"), req)
		return gin.H{"cast": cast}, err
	}))
	r.GET("/dramas/:id/cast/:castId/impact", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaCastImpact(userID, c.Param("id"), c.Param("castId"))
	}))
	r.POST("/dramas/:id/cast/:castId/regenerate", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req struct {
			RestyleSegments bool `json:"restyleSegments"`
		}
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.RegenerateDramaCast(userID, c.Param("id"), c.Param("castId"), req.RestyleSegments)
	}))
}
