# Volcengine AI MediaKit

该目录是火山引擎 AI MediaKit 媒体处理工具的官方声明式插件源码。后端从生成的 `volcengine-mediakit.yingce-plugin` 包加载，不依赖系统内置 `host:` 适配器。

所有 provider 声明 `kind: "processing"`：以输入媒体为主体，不要求提示词，不出现在生成模型列表，只出现在画布节点的处理工具里。

| Provider | 能力 | 画布入口 |
| --- | --- | --- |
| `volcengine-mediakit-enhance-video` | video | 视频节点「画质增强」 |

完整接口见 [docs/interface.md](docs/interface.md)。
