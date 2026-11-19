// antd icons as the console draws them: <span role="img" class="anticon anticon-x"><svg …></span>.
import { createRequire } from 'node:module';
const require = createRequire('/root/.orbit/worktrees/01a1c548-51fd-7597-8625-78f9a70996c3/node_modules/');
const { renderIconDefinitionToSVGElement } = require('@ant-design/icons-svg/lib/helpers');
const NAMES = {
  down: 'DownOutlined', right: 'RightOutlined', tool: 'ToolOutlined', code: 'CodeOutlined',
  'file-text': 'FileTextOutlined', edit: 'EditOutlined', 'check-circle': 'CheckCircleFilled',
  'close-circle': 'CloseCircleFilled', copy: 'CopyOutlined', more: 'MoreOutlined', ellipsis: 'EllipsisOutlined',
  loading: 'LoadingOutlined', branches: 'BranchesOutlined', 'cloud-upload': 'CloudUploadOutlined',
  'unordered-list': 'UnorderedListOutlined', download: 'DownloadOutlined', 'arrow-down': 'ArrowDownOutlined',
  'minus-circle': 'MinusCircleOutlined', user: 'UserOutlined', 'file-text-o': 'FileTextOutlined',
  message: 'MessageOutlined', 'safety-certificate': 'SafetyCertificateOutlined', reload: 'ReloadOutlined',
  close: 'CloseOutlined', 'exclamation-circle': 'ExclamationCircleFilled', 'arrow-left': 'ArrowLeftOutlined',
  'pull-request': 'PullRequestOutlined', 'clock-circle': 'ClockCircleOutlined', lock: 'LockOutlined', sync: 'SyncOutlined', 'swap-right': 'SwapRightOutlined', 'check': 'CheckOutlined', 'node-index': 'NodeIndexOutlined', inbox: 'InboxOutlined',
};
export function icon(name, cls = '', { spin = false } = {}) {
  const def = require(`@ant-design/icons-svg/lib/asn/${NAMES[name]}`).default;
  const svg = renderIconDefinitionToSVGElement(def, {
    extraSVGAttrs: { focusable: 'false', width: '1em', height: '1em', fill: 'currentColor', 'aria-hidden': 'true', 'data-icon': name },
  });
  return `<span role="img" aria-label="${name}" class="anticon anticon-${name}${spin ? ' anticon-spin' : ''}${cls ? ` ${cls}` : ''}">${svg}</span>`;
}
