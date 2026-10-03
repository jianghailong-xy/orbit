# Session 列表交互设计 v3：对齐 iOS 左右滑

设计图：[session-list-interaction-v3.png](session-list-interaction-v3.png)

状态：菜单规则提案；界面文案与最终设计图以 [英文版 v4](session-list-interaction-v4-en.md) 为准。本版补齐 v2 的菜单操作集合，保留行内仅显示更多入口、完成进入菜单及快捷键提示的用户要求。

## 已核对的 iOS 功能

下表左右滑指手指移动方向；动作顺序为屏幕从左到右。

| 列表 | 右滑：露出左侧 | 左滑：露出右侧 |
| --- | --- | --- |
| Open | Complete、Pin / Unpin | Share、Move、Delete |
| Completed | Move to Open、Pin / Unpin | Share、Move、Delete |
| Trash | Move to Open | Delete Permanently |

依据：src/macos/OrbitApp/Sources/OrbitApp/Views/SessionRowActions.swift:128–190；docs/session-folders-move-design.md §2。web 的 src/web/src/lib/sessionSwipe.ts 也已有相同映射。

iOS 长按另有 Rename、Tags，二者不属于本次用户指定的左右滑功能集合，因此本版不扩充它们。

## 建议的菜单结构

| 顺序与分组 | Open | Completed | Trash |
| --- | --- | --- | --- |
| 状态操作 | 完成，右侧 ⌘D / Ctrl D | 移回 Open | 移回 Open |
| 置顶操作 | 置顶 / 取消置顶 | 置顶 / 取消置顶 | 不出现 |
| 分隔后：共享与归类 | 分享…、移动到… | 分享…、移动到… | 不出现 |
| 分隔后：移除 | 移到回收站，红色 | 移到回收站，红色 | 永久删除…，红色 |

五项菜单无需子菜单。功能集合与 iOS 相同，顺序按状态、置顶、分享、移动、删除组织。菜单文案用「移到回收站」说明软删除结果；「分享…」「移动到…」「永久删除…」后的省略号表示会先打开面板或确认。

## 产品判断

1. **让菜单负责管理，让列表负责阅读。** 行内只有常驻的 ⋯，只预留窄操作列；标题和摘要在列前省略。悬停仅改变按钮背景，避免遮挡、横向抖动或突然出现多个操作。浅蓝底表示选中，小图钉表示置顶。菜单开启时需要弱底色或焦点框指向它的行，不能让用户误以为是在操作别的会话。
2. **“完成”说明生命周期变化。** Open 包含运行中、等待、空闲和已经运行成功但尚未归档的会话，不能理解为“正在运行”。Complete 会移到 Completed；运行中的会话还会结束当前运行。仅对活跃会话，在菜单项下显示「结束运行并移至已完成」。保持当前直接执行和结果反馈的交互，不新增每次确认。移回 Open 不自动开始运行；撤销也不承诺重启先前运行。
3. **快捷键要与菜单目标一致。** 显示真实的现有 ⌘D / Ctrl D；不为其他操作编造快捷键。当前实现只完成选中会话，新设计建议：菜单打开时，键盘操作归菜单对应行；菜单关闭后恢复当前选中会话的快捷键。菜单中没有完成项或该项禁用时，不得让按键穿透并完成另一条会话。打开菜单本身不切换右侧对话。这是待实现的行为调整，图不是运行证据。
4. **结果反馈要准确。** 完成与普通移到回收站沿用现有撤销反馈；永久删除先确认且无撤销。web 对已有公开链接的会话移入回收站，当前另有“暂停公开链接”的提示，应保留，不能因对齐菜单而绕过。分享、移动继续复用现有面板和跨 Workspace 的限制、必要确认。
5. **列表类型决定菜单集合，能力决定能否执行。** Trash 省掉置顶、分享、移动；Open 与 Completed 保留完整五项。canComplete / canRestore 暂不可用时保留对应项并禁用，说明实际原因，避免同一状态的菜单位置频繁改变。菜单被操作导致会话移出列表时应关闭，给出可辨识的会话标题与结果通知。

## 两处现有语义值得跨端评估

以下是产品建议，尚未在本次设计中改变现有业务行为，也不构成已安排的实现工作。

- **Completed 的置顶缺少排序反馈。** iOS 当前保留 Pin / Unpin，但 Completed 按完成时间分组、不展示 Pinned 分组。此次按用户要求保留操作。若置顶含义是“此列表优先展示”，建议将来两端一致地让 Completed 置顶可见并优先排列；若只保存回到 Open 后的偏好，则应明确说明。当前不单独删掉 web 的置顶。
- **从 Completed 删除后的 Undo 会返回 Open。** 当前客户端 Undo 调用 Move to Open，不恢复删除前的生命周期。产品上更符合预期的“撤销删除”应回到删除前所在列表；若保留当前能力，应考虑把通知动作文案明确为“移回 Open”，避免把改变状态包装成原样撤销。另需明确，撤销列表状态不等于恢复执行。

依据：src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift 中 completeSession、moveSessionToOpen、deleteSession 的通知动作；src/macos/OrbitKit/Sources/OrbitKit/App/SessionTimeGrouping.swift:38；src/web/src/components/WorkspaceView.tsx 的 showUndo / requestTrash。

## 设计检查

- Open 与 Completed 各 5 个操作，Trash 2 个，覆盖 iOS 左右滑集合。
- 完成仅在 Open 菜单中；右侧显示快捷键。恢复不显示完成快捷键。
- 已置顶的示例行显示「取消置顶」，恢复图标与分享图标区分。
- 删除末尾隔开；软删除与永久删除文案不同。
- 本轮仅产出设计图片与设计说明，没有修改应用代码。

## 生成记录

工具：内置 image_gen。基于 v2 编辑生成三状态方案，再修正 Completed 置顶标签与恢复图标。所有原始生成文件均保留。

初稿：
/root/.codex/generated_images/01a10261-5d51-7a21-b65d-af0ed2cc3d16/exec-3eb73a1e-1a2c-4458-8ed2-8c5ad9d937b6.png

最终：
/root/.codex/generated_images/01a10261-5d51-7a21-b65d-af0ed2cc3d16/exec-d8e1867c-f351-4323-98bf-8845dc9275f4.png

### 提示词：三状态方案

```text
Use case: ui-mockup
Asset type: v3 high-fidelity desktop Session row menu design board.
Input: supplied image is the v2 design reference and edit target. Keep its crisp white panels, pale-blue selected two-line session row, compact ellipsis button, charcoal system typography, muted secondary text, green tag and restrained blue accents. Revise the board to show all three menu states aligned with actual iOS swipe actions.
User constraints: only one row action button, ⋯; Complete MUST be inside the menu, with keyboard shortcut on its right. No standalone Complete button in ANY row.
Make an elegant landscape design board about 1700x1150 with title "Session 菜单 · 与 iOS 操作对齐" and subtitle "一个入口，按会话状态提供完整操作". Three white panels side by side; left Open panel slightly wider, other panels equal. No unnecessary application chrome or marketing decoration. All Chinese and English text must be crisp and exact.

LEFT PANEL — heading "01  Open"
A realistic selected row with pale-blue background, blue running spinner, title "Upgrade from main branch" followed by tiny gray pin status icon, second line green tag "项目部署", muted "+1", preview "I’m using the upgrade skill…". Right narrow fixed column contains time "刚刚" and a sole highlighted ⋯ button. Title and preview truncate cleanly before the action column. Absolutely no other clickable buttons on the row.
Below the ellipsis show a large white dropdown anchored to it, around 300px wide, hairline border, slight soft shadow, 8px radius. Menu entries in THIS EXACT ORDER:
1. check-circle icon, "完成" and right-aligned subtle "⌘D". Under this menu label, smaller muted subtitle "结束运行并移至已完成" since this example session is running.
2. pin-slash icon, "取消置顶"
thin divider
3. share icon, "分享…"
4. folder outline icon, "移动到…"
thin divider
5. red trash outline icon, red "移到回收站"
These are FIVE actions total, no duplicate entries. Roomy consistent menu item spacing.
Below the dropdown and clearly outside it, two small explanatory lines: "右滑：完成 · 置顶 / 取消置顶" and "左滑：分享 · 移动 · 删除".

MIDDLE PANEL — heading "02  Completed"
A compact selected row with subdued check-circle status, title "Session list polish", a purple small tag "界面优化", gray preview "Updated the interaction details", time "12 分钟", and ONLY ellipsis button at right.
Expanded dropdown in exactly the same style and width, entries:
1. tray-up / restore icon, "移回 Open"
2. pin icon, "置顶"
thin divider
3. share icon, "分享…"
4. folder outline icon, "移动到…"
thin divider
5. red trash icon, red "移到回收站"
FIVE entries. Do NOT show ⌘D in this menu; it has no completion action. Under panel menu, short note "移回 Open 后，不会自动开始运行". Another small note "保留 iOS 已有的置顶能力".

RIGHT PANEL — heading "03  Trash"
A compact neutral session row title "Review pending changes", gray preview "Check and merge the latest changes", time "28 分钟", ONLY ellipsis button on right.
Dropdown with ONLY TWO entries:
1. tray-up / restore icon, "移回 Open"
thin divider
2. red trash-slash icon, red "永久删除…"
Under dropdown show compact plain explanatory text:
"永久删除需要确认"
"回收站不提供置顶、分享或移动"
Do not introduce any extra disabled entries into this menu.

Below the three panels, a restrained full-width product-rule strip with THREE brief columns and small blue numbered dots:
"操作分组" — "状态与置顶 → 分享与移动 → 删除"
"快捷键" — "完成：⌘D / Ctrl+D，作用于菜单对应会话"
"反馈" — "完成与移到回收站可撤销，永久删除需确认"
An unobtrusive footer: "设计提案 · 快捷键目标需在实现时同步调整"

Constraints: high-fidelity and buildable, compact app typography rather than huge display type. Distinct icon-plus-label menu rows. Only danger actions red; do not color every action. No gradients, no giant tooltip, no hover toolbar, no direct Complete outside menu, no rename / tags editing / copy link / download / settings / stop / resume additions. Each menu is anchored under its own row, and every action label and explanatory note must fit without overlap. Preserve screenshot's visual system, but reorganize the board for this complete three-state specification.
```

### 最终修订提示词

```text
Use case: ui-mockup
Edit the supplied v3 design board with ONLY these small consistency corrections. Preserve every other label, layout, colors, spacing, menus, background, footer and all three state panels exactly.
1. In the MIDDLE panel "02 Completed", the session row already shows a pin status icon, so it is PINNED. Its second dropdown item must therefore read "取消置顶", not "置顶". Use a muted pin-with-slash icon for this menu action, matching the equivalent Open menu action. Keep the pin status icon after "Session list polish".
2. In BOTH the middle Completed dropdown and the right Trash dropdown, the first "移回 Open" item currently has the same upload/share icon as "分享…". Change ONLY those two restore icons to a simple curved undo arrow pointing left, clearly different from the share icon. Preserve the icon size and muted charcoal color. Keep the "分享…" icons unchanged.
Do not change anything else. Do not add any actions or buttons. The Open menu must still read 完成 with ⌘D, 取消置顶, 分享…, 移动到…, 移到回收站. The Completed menu must now read 移回 Open, 取消置顶, 分享…, 移动到…, 移到回收站. Trash remains 移回 Open, 永久删除…. Crisp exact Chinese text.
```
