# bobby异步视频插件

系统级视频生成协议插件，安装于画布后台「插件管理」，由管理员统一启用。

插件按 `https://newapi.bobby707.xyz/docs` 的平台统一 API 调用文档实现：JSON `POST /v1/videos` 创建异步任务，`GET /v1/videos/{id}` 查询公开任务状态，`GET /v1/videos/{id}/content` 使用 Bearer Key 下载视频二进制。创建字段和素材映射遵循文档的 `seconds`、`resolution`、`aspect_ratio`、`input_reference` 与 `reference_*` 定义。

插件不包含 API Key。安装后请在系统渠道配置中填写本站服务根地址、本站颁发的令牌、有效模型标识及计费信息。素材 URL 必须可由上游服务器访问。
