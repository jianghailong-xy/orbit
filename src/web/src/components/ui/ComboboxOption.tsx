import { useRef, type ReactNode } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import type { SelectOption } from './Select';

/** Base UI 1.8 cancels pointerdown, which suppresses WebKit's touch click.
 * Let touch generate its native click; keep mousedown's input-focus protection
 * and skip the drag-select mouseup fallback so a tap cannot toggle twice. */
export function ComboboxOption({ option, children, className = 'orbit-select-option' }: {
  option: SelectOption; children: ReactNode; className?: string;
}) {
  const touch = useRef(false);
  return <BaseCombobox.Item value={option} disabled={option.disabled} className={className} title={option.title}
    onPointerDownCapture={(event) => {
      touch.current = event.pointerType === 'touch';
      if (touch.current) event.preventBaseUIHandler();
    }} onMouseUp={(event) => { if (touch.current) event.preventBaseUIHandler(); }}>
    {children}
  </BaseCombobox.Item>;
}
