# Session 列表交互设计 v1

设计图：[`session-list-interaction-v1.png`](session-list-interaction-v1.png)

状态：历史设计提案，尚未实现；操作入口方案已由 [v2](session-list-interaction-v2.md) 取代。

## 设计决策

- 保留紧凑的两行结构和浅蓝选中背景。置顶用标题旁的灰色图钉表达，取消重复的蓝色竖条。
- 右侧固定预留操作区域，摘要在区域之前省略。默认常显更多入口；悬停或键盘聚焦时，在预留位置显示「完成」，文字不移动、不被覆盖。
- 「取消置顶 / 移动到…」进入带图标与文字的更多菜单；不新增删除、分享等操作。
- 按钮点击区域各自独立，建议至少 32 × 32px，间隔 8px；避免当前左右扩展的透明命中区重叠。行点击打开会话，操作按钮不触发行导航。
- 菜单打开时保留行的选中样式，点击外部或 Escape 收起；保留键盘操作入口。
- 「完成」沿用当前 canComplete 能力约束和完成后的撤销行为。图中的「取消置顶后撤销」是提议新增的反馈能力，尚未实现。
- 图中文字用于说明设计；实际界面文案继续遵循产品的语言约定。

## 现有问题依据

- src/web/src/index.css：session-right 使用 absolute 和渐变覆盖行文字。
- src/web/src/index.css：session-kebab 宽 28px，::before 左右各扩展 10px，相邻热区重叠。
- src/web/src/components/WorkspaceView.tsx：Open 行右侧提供 Move、Pin / Unpin、Complete。

## 生成记录

使用内置 image_gen 工具生成。参考图为用户提供的 Session 列表截图。
保留原始生成文件：
/root/.codex/generated_images/01a10261-5d51-7a21-b65d-af0ed2cc3d16/exec-a8e9648b-3677-4647-b423-4abb1a4736b1.png

### 最终提示词

```text
Use case: ui-mockup
Asset type: high-fidelity desktop Session list interaction design board, in Chinese, for review before implementation.
Input image: the supplied image is a reference for the EXISTING Orbit Session row, its actual content, pale blue selection and green tag. Redesign the row interaction; do not reproduce the problematic giant tooltip or overlay toolbar.
Create one polished, exceptionally crisp, flat UI design board, landscape approximately 1600x1100, light neutral gray canvas, white panels, subtle hairline borders, very restrained shadows only for the dropdown. This must look like a realistic desktop productivity application's design specification, not an illustration or promotional poster. Use legible native system sans typography. Maintain compact two-line session rows, familiar blue #3370ff accents, text #1f2329 / #646a73, muted gray icons and green tag.
Top heading: "Session 列表 · 交互优化". Subtitle: "固定操作区，减少遮挡与误触".
Layout: left 52% main full list panel, right 43% two vertically stacked interaction details. Generous outer whitespace, precise alignment. Three numbered Chinese section labels: "01 默认状态", "02 悬停 / 键盘聚焦", "03 更多操作".

LEFT PANEL — 01 默认状态:
Simple panel heading "Sessions". Below it a collapsible section header "Pinned" with a subtle down chevron.
Selected row: small blue activity spinner in left gutter, exact title "Upgrade from main branch", then a SMALL subtle gray pin status icon after title (not a clickable pin button). Second line has a small green pill "项目部署", gray "+1", gray preview "I’m using the upgrade skill to deploy…". Pale blue #edf3ff rounded-6px selected background, NO blue vertical edge stripe. Right side has a deliberately reserved fixed-width action area separate from the text, no gradient overlays. At top right small muted time "刚刚"; underneath a subtle always-visible three-dot ellipsis button. The space immediately before this ellipsis is empty at rest, reserved for a completion button on hover. Text cleanly truncates with ellipsis BEFORE the reserved actions; never runs beneath buttons.
Second pinned row: title "Session list polish", small gray pin status icon, gray idle status circle, lavender small tag "界面优化", preview "Updated the interaction details", time "12 分钟", subtle ellipsis in same stable position.
Section header "Today".
Two neutral unselected rows "Review pending changes" and "Update workspace settings", muted preview lines, timestamps "28 分钟", "1 小时", small status circles and always-visible ellipsis buttons. Rows white, compact, calm, minimal separators. No added navigation chrome or features.
Below this panel, three short callouts in normal Chinese text with small blue dots:
"浅蓝底表示选中，图钉表示置顶"
"文字与操作分区，悬停不跳动"
"更多入口常驻，点击整行打开会话"

RIGHT TOP — 02 悬停 / 键盘聚焦:
Magnified but realistic same selected row with title "Upgrade from main branch", tiny gray pin icon, same green tag "项目部署" and "+1", preview "I’m using the upgrade skill…", blue spinner. Preserve two-line hierarchy, fixed reserved action area, and no blue vertical stripe. On right the time "刚刚" above. In action area show a small neutral outlined button with check icon and label "完成" immediately left of a separate 32px square three-dot button. Buttons are modest and distinct, separated by an 8px gap, never touching, no expanded invisible hit targets, no giant dark tooltip. Cursor near 完成 button. Button style very light neutral outline, not saturated blue.
Short note underneath: "完成直接操作 · 按钮热区互不重叠"
Second short note: "悬停或键盘聚焦时出现，布局保持不变"

RIGHT LOWER — 03 更多操作:
Same selected row, identical dimensions and action positions, three-dot button active with quiet gray rounded background. White dropdown anchored immediately below right ellipsis, outside row and above background. Dropdown width about 230px, radius 8px, slim border, subtle soft shadow. Menu has ONLY two roomy entries, clear icon plus text: a pin icon and "取消置顶"; a folder outline icon and "移动到…". No delete, share, settings or other unrequested functionality. Do not repeat 完成 inside this menu; 完成 is the neighboring direct action.
Under menu show short note: "低频操作带文字，点击后收起菜单".
At bottom of entire board a small slim neutral feedback example: check circle + "已取消置顶" and blue "撤销", with small explanatory label "操作反馈". This is a proposed design state, not proof of actual application behavior.
Constraints: use exact concise Chinese labels, readable text, visually balanced board; retain supplied row title and tag; no watermark, no brand logo, no mobile devices, no gradients, no oversized tooltip, no decorative art, no strong card shadows. The important result is a concrete, buildable UI with stable text geometry and clearly separated click targets.
```
