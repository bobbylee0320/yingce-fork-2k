# 制作阶段与门禁

完整改编按一条主线推进：

```text
INTAKE
→ SOURCE_READ
→ STORY_ANALYZED
→ SCRIPT_DRAFT
→ SCRIPT_VALIDATED
→ SHOT_BREAKDOWN_DRAFT
→ ASSETS_REVIEW
→ ASSETS_LOCKED
→ STORYBOARD_DRAFT
→ STORYBOARD_VALIDATED
→ BOARDS_READY
→ MEDIA_SUBMITTED
→ DELIVERED
```

`SHOT_BREAKDOWN_DRAFT` 是用于估算镜头和盘点资产的草分镜；资产锁定后，才创建绑定资产引用的制作版分镜。只做文本或剧本的任务在对应阶段结束，不必推进到媒体生成。

## 门禁

- 正文未实际读取，不得声称完成原文分析；用户提供的原文不需要额外的“原文确认”轮。
- 剧本和草分镜必须能追溯到来源版本；事实冲突与未知项单独标记，不擅自补全。
- 核心角色的制作资产须有可读角色卡和已就绪三视图；主要场景、关键服装/道具按镜头需要锁定。声音参考音频可选，不阻塞视频。
- `ASSETS_LOCKED` 前只能维护草分镜；锁定后制作版分镜必须绑定真实资产版本。
- `STORYBOARD_VALIDATED` 前不得生成黑白分镜板；`BOARDS_READY` 前不得进入该工作流的视频生成。
- 媒体生成的能力、预算和用户审批由系统合同处理；创作偏好表单不等于收费授权。
- 上游内容变化时，只将受影响的下游阶段标记为待复核，保留旧版本和仍有效的引用。

## 资产状态

```text
DRAFT → REVIEW → LOCKED
```

每个资产记录真实 ID、版本、来源版本、状态和引用。用户确认或授权按推荐方案采用后才能锁定；角色卡的 `imageReference.ready` 必须为真。启用音频参考时再检查 `audioReference.ready`。用户拒绝或资产更新时保留旧版本，按引用关系复核下游。
