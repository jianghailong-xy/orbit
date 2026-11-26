---
title: 审阅提议
summary: 接受、编辑或拒绝会话对 Wiki 的提议，并选择多少内容需要等你。
---

会话在工作时会提议新的 Wiki 条目和改动。需要人的提议会在 [Review](orbit:/wiki/review) 中等待。

## 决定一份提议

每份提议显示条目、它的依据，以及提出它的会话。

- **Accept** 应用它。接受后条目变为 Confirmed。
- **Edit** 让你在应用前修改措辞。
- **Reject** 拒绝它。选择一个原因：**Not true**、**Not useful**、**Duplicate** 或 **Too specific**。原因能帮助以后的会话提出更好的提议。

被某人质疑的条目会改为提供 **Keep**、**Amend…** 或 **Retire…**。

“Nothing is waiting for you.” 表示 Review 是空的。

## 选择多少内容需要等你

打开该空间的 **Wiki settings**（`/wiki/:space/settings`），选择一个 **Review mode**：

- **Manual**：来自会话、维护和导入的每一处改动都会在 Review 里等你。
- **Tiered**（默认）：你自己的话和机器检查过的条目立即应用；其余显示为 Unreviewed，且不会发给 Agent。
- **Automatic**：System 模型先对照来源检查每处改动。有依据的改动会应用，部分有依据的显示为 Unreviewed，其余会被拒绝并给出原因。

使用 Automatic 时，**Spot-check Automatic** 会把它已应用的改动中每 200 条里的 1 条送到 Review，让你看到它放行了什么。

完整指南：[Self-hosting: Wiki System model](../../../self-hosting.md#wiki-system-model)。
