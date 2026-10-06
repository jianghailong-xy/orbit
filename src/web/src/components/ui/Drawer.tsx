import type { CSSProperties, ReactNode } from 'react';
import { OverlaySurface, type OverlayProps } from './Overlay';

export interface DrawerProps extends OverlayProps {
  placement?: 'right' | 'bottom';
  height?: CSSProperties['height'];
  headerActions?: ReactNode;
}

// Existing drawers have no swipe-to-dismiss or snap points: a positioned dialog.
export function Drawer({ width = 378, ...props }: DrawerProps) {
  return <OverlaySurface {...props} width={width} kind="drawer" />;
}
