---
title: API 密钥
summary: 添加一次供应商的 API 密钥，就能从每台机器使用，按 token 计费。
---

API 密钥让会话使用模型供应商的 API，并按 token 付费。密钥保存在你的 Orbit 账户上，所以你每台机器都能使用；不需要把密钥复制到每台机器。

## 添加密钥

1. 打开 **Settings**。在 **Providers** 下按 **Connect a provider**（**+** 按钮），或打开 **API keys** 并按 **Add key**。
2. 在 **Add a provider** 上选择供应商：**Anthropic**、**OpenAI**、**Google Gemini**、**DeepSeek**、**Moonshot (Kimi)**、**Z.AI (GLM)**、**MiniMax**、**Qwen**，或者用 **Custom** 连接你自己运行的任何兼容端点。
3. 粘贴密钥并按 **Connect**。Orbit 会先向供应商验证密钥。每个密钥只有你能看到。

[打开 API 密钥](orbit:/settings/providers)

## 使用

启动会话时，在输入框的 **Provider** 菜单中选择密钥，它就在引擎和模型旁边。密钥适用于使用其供应商 API 的引擎，例如 Anthropic 密钥用于 Claude Code。

## 密钥还是订阅？

- **API 密钥**：由供应商按 token 计费，没有使用窗口，每台机器都能使用。
- **订阅**（Claude、ChatGPT）：有使用限制的月度方案，在每台机器上登录。参见 [用订阅登录](orbit:/help/models-keys-and-accounts/sign-in-with-a-subscription)。

同一个引擎的多个密钥或订阅可以在 [账户池](orbit:/help/models-keys-and-accounts/account-pools) 中组合。

## 删除密钥

从 **API keys** 打开密钥进行编辑并按 **Save**，或用 **Delete key** 删除。Orbit 会先询问，并说明有什么在使用这个密钥。

完整指南：[Runner CLI: providers](../../runner-cli.md#providers)。
