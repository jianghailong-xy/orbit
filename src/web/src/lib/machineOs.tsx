import { AppleOutlined, DesktopOutlined, LinuxOutlined, WindowsOutlined } from '@ant-design/icons';

/** The OS a runner reported, from its `os:<goos>` capability (the server's runner-platform.ts); null when it has not said. */
export function machineOs(runner: { capabilities?: string[] }): string | null {
  const os = runner.capabilities?.find((capability) => capability.startsWith('os:'));
  return os ? os.slice(3) : null;
}

/**
 * A machine's icon in a machine list, by the OS it reported: Apple, Linux or Windows, else a monitor
 * (docs/mocks/machine-menu-icons, A). Orbit Cloud keeps its own cloud and never reaches this.
 */
export function MachineOsIcon({ runner }: { runner: { capabilities?: string[] } }) {
  const os = machineOs(runner);
  if (os === 'darwin') return <AppleOutlined aria-hidden data-os="darwin" />;
  if (os === 'linux') return <LinuxOutlined aria-hidden data-os="linux" />;
  if (os === 'windows') return <WindowsOutlined aria-hidden data-os="windows" />;
  return <DesktopOutlined aria-hidden data-os="unknown" />;
}
