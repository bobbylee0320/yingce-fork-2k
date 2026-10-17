# 服务商目录

`catalog.json` 是准备发布到 ai.yingce.tv 的真实目录；`catalog.example.json` 仅作格式示例。

当前添加秘塔，广告期从添加时起一年（具体时间见 JSON）。卡片按北京时间显示完整起止年份、明确到期日和剩余天数。

长期推广配置：在服务商对象中设置 `"permanent": true`，保留 `startsAt`，可以省略 `endsAt`。此时到达开始时间后持续展示，卡片显示“长期推广 · 无到期日”。定期推广保持 `permanent` 不填或为 `false`，必须设置晚于开始时间的 `endsAt`。秘塔仍按已确认的一年展示，没有自动改为长期。平台 Logo 从 https://metaso.cn 官网左上角内联 SVG 采集，保存在 `logos/metaso.svg`；模型 Logo 使用产品现有的 `minimax` 标识。

秘塔价格按用户确认的每秒计费：480P 0.075 元、768P 0.09 元、1440P（2K）0.18 元。1 元 = 1 积分。

发布时目录结构应为：

```
/srv/yingce-catalog/v1/catalog.json
/srv/yingce-catalog/v1/logos/metaso.svg
```

已部署至服务器，`https://ai.yingce.tv/v1/catalog.json` 与秘塔 Logo 均验证返回 HTTP 200。只更新静态目录与 Caddy 站点，未部署影策主应用。目录拉取总超时为 3 秒，失败后普通读取冷却 30 秒，手动刷新仍立即尝试；刷新接口每次只拉取一次，并发刷新共享同一次请求；已有缓存立即返回，过期时后台刷新，不会被网络请求持锁阻塞。源站（绕过 Cloudflare）HTTPS 校验也已通过；HTTP 自动 308 跳转到 HTTPS。当前能力配置支持 4–30 秒，默认 15 秒，参考图/视频/音频为 9/3/3，支持五种生成方式。注意：模型描述中的“2K 最长 15 秒”尚未在本次目录接入中增加按分辨率的联合校验，不能将描述视为已实现的请求限制。真实 API Key 连通与生成尚未联调。
