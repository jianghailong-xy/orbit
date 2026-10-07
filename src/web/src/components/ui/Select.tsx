import { useRef, type AriaAttributes, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { CloseCircleFilled, DownOutlined, LoadingOutlined } from '@ant-design/icons';
import { SelectEmpty } from './SelectEmpty';
import { useAnchorWidth, useDropdownPlacement, useFloating, type FloatingProps } from './Floating';
import './Floating.css';
import './Select.css';

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  disabled?: boolean;
}
export interface SelectGroup<Value extends string = string> {
  label: string;
  options: SelectOption<Value>[];
}
export type SelectOptions<Value extends string = string> = (SelectOption<Value> | SelectGroup<Value>)[];

export interface SelectProps<Value extends string = string> extends AriaAttributes, FloatingProps {
  options: SelectOptions<Value>;
  value: Value | null;
  onValueChange: (value: Value | null) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  clearable?: boolean;
  clearLabel?: string;
  size?: 'small' | 'middle';
  variant?: 'outlined' | 'borderless';
  showArrow?: boolean;
  matchTriggerWidth?: boolean;
  emptyContent?: ReactNode;
  renderOption?: (option: SelectOption<Value>) => ReactNode;
  renderValue?: (value: Value, option: SelectOption<Value> | undefined) => ReactNode;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLButtonElement>;
}

export function flattenOptions<Value extends string>(options: SelectOptions<Value>) {
  return options.flatMap((entry) => 'options' in entry ? entry.options : [entry]);
}

export function Select<Value extends string = string>({ options, value, onValueChange, id, name, disabled, loading,
  placeholder, clearable, clearLabel = 'Clear selection', size = 'middle', variant = 'outlined', showArrow = true,
  matchTriggerWidth = true, emptyContent = <SelectEmpty />, renderOption, renderValue, className, style, ref,
  open, onOpenChange, side = 'bottom', align = 'start', popupClassName, popupStyle, returnFocus, ...aria }: SelectProps<Value>) {
  const layer = useFloating({ open, onOpenChange });
  const anchor = useRef<HTMLSpanElement>(null);
  const anchorWidth = useAnchorWidth(layer.open, anchor);
  const { positioner, ...placement } = useDropdownPlacement(layer.open, anchor, 4, align);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const flat = flattenOptions(options);
  const selected = flat.find((item) => item.value === value);
  const item = (option: SelectOption<Value>) => <BaseSelect.Item key={option.value} value={option.value} disabled={option.disabled} className="orbit-select-option">
    <BaseSelect.ItemText className="orbit-select-option-label">{renderOption?.(option) ?? option.label}</BaseSelect.ItemText>
  </BaseSelect.Item>;
  // Picking the option that is already chosen only closes the list, as with the select this replaces.
  return <BaseSelect.Root value={value} onValueChange={(next) => { if (next !== value) onValueChange(next); }} items={flat} name={name} disabled={disabled}
    open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <span ref={anchor} className={`orbit-select${className ? ` ${className}` : ''}`} data-size={size} data-variant={variant} data-open={layer.open || undefined} data-empty={value === null || undefined} data-disabled={disabled || undefined} style={style}>
      <BaseSelect.Trigger {...aria} id={id} ref={(node) => {
        trigger.current = node;
        if (typeof ref === 'function') return ref(node);
        if (ref) ref.current = node;
      }} className="orbit-select-trigger" aria-busy={loading || undefined} onKeyDown={(event) => {
        // Base UI moves focus into an opened list on the next animation frame. Until then the trigger
        // would restart the highlight (arrows) or close the list unselected (Enter), so hand these keys
        // to the element focus is moving to; they then act as in the list, as with AntD.
        const list = popup.current;
        if (!layer.open || !list || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        event.preventBaseUIHandler();
        const target = list.querySelector<HTMLElement>('[data-highlighted]') ?? list;
        target.focus({ preventScroll: true });
        target.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, code: event.code, bubbles: true, cancelable: true,
          shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey }));
      }}>
        <BaseSelect.Value className="orbit-choice-value" placeholder={placeholder}>
          {value === null ? undefined : renderValue?.(value, selected) ?? selected?.label ?? value}
        </BaseSelect.Value>
        {/* The replaced select's loading mark: its spinning arc in the arrow's place. */}
        {loading ? <LoadingOutlined spin className="orbit-choice-arrow" aria-hidden /> : showArrow && <DownOutlined className="orbit-choice-arrow" aria-hidden />}
      </BaseSelect.Trigger>
      {clearable && value !== null && !disabled && <button type="button" className="orbit-choice-clear" aria-label={clearLabel}
        onClick={() => { onValueChange(null); trigger.current?.focus(); }}><CloseCircleFilled aria-hidden /></button>}
    </span>
    <BaseSelect.Portal container={layer.container()}>
      <BaseSelect.Positioner ref={positioner} anchor={anchor} alignItemWithTrigger={false} side={side} align={align} {...placement}
        className="orbit-floating-positioner orbit-choice-positioner" data-match-width={matchTriggerWidth}
        style={{ zIndex: layer.zIndex, '--orbit-choice-anchor-width': anchorWidth === undefined ? undefined : `${anchorWidth}px` } as CSSProperties}>
        <BaseSelect.Popup ref={popup} className={`orbit-select-popup${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle} finalFocus={returnFocus}>
          <BaseSelect.List className="orbit-select-list">
            {options.map((entry) => 'options' in entry ? <BaseSelect.Group key={entry.label}>
              <BaseSelect.GroupLabel className="orbit-select-group-label">{entry.label}</BaseSelect.GroupLabel>{entry.options.map(item)}
            </BaseSelect.Group> : item(entry))}
          </BaseSelect.List>
          {flat.length === 0 && <div className="orbit-select-empty" role="status">{emptyContent}</div>}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>;
}
