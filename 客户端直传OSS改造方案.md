# 影策画布：客户端直传 OSS 改造方案

## 目标

AI 图片和视频生成完成后，由浏览器直接把上游结果传到雨云 OSS。Backend 只负责签名、权限、对象校验、资源登记和任务状态，不再搬运媒体正文。

本地开发不配置真实 OSS，不复制生产密钥。生产部署前保留现有数据库、数据卷、检查点、`.settings-key`、暂存文件和回滚镜像。

## 当前问题

当前链路：

```text
AI 上游 URL
→ Backend 下载
→ media-staging
→ Backend 上传 OSS
→ PostgreSQL 登记资源
```

雨云上游结果 URL 约 10 分钟后失效。Backend 排队、下载、重试或 OSS 上传耗时过长时，恢复阶段可能再次访问已经失效的 URL，任务停在“生成成功 · 下载待完成”。

当前生产已确认：

- Bucket：`yingce-cn2-nb`
- Endpoint：`https://cn-nb1.rains3.com`
- Region：`cn-nb1`
- Bucket 为私有；不要开启公共读写。
- 雨云 S3 Endpoint 的浏览器预检已返回通配 CORS：允许来源、方法和请求头，并暴露 `ETag`。
- 雨云 `PutBucketCors` API 返回不支持，因此不依赖控制台或 S3 API 写入 CORS。

## 目标链路

```text
AI 生成完成
→ Backend 创建 pending Resource 和上传意图
→ 浏览器立即取得上游 URL
→ 浏览器直传 OSS
→ 浏览器通知 Backend 完成
→ Backend HEAD 校验对象
→ PostgreSQL 登记 Resource、完成任务和画布
```

Backend 不再执行生成结果的下载和 OSS 上传。Backend 仍负责权限、签名、配额、幂等、对象大小/MIME/ETag 校验以及数据库写入。

## 后端改动

优先复用现有 `resource_direct_upload.go`，不要另起一套上传系统。

### 新增或扩展接口

```text
POST /api/tasks/:id/media-upload-intent
POST /api/resources/:id/direct-upload/complete
POST /api/resources/:id/direct-upload/abort
```

上传意图返回：

- `taskId`
- `resourceId`
- 上游结果 URL
- OSS 对象键
- 签名 PUT 地址或 multipart 信息
- MIME、大小、过期时间
- 必须带上的请求头

完成接口必须：

1. 校验当前用户、任务和资源归属；
2. 通过 `HEAD` 或 multipart 完成信息确认对象存在；
3. 校验文件大小、`Content-Type`、ETag；
4. 幂等处理重复 complete；
5. 成功后登记资源、消费配额、写入任务结果；
6. 失败时保留 pending/failed 状态，不产生错误 ready 资源。

### 任务状态

新增或复用以下阶段：

```text
client_upload_pending
client_uploading
register
completed
```

旧的 `download`、`upload`、`media-staging` 恢复逻辑继续保留，用于历史检查点和管理员应急处理，但新任务默认不再走 Backend 搬运媒体正文。

检查点必须继续兼容旧格式。上游 URL 只能放在加密检查点或短期响应中，不能写入公开任务结果、普通日志或画布内容。

## 前端改动

当任务进入 `client_upload_pending`：

1. 请求上传意图；
2. 立即读取上游 URL；
3. 图片使用单 PUT；
4. 视频使用 S3 multipart 分片上传；
5. 展示实际上传进度；
6. 失败时只重签名、重传，不重新生成；
7. 上传完成后调用 complete；
8. 使用返回的 `resourceId` 更新任务和画布。

图片建议支持 2–8 MB，视频支持 20–50 MB 动态范围。视频分片大小、并发和重试次数应可配置，不能把所有视频一次性读入内存。

页面刷新后可以恢复尚未完成的上传，但上游 URL 有效期约 10 分钟，不能无限等待。URL 过期时应明确显示“上游结果已过期”，不能重新生成 AI 作品。

## OSS 要求

- 保持当前 Endpoint、Region、Bucket、Path Style 和密钥不变。
- Bucket 保持私有，禁止匿名写入。
- 保留对象前缀隔离，例如 `open-ai-canvas/`。
- 保持 `PUT`、`GET`、`HEAD`、multipart 所需操作可用。
- 为未完成 multipart 设置生命周期清理，建议 1 天。
- 不自动删除已完成对象。
- 不在前端保存 Access Key 或 Secret Key。

## 本地验证

本地不连接生产 OSS，使用模拟 S3/HTTP 服务验证：

- 图片 2–8 MB 单 PUT；
- 视频 20–50 MB multipart；
- CORS 预检；
- 上传进度和超时；
- URL 接近 10 分钟过期时立即传输；
- 断网、刷新、重复 complete；
- 对象已存在时不重复上传和登记；
- 错误对象不能被登记为 ready；
- 不调用真实 AI 生成接口。

后端执行专项 Go 测试，前端执行类型检查和构建。完整 app 测试超时不得通过修改无关功能解决。

## 生产发布步骤

1. 备份 PostgreSQL、Backend 数据卷、`.settings-key` 和 `media-staging`；
2. 确认现有生产镜像、回滚镜像和 Compose 配置可用；
3. 构建 Backend 和 Web 新镜像；
4. 保留 PostgreSQL、Redis、Agent、Tunnel、数据卷和生产 OSS 配置；
5. 先关闭客户端直传开关部署；
6. 健康检查、读取旧检查点并验证数据库结构；
7. 只对一个内部测试账号或一个已有生成结果启用；
8. 验证图片、视频、对象 HEAD、资源登记和画布回写；
9. 逐步开启正式流量；
10. 监控 `client_upload`、`register`、OSS 错误码、孤儿 multipart 和重复资源。

禁止：清空数据库、删除暂存文件、重建数据卷、修改生产密钥、批量重新生成 AI 作品、一次性批量恢复全部失败任务、执行 `docker compose down -v` 或 Docker 全局清理。

## 回滚

优先关闭客户端直传开关，恢复旧 Backend/Web 镜像。保留新产生的 pending 对象和资源记录，先按任务状态核对后再处理；不直接删除数据库、OSS 对象或暂存文件。

如果新版本读取旧检查点失败，立即停止恢复，回滚 Backend，不修改检查点内容。

## 验收标准

- 新图片/视频任务的媒体正文不经过 Backend 网络和 OSS 上传；
- 任务最终为 `completed`，资源为 `ready`；
- 对象大小、MIME、ETag 校验通过；
- 重复 complete 不重复登记；
- 浏览器刷新后可继续有效期内的上传；
- 上游 URL 过期时有明确失败状态，不重复生成；
- 历史失败检查点仍可按旧机制读取；
- VPS 可回滚，生产数据库、数据卷、密钥和已有媒体不受影响。
