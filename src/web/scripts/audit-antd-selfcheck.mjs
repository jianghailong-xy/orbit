import assert from 'node:assert/strict';
import { retirementBlockers, scanText } from './audit-antd.mjs';

const mixed = scanText('src/web/src/fixture.test.tsx', `import {
  App as AntApp,
  ConfigProvider as Provider,
  type MenuProps as Props,
} from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import 'antd/dist/reset.css';
const lazy = import('antd/es/modal');
const actual = require('antd');
vi.mock('antd', () => ({}));
vi.importActual<typeof import('antd')>('antd');
export { Button as Action } from 'antd';
const app = <AntApp><Provider /></AntApp>;
AntApp.useApp();
theme.useToken();
modal.confirm({});
modal.success({});
const area = ref.current?.resizableTextArea?.textArea;
const focus = keepFreeRef.current?.focus({ preventScroll: true });
document.querySelector('.ant-modal');
expect(html).toContain('ant-spin');
// antd explanation is intentionally included.
`);
assert.equal(mixed.category, 'test');
assert.equal(mixed.imports.length, 9);
assert.deepEqual(mixed.imports[0].bindings, [
  { imported: 'App', local: 'AntApp', typeOnly: false },
  { imported: 'ConfigProvider', local: 'Provider', typeOnly: false },
  { imported: 'MenuProps', local: 'Props', typeOnly: true },
]);
assert.equal(mixed.imports[1].bindings[0].typeOnly, true);
assert.equal(mixed.imports[2].kind, 'side-effect');
assert.equal(mixed.imports[2].line, 7);
for (const kind of ['provider', 'use-app', 'use-token', 'imperative-confirm', 'imperative-feedback', 'internal-ref', 'ref-focus', 'ant-selector', 'ant-class']) {
  assert(mixed.hits.some((hit) => hit.kind === kind), `missing ${kind}`);
}
assert(mixed.hits.some((hit) => hit.kind === 'antd-reference' && hit.text.startsWith('//')));
assert.deepEqual(retirementBlockers([mixed]), [mixed.path]);

const icons = scanText('src/web/src/icons.tsx', `import { CloseOutlined as Close } from '@ant-design/icons';
import Icon from '@ant-design/icons/es/components/Icon';
const icon = '.anticon anticon-close';
// @ant-design/icons-svg, @ant-design/colors, @rc-component/util may remain.
const style = 'font-variant-numeric: tabular-nums';`);
assert.equal(icons.imports.length, 2);
assert(icons.imports.every((item) => item.family === 'icons'));
assert(!icons.hits.some((hit) => hit.kind === 'ant-class'));
assert.deepEqual(retirementBlockers([icons]), []);
const iconManifest = scanText('src/web/package.json', '{"dependencies":{"@ant-design/icons":"^6.3.4"}}');
const iconLock = scanText('package-lock.json', '{"packages":{"node_modules/@ant-design/icons":{"version":"6.3.4","dependencies":{"@ant-design/colors":"^8.0.1"}}}}');
assert.deepEqual(retirementBlockers([iconManifest, iconLock]), []);
for (const [path, source] of [
  ['src/web/package.json', '{"dependencies":{"antd":"^6.6.5"}}'],
  ['package-lock.json', '{"packages":{"node_modules/antd":{"version":"6.6.5"}}}'],
]) assert.deepEqual(retirementBlockers([scanText(path, source)]), [path]);

for (const source of ["import '@ant-design/v5-patch-for-react-19';", 'ref.current?.resizableTextArea?.textArea', "const prefix = 'ant-';"]) {
  assert.equal(retirementBlockers([scanText('src/web/src/retired.ts', source)]).length, 1);
}
const namespace = scanText('src/web/src/namespace.ts', "import * as AntD from 'antd';\nimport Default from 'antd';");
assert.deepEqual(namespace.imports.map((item) => item.bindings[0].imported), ['*', 'default']);
assert.deepEqual(scanText('src/web/src/__tests__/fixture.ts', '').category, 'test');
assert.equal(scanText('src/web/src/test.spec.ts', '').category, 'test');
assert.deepEqual(scanText('src/web/src/index.css', '@import "antd/dist/reset.css";').imports.map((item) => item.kind), ['css-import']);
assert.deepEqual(scanText(mixed.path, 'same text'), scanText(mixed.path, 'same text'));
console.log('audit-antd self-check passed: imports, aliases, types, mocks, selectors, refs, deterministic output and icon-safe retirement gate.');
