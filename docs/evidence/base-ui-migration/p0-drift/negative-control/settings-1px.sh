# Negative control: a 1px change on the Settings page, whose settings.png is registered in the
# main drift reference for all eight projects (first card's bottom margin 16px -> 17px).
python3 - "$1" <<'PY'
import sys
p = sys.argv[1] + '/src/web/src/pages/SettingsPage.tsx'
s = open(p).read()
old = '<Card title="Session defaults" style={{ marginBottom: 16 }}>'
assert s.count(old) == 1
open(p, 'w').write(s.replace(old, '<Card title="Session defaults" style={{ marginBottom: 17 }}>'))
PY
