---
title: Wiki 是什么
summary: Agent 对代码库的了解被写下来，让下一次会话一开始就知道。
---

[Wiki](orbit:/wiki) 是你的 Agent 对某个代码库的了解：约定、决定、陷阱、做法，以及代码背后的概念。会话在改文件之前会先读它，所以一个 Agent 学到的教训不必再学一遍。

## 空间

一个空间是一个代码库。第一次有会话针对该代码库提出内容时，会创建第一个空间。用顶部的选择器切换空间；选择器的提示是“The codebase this wiki describes”。

## 空间里有什么

- **条目**：简短的事实，每条属于一种类型，例如陷阱（“这个测试在负载下会偶发失败”）或约定（“迁移按日期编号”）。许多条目锚定到文件，Orbit 会在代码变化时检查这些锚点是否仍然成立。
- **页面**：按主题分组的较长文档。
- **活动**：最近改了什么，以及等待审阅的提议。

用 **Search the wiki**（⌘K）按文字或文件路径查找任何内容。

## 它如何变化

会话在工作时会提议新的条目和改动。取决于空间的审阅模式，提议会立即应用，或在 **Review** 里等你。参见 [审阅提议](orbit:/help/wiki/review-proposals)。你也可以通过与页面对话来自己修改：参见 [在 Wiki 页面上对话](orbit:/help/wiki/chat-on-a-wiki-page)。

完整指南：[Self-hosting: Wiki System model](../../self-hosting.md#wiki-system-model)。
