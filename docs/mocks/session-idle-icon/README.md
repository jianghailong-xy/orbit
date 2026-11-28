# Session list: the Idle icon

[board.png](board.png) (source [board.html](board.html)) compares the Idle icon on a list row: before the three-states
change of 2026-11-25 (one icon per situation), today's empty grey circle, nothing, and a small dot.

**Decision (owner, 2026-11-28):** Idle draws the grey speech bubble, the shape idle conversations wore before 11/25
(Mac/iOS SF Symbol `message`; web antd `MessageOutlined`; Android the matching round bubble with three dots,
`ic_chat`). The empty circle read as an unticked
checkbox and invited a click. Only the icon changes: the state word and tooltip stay "Idle", and the bubble no longer
claims "Waiting for your reply".

**Amended the same day (owner):** the first version shipped a rectangular outline drawn for the board, not the early
product's icon. [bubble-compare.png](bubble-compare.png) set it beside the original, and the owner chose the original.
