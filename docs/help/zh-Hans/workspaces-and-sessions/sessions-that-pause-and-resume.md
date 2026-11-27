---
title: 会暂停和恢复的会话
summary: 机器离线或账户额度用尽时，会话会等待而不是失败，之后会接着运行。
---

无法继续的运行不会变成丢失的会话。Orbit 保留对话，记录停止的原因，而且常常会自动恢复它。

## 你可能会看到

| 你看到 | 含义 | 怎么做 |
| --- | --- | --- |
| **The assigned runner is offline. This session starts when it comes back.** | 会话已排队到一台未连接的机器。 | 让机器恢复连接。参见 [机器显示为离线](orbit:/help/machines-and-engines/machine-offline)。 |
| 输入框里的 **Runner offline**，或页头里的 **Disconnected** | 运行过程中机器掉线了。 | 同上。机器恢复后，它持有的工作会被重新发出。 |
| **5-hour limit reached**、**Weekly limit reached** 或 **Usage limit reached** | 会话使用的账户额度用尽。 | 保持 **Auto-retry when the quota resets** 开启。参见 [会话停止：账户额度用尽](orbit:/help/models-keys-and-accounts/account-out-of-quota)。 |
| **Idle**，出现在设了 watch 或定时唤醒的会话上 | 会话停在一个会唤醒它的东西上。它和其他处于两轮之间的会话一样显示 Idle。 | 什么都不用做。它会自行继续。 |
| **Running in background** | 后台作业仍在运行。 | 什么都不用做。作业结束时 Agent 会被唤醒。 |

## 手动恢复

- 在额度卡片上，**Retry now** 会重新发送这个回合。自动重试已启用时，按钮显示 **Retry now anyway**：当你确定限制已解除时使用它。
- 在任何等待你回复的会话中，新消息会带着上下文继续它。

## 在回收站里时

移到回收站的会话会保留 30 天。打开它并按 **Restore to Open**。

完整指南：[Onboarding, step 7](../../../onboarding.md#7-recovery-when-a-run-stops)。
