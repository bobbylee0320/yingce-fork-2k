# MINIMAXH3 全模态视频

协议 ID：`minimaxh3-video`。内置于官方插件目录，供系统渠道、自定义渠道、画布、创作页和 Agent 使用。

默认地址：`https://dnyovzpgyokm.sealosbja.site`，鉴权为 `Authorization: Bearer <apiKey>`。在渠道设置中选择「MINIMAXH3 全模态视频」，填写密钥，并使用上游 `/v1/models` 返回的模型 ID；时长、分辨率、素材数量按该模型 caps 配置。

支持文本、首尾帧、多帧，以及图片、视频、音频混合参考。全模态提示词使用 `@素材名称`；素材名称取画布传入的 name，无名称时分别使用 `image_file_1`、`video_file_1`、`audio_file_1` 等，从 1 编号。

成功后通过带鉴权的 `/v1/tasks/{id}/download?index=0` 下载并保存。该端点优先返回高清原片，避免将预览或带水印的视频误存为原片。

文档来源：[MINIMAXH3 API 文档](https://dnyovzpgyokm.sealosbja.site/)。本插件不包含任何密钥，不默认开启过脸处理。
