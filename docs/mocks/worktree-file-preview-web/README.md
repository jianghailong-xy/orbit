# Diff 抽屉：二进制文件直接预览 · Web

`01-binary-preview.png`（源文件 `01-binary-preview.html`，帧在 `frames/`）。

起因：在 Web 的 diff 抽屉里点 `docs/mocks/first-workspace-in-conversation/01-web-flow.png`，右侧只有
"Binary file — no preview"。iOS、macOS、Android 在同一个位置早就能看图：它们调
`GET /sessions/:id/worktree-file?path=…`，服务端让会话的 runner 从 worktree 里现读这个文件。

方案：Web 走同一条路。服务端另加一行，让 runner 马上去读（见下面已定 ③）。

- 图片（png、jpg/jpeg、gif、webp、avif、bmp、ico）：打开就读，按右侧宽度缩放，小图不放大，点图进现有的全屏查看器
  （`ui/ImagePreview`）。头部写类型 · 像素尺寸 · 大小，再加一个 Download。
- 其他二进制：显示 "No preview available"，按 Download 才读。
- 已删除的文件：显示 "File deleted"，不发请求。
- 读取失败：用原生客户端的同一套文案（`OrbitKit/App/WorktreeFileFailure.swift`）。404、503、504 可以重试，413 不行。
- ‹ › 翻页把二进制文件也算进去。翻进一个收起的文件夹时，这个文件夹会自动展开。

已定（2026-10-31，按建议实现）：

1. 改动过的图（M）只显示现在的版本。改前 / 改后对比另开任务。
2. ‹ › 包括二进制文件；翻进收起的文件夹时自动展开。
3. 服务端 `getWorktreeFileForOwner` 改调 `notifyRunnerWake`，像 Merge / Commit 那样直接叫醒 runner，
   只走 HTTPS 的 runner 也马上读。

实现时补了一条：窄的右侧区域里（手机，或侧栏拖到最窄），头部换行，不再被截掉。

## 重拍

截图来自真实的 Web 页面：vite 加上仓库自带的 `ui-migration` fixtures，原型在 `capture/prototype.patch`，
这个 patch 能直接打在 HEAD（d6f363a6c）上。要重拍，先在 `/var/tmp/wt-preview-mock` 下准备工具包：

- `today/`、`new/`：各放一份 `git archive HEAD src/web src/shared tsconfig.base.json package.json`。
  `node_modules` 用 `cp -al` 从任何一个 lock 一致的副本复制，再放一份构建好的 `src/shared/dist`。
- 在 `new/` 里打上 `prototype.patch`。
- `capture/` 里的脚本复制到工具包根目录，再放三个字体（Inter、Noto Sans SC、JetBrains Mono）到 `fonts/`。

然后运行：

```
unshare -n ./run-ns.sh /var/tmp/wt-preview-mock/today capture.mjs
unshare -n ./run-ns.sh /var/tmp/wt-preview-mock/new   capture.mjs
python3 -I gen.py <this dir> && node render.mjs <this dir>/01-binary-preview.html
```

图片的字节来自另一个会话画的 first-workspace 板子（`/var/tmp/first-ws-mock/board`）。
