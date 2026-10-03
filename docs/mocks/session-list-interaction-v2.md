# Session 列表交互设计 v2

设计图：[session-list-interaction-v2.png](session-list-interaction-v2.png)

状态：历史设计提案，尚未实现。操作入口方案取代 v1；完整菜单集合及产品判断以 [v3](session-list-interaction-v3.md) 为准。

## 用户确认的调整

- 行内仅保留常驻的「⋯」入口；默认、悬停、聚焦和菜单展开时均不独立展示「完成」。
- 更多菜单依次为「完成」、分隔线、「取消置顶」、「移动到…」。
- 「完成」右侧显示现有快捷键：macOS 为 ⌘D，Windows / Linux 为 Ctrl+D（落地标签可沿用项目的 Ctrl D 格式）。
- 移除 v1 为外部完成按钮预留的空白，右侧只保留时间和更多入口所需的窄列；标题及摘要在操作列之前省略，悬停仅改变按钮样式。
- 保留浅蓝选中背景、小图钉置顶标识、菜单文字标签及清晰独立的按钮热区。
- 菜单外点击、Escape 关闭菜单，行内点击打开会话，菜单操作不触发行导航。
- 「完成」仍遵循现有 canComplete 限制及完成后撤销行为。图中取消置顶后的撤销仍是 v1 的反馈提案，未实现。

## 快捷键核对

现有绑定位于 src/web/src/components/WorkspaceView.tsx:5396，接受 Command / Ctrl + D，不带 Shift / Alt；输入框聚焦时也生效。
可用条件见 src/web/src/lib/sessionCapabilities.ts:48：当前会话详情存在、lifecycleState 为 OPEN 且 canComplete 可用。
当前快捷键作用于选中/打开的会话，设计图展示的正是选中行菜单。后续实现应仅在菜单目标与快捷键目标一致时显示提示，避免未选中行的菜单误导操作对象。
平台显示惯例见 WorkspaceView.tsx:582 的 IS_MAC 及 NEW_SESSION_HINT。

## 生成记录

使用内置 image_gen 工具编辑 v1 设计图；保留 v1 与原始生成文件。
原始 v2：
/root/.codex/generated_images/01a10261-5d51-7a21-b65d-af0ed2cc3d16/exec-0de5772f-96b0-420e-9329-32a869be78d7.png

### 最终提示词

```text
Use case: ui-mockup
Asset type: high-fidelity desktop Session list interaction design board revision.
Input image: Image 1 is the EXISTING v1 DESIGN BOARD TO EDIT. Preserve its layout, visual identity, exact session titles, green and purple tags, pale blue selection, neutral white panels, hierarchy and overall quality. This is a targeted interaction revision, not a new visual direction.
User requirements: "完成不需要独立展示在外部了" and "但是在菜单里可以展示完成的快捷键". Move Complete entirely inside the ellipsis menu and show its actual existing macOS shortcut ⌘D next to its menu label. The row must have exactly ONE action button, the ellipsis ⋯, in every state including hover, keyboard focus and menu open. NO standalone Complete button anywhere.
Edit instructions:
1. Keep the main left list and its four session rows. On all rows the compact right column contains a timestamp above and the sole ellipsis button below. Remove the invisible space reservation for the former completion button, giving the subtitle more usable width while leaving a stable narrow ellipsis column.
2. In the upper-right panel titled "02 悬停 / 键盘聚焦", remove the existing external outlined "✓ 完成" button completely. The sole ellipsis button has a subtle hover background, with the cursor on this ellipsis button. Extend the visible gray preview text into the reclaimed space, ending in a clean ellipsis before the sole button; never underneath it. Keep "Upgrade from main branch", the small gray pin icon, green "项目部署" and "+1". Replace both callout lines with exact text:
"行内只保留更多入口"
"悬停仅高亮按钮，文字与布局不变"
3. In the lower-right panel titled "03 更多操作", also REMOVE the standalone "✓ 完成" button completely. Only a highlighted ellipsis remains at the right of the selected row. The white dropdown is anchored below the ellipsis. Make this menu slightly taller as needed and avoid overlap with the explanatory text. The menu must contain exactly three entries with generous 38px-equivalent heights:
- FIRST ENTRY: a simple check icon at left, Chinese label "完成", and RIGHT-ALIGNED muted keyboard shortcut "⌘D". Render the command symbol accurately. The shortcut is quiet secondary text, not a button, not a large pill.
- Thin subtle divider.
- SECOND ENTRY: pin icon and "取消置顶".
- THIRD ENTRY: folder outline icon and "移动到…".
The label and shortcut belong to the SAME FIRST MENU ROW. No delete, share, settings, duplicate completion action or other extra entries.
Under the dropdown, a concise note: "完成收进菜单，快捷键显示在右侧".
A second small muted note: "macOS：⌘D · Windows / Linux：Ctrl+D".
4. Main title remains "Session 列表 · 交互优化". Change subtitle to "统一操作入口，保留快捷键提示".
5. Preserve bottom-left callouts about blue selection versus pin state, stable text layout, and always-visible more entrance. Preserve the small operation feedback example at bottom right. You may move the feedback panel down or slightly enlarge the overall canvas vertically to accommodate the taller dropdown and notes without overlap. Maintain balanced spacing.
Constraints: exact readable Chinese and English text, crisp desktop UI, no giant tooltip, no decorative art, no watermark, no extra icon buttons in any row. Preserve the existing design except for these required edits. The sole location where the action label "完成" is shown is inside the expanded menu (plus the explanatory sentence).
```
