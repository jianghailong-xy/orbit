import { OverlaySurface, type OverlayProps } from './Overlay';

export interface DialogProps extends OverlayProps {}

export function Dialog(props: DialogProps) {
  return <OverlaySurface {...props} />;
}
