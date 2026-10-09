import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type CSSProperties } from 'react';
import './TextControls.css';

export interface TextareaAutoSize {
  minRows?: number;
  maxRows?: number;
}

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
  /** `borderless` drops the frame for a field drawn inside its own surface (the session composer). */
  variant?: 'outlined' | 'borderless';
  /**
   * Grow with the content between minRows and maxRows of the field's own line height, then scroll.
   * Off leaves the height to `rows` and `style` — which is how a caller holds a height the user dragged.
   */
  autoSize?: boolean | TextareaAutoSize;
}

export function Textarea({
  invalid = false, variant = 'outlined', autoSize = false, className, style, disabled, ref,
  ...props
}: TextareaProps) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const fitted = useAutoSize(field, autoSize, props.value);
  return (
    <textarea
      {...props}
      ref={(node) => {
        field.current = node;
        if (typeof ref === 'function') return ref(node);
        if (ref) ref.current = node;
      }}
      className={['orbit-text-control', 'orbit-textarea', className].filter(Boolean).join(' ')}
      // The measured size wins over the caller's style, as it did for the AntD field it replaces.
      style={fitted ? { ...style, ...fitted } : style}
      disabled={disabled}
      data-variant={variant === 'borderless' ? 'borderless' : undefined}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
    />
  );
}

function useAutoSize(field: { current: HTMLTextAreaElement | null }, autoSize: TextareaProps['autoSize'], value: unknown) {
  const enabled = !!autoSize;
  const minRows = typeof autoSize === 'object' ? autoSize.minRows : undefined;
  const maxRows = typeof autoSize === 'object' ? autoSize.maxRows : undefined;
  const [fitted, setFitted] = useState<CSSProperties>();
  const measure = useRef(() => {});
  measure.current = () => {
    if (!field.current) return;
    const next = fitToContent(field.current, minRows, maxRows);
    setFitted((current) => sameFit(current, next) ? current : next);
  };
  // Measure before paint whenever the drawn text or the row bounds change. The placeholder is
  // not a trigger: like the field this replaces, it is picked up by the next value or width change.
  useLayoutEffect(() => {
    if (enabled) measure.current();
  }, [enabled, value, minRows, maxRows]);
  // A width change re-wraps the same text; measure again on the next frame.
  useEffect(() => {
    const node = field.current;
    if (!enabled || !node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measure.current());
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [enabled, field]);
  return enabled ? fitted : undefined;
}

// What decides how tall the same text lays out. Copied onto an offstage twin of the field, with
// the same list and arithmetic as the AntD field it replaces, so a migrated field grows to the
// exact heights — and from its placeholder while empty — that it had before.
const SIZING = ['letter-spacing', 'line-height', 'padding-top', 'padding-bottom', 'font-family', 'font-weight',
  'font-size', 'font-variant', 'text-rendering', 'text-transform', 'width', 'text-indent', 'padding-left',
  'padding-right', 'border-width', 'box-sizing', 'word-break', 'white-space'];
const OFFSTAGE = 'min-height:0!important;max-height:none!important;height:0!important;visibility:hidden!important;'
  + 'overflow:hidden!important;position:absolute!important;z-index:-1000!important;top:0!important;right:0!important;'
  + 'pointer-events:none!important';
let twin: HTMLTextAreaElement | undefined;

function fitToContent(node: HTMLTextAreaElement, minRows?: number, maxRows?: number): CSSProperties {
  const computed = getComputedStyle(node);
  const padding = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
  const border = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
  const boxSizing = computed.boxSizing;
  if (!twin) {
    twin = document.createElement('textarea');
    twin.setAttribute('aria-hidden', 'true');
  }
  const wrap = node.getAttribute('wrap');
  if (wrap) twin.setAttribute('wrap', wrap);
  else twin.removeAttribute('wrap');
  twin.setAttribute('style', `${SIZING.map((name) => `${name}:${computed.getPropertyValue(name)}`).join(';')};${OFFSTAGE}`);
  twin.value = node.value || node.placeholder || '';
  document.body.appendChild(twin);
  try {
    let height = twin.scrollHeight;
    if (boxSizing === 'border-box') height += border;
    else if (boxSizing === 'content-box') height -= padding;
    let minHeight: number | undefined;
    let maxHeight: number | undefined;
    let overflowY: CSSProperties['overflowY'];
    if (minRows != null || maxRows != null) {
      twin.value = ' ';
      const row = twin.scrollHeight - padding;
      const frame = boxSizing === 'border-box' ? padding + border : 0;
      if (minRows != null) {
        minHeight = row * minRows + frame;
        height = Math.max(minHeight, height);
      }
      if (maxRows != null) {
        maxHeight = row * maxRows + frame;
        overflowY = height > maxHeight ? undefined : 'hidden';
        height = Math.min(maxHeight, height);
      }
    }
    return { height, overflowY, resize: 'none', ...(minHeight ? { minHeight } : {}), ...(maxHeight ? { maxHeight } : {}) };
  } finally {
    // Only attached while measuring: no stray form field is left in the page.
    twin.remove();
    twin.value = '';
  }
}

function sameFit(a: CSSProperties | undefined, b: CSSProperties) {
  return !!a && a.height === b.height && a.minHeight === b.minHeight && a.maxHeight === b.maxHeight && a.overflowY === b.overflowY;
}
