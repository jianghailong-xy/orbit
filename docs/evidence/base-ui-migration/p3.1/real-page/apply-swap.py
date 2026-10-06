"""Swap the Orbit Textarea into the real WorkspaceView composer and TaskDetailPanel comment box.

Verification only (P3.1): P5.3 and P3.2 own these switches. Run against a scratch checkout."""
import sys
from pathlib import Path

root = Path(sys.argv[1])

def edit(path, pairs):
    file = root / path
    text = file.read_text()
    for old, new, count in pairs:
        assert text.count(old) == count, (path, old, text.count(old))
        text = text.replace(old, new)
    file.write_text(text)

edit('src/web/src/components/WorkspaceView.tsx', [
    ("import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Popover, Select, Spin, Tooltip } from 'antd';\n",
     "import { App as AntApp, Button, Dropdown, Image, type MenuProps, Popover, Select, Spin, Tooltip } from 'antd';\nimport { Textarea } from './ui/Textarea';\n", 1),
    ("  const taRef = useRef<any>(null);\n  const imageInputRef", "  const taRef = useRef<HTMLTextAreaElement>(null);\n  const imageInputRef", 1),
    ("const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;", "const ta = taRef.current;", 2),
    ("          <Input.TextArea\n            ref={taRef}\n            onScroll=", "          <Textarea\n            ref={taRef}\n            onScroll=", 1),
])
edit('src/web/src/components/TaskDetailPanel.tsx', [
    ("import { Alert, Avatar, Button, Dropdown, Input, Modal, Popconfirm, Segmented, Select, Spin, Switch, Tooltip, Typography } from 'antd';\n",
     "import { Alert, Avatar, Button, Dropdown, Modal, Popconfirm, Segmented, Select, Spin, Switch, Tooltip, Typography } from 'antd';\nimport { Textarea } from './ui/Textarea';\n", 1),
    ("  const taRef = useRef<any>(null);\n  const [caret, setCaret]", "  const taRef = useRef<HTMLTextAreaElement>(null);\n  const [caret, setCaret]", 1),
    ("const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;", "const ta = taRef.current;", 1),
    ("        <Input.TextArea\n          ref={taRef}\n          value={draft}", "        <Textarea\n          ref={taRef}\n          value={draft}", 1),
])
print('applied')
