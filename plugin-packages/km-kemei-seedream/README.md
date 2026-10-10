# KM 可美 Seedream 5.0

`yingce.plugin/v2` 声明式图片协议包。使用渠道凭证，宿主统一负责 HTTPS、SSRF 校验、超时与媒体持久化；不包含脚本运行时或密钥。

适配精确模型 ID：`doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915`。

选择协议时“能力与参数”默认设为：2K / 1:1（2048x2048）、单张生成、最多 10 张参考图、单图 30 MB、关闭蒙版、关闭通用 quality 和透明背景开关。1K / 1.5K / 2K 各有八种官方精确尺寸。响应默认 URL、输出 JPEG、关闭水印；所有返回图片及用量交给宿主消费。

详情见 [接口说明](docs/interface.md)。
