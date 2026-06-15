import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';

const INSTALL = 'curl -fsSL https://orbit.wikova.com/install.sh | bash';
const REGISTER = 'orbit register';
const FOREGROUND = 'orbit register --foreground';

const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  background: '#f5f6f7',
  border: '1px solid #e5e6eb',
  borderRadius: 6,
  padding: '8px 12px',
  margin: 0,
  fontSize: 13,
  maxWidth: 620,
};

function Step({ n, label, command }: { n: number; label: string; command: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: '#1f2329' }}>
        {n} · {label}
      </div>
      <Typography.Paragraph copyable={{ text: command }} style={codeStyle}>
        {command}
      </Typography.Paragraph>
    </div>
  );
}

/** Right-pane guide for connecting a new runner machine (shown from the side panel's “新增”). */
export function RunnerRegisterGuide({ onClose }: { onClose: () => void }) {
  return (
    <div>
      <Button
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={onClose}
        style={{ marginBottom: 8, paddingLeft: 0 }}
      >
        Back
      </Button>
      <h1 className="page-title">Add a runner</h1>
      <p style={{ color: '#646a73', maxWidth: 620, marginBottom: 24 }}>
        A runner is a machine that runs Claude Code tasks for you. Run these on the machine you want
        to add — it appears in the list on the left once it comes online.
      </p>
      <Step n={1} label="Install the CLI" command={INSTALL} />
      <Step
        n={2}
        label="Register & approve in your browser (auto-starts as a background service)"
        command={REGISTER}
      />
      <Step
        n={3}
        label="Or run in the foreground instead of installing a service"
        command={FOREGROUND}
      />
    </div>
  );
}
