"""Write the inverse of 632b7950e (the Select window fix) into Select.tsx as it stands at the project tip.

The fix is 31aa07c91 on the project line. A later commit (6e3e4f464) changed the Positioner lines next to
the Popup line, so `git revert` stops on a conflict there; this removes exactly the three things the fix
added (the popup ref, the trigger onKeyDown, ref={popup}) and nothing else. Usage: python3 -I revert-632b7950e.py <Select.tsx>"""
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
start = text.index('}} className="orbit-select-trigger" aria-busy={loading || undefined} onKeyDown={(event) => {')
end = text.index('}}>', text.index('metaKey: event.metaKey }));', start)) + len('}}>')
steps = [
    ('  const popup = useRef<HTMLDivElement>(null);\n', ''),
    (text[start:end], '}} className="orbit-select-trigger" aria-busy={loading || undefined}>'),
    ('<BaseSelect.Popup ref={popup} className=', '<BaseSelect.Popup className='),
]
for old, new in steps:
    assert text.count(old) == 1, old
    text = text.replace(old, new)
path.write_text(text)
