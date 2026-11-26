---
title: 会话停止：账户额度用尽
summary: 5 小时和每周限制意味着什么，以及会话如何自行恢复。
---

订阅有使用窗口。会话使用的账户用完了它的份额时，回合会停止，会话显示一张卡片，例如 **5-hour limit reached**、**Weekly limit reached** 或 **Usage limit reached**。会话本身没问题：什么都不会丢失。

## 卡片告诉你什么

- 这是谁的额度：例如 "The 5-hour quota for Claude on "build-box" is used up."
- 什么时候恢复：**Resets 19:20 · in 2 h 14 min**。
- **Auto-retry when the quota resets**。打开时，卡片会说 "Runs on the server — you can close this tab." 重置后回合会自动再次发送。

## 你可以做什么

1. **等待。** 打开自动重试后，什么都不用做。
2. 如果你确定限制已解除，选 **Retry now anyway**。在重置之前它很可能再次失败，卡片也会这样说明。
3. **换一个账户。** 用另一个密钥或订阅开始新工作，或设置一个 [账户池](orbit:/help/models-keys-and-accounts/account-pools)，让会话从还有额度的账户开始。

如果卡片显示 **Auto-retry gave up**（"Tried 3 times — the quota still reports as spent. Over to you."），供应商仍报告额度已用尽。在供应商网站上检查你的方案，然后按 **Retry now**。

## 供应商错误

**Provider unavailable** 是另一张卡片：供应商的 API 失败，而不是你的额度。它也会以同样方式重试。

完整指南：[Onboarding, step 7](../../../onboarding.md#7-recovery-when-a-run-stops)。
