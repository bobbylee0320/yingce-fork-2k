package handler

import (
	"net/http"

	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterStorageGrantRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/resources/storage-grants", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		grants, err := svc.UserStorageGrants(user)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"grants": grants})
	})
	r.GET("/admin/users/:id/storage", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		storage, err := svc.AdminUserStorage(user, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, storage)
	})
	r.POST("/admin/users/:id/storage-grants", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var req service.AdminStorageGrantRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		grant, err := svc.AdminGrantUserStorage(user, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"grant": grant})
	})
	r.POST("/admin/storage-grants/:id/revoke", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var req service.RevokeStorageGrantRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		grant, err := svc.AdminRevokeUserStorageGrant(user, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"grant": grant})
	})
}
