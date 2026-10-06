import { useLayoutEffect, useRef, useState, type AriaAttributes, type ReactNode } from 'react';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import './Segmented.css';

export interface SegmentedOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<Value extends string = string> extends AriaAttributes {
  value: Value;
  onValueChange: (value: Value) => void;
  options: SegmentedOption<Value>[];
  disabled?: boolean;
  className?: string;
}

type Span = { left: number; width: number };
const EASE = 'cubic-bezier(0.645, 0.045, 0.355, 1)';

/**
 * A row of mutually exclusive views (radiogroup). Only the compact size the task panel uses today:
 * 2px track, 20px items. A change slides the selection from the old item to the new one, as the
 * control it replaces did, unless reduced motion is asked for.
 */
export function Segmented<Value extends string>({ value, onValueChange, options, disabled, className, ...aria }: SegmentedProps<Value>) {
  const group = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const shown = useRef(value);
  const [motion, setMotion] = useState<{ from: Span; to: Span } | null>(null);
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = value;
    const items = group.current?.querySelectorAll<HTMLElement>('.orbit-segmented-item');
    if (from === value || !items || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const span = (target: Value): Span | null => {
      const item = items[options.findIndex((option) => option.value === target)];
      return item?.offsetParent ? { left: item.offsetLeft, width: item.clientWidth } : null;
    };
    const start = span(from), end = span(value);
    if (start && end) setMotion({ from: start, to: end });
  }, [value, options]);
  useLayoutEffect(() => {
    if (!motion || !thumb.current?.animate) return;
    const animation = thumb.current.animate([
      { transform: `translateX(${motion.from.left}px)`, width: `${motion.from.width}px` },
      { transform: `translateX(${motion.to.left}px)`, width: `${motion.to.width}px` },
    ], { duration: 300, easing: EASE, fill: 'forwards' });
    animation.onfinish = () => setMotion(null);
    return () => animation.cancel();
  }, [motion]);
  return (
    <BaseRadioGroup {...aria} value={value} onValueChange={(next) => onValueChange(next as Value)} disabled={disabled}
      className={`orbit-segmented${className ? ` ${className}` : ''}`}>
      <div ref={group} className="orbit-segmented-group" data-motion={motion ? '' : undefined}>
        {motion && <div ref={thumb} className="orbit-segmented-thumb" aria-hidden />}
        {options.map((option) => (
          <BaseRadio.Root key={option.value} value={option.value} disabled={option.disabled} className="orbit-segmented-item">
            <span className="orbit-segmented-label" title={typeof option.label === 'string' ? option.label : undefined}>
              {option.label}
            </span>
          </BaseRadio.Root>
        ))}
      </div>
    </BaseRadioGroup>
  );
}
