import { useId, useRef, useState, type Ref } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { CloseCircleFilled, DownOutlined } from '@ant-design/icons';
import { Spinner } from './Spinner';
import { SelectEmpty } from './SelectEmpty';
import { ComboboxOption } from './ComboboxOption';
import { useFloating } from './Floating';
import { flattenOptions, type SelectOption, type SelectProps } from './Select';

export interface ComboboxProps<Value extends string = string> extends Omit<SelectProps<Value>, 'ref'> {
  ref?: Ref<HTMLInputElement>;
  /** Remote searches supply already-filtered options. */
  filter?: boolean;
  onSearch?: (query: string) => void;
}

export function Combobox<Value extends string = string>({ options, value, onValueChange, id, name, disabled, loading,
  placeholder, clearable, clearLabel = 'Clear selection', size = 'middle', variant = 'outlined', showArrow = true,
  matchTriggerWidth = true, emptyContent = <SelectEmpty />, renderOption, renderValue, className, style, ref, filter = true, onSearch,
  open, onOpenChange, side = 'bottom', align = 'start', popupClassName, popupStyle, returnFocus, ...aria }: ComboboxProps<Value>) {
  const [query, setQuery] = useState('');
  const selectedId = useId();
  const updateQuery = (next: string) => { setQuery(next); onSearch?.(next); };
  const layer = useFloating({ open, onOpenChange: (next) => { if (!next) updateQuery(''); onOpenChange?.(next); } });
  const anchor = useRef<HTMLSpanElement>(null);
  const flat = flattenOptions(options);
  const selected = flat.find((item) => item.value === value) ?? (value === null ? null : { value, label: value });
  const grouped = options.some((entry) => 'options' in entry);
  const items = grouped ? options.map((entry) => 'options' in entry ? { label: entry.label, items: entry.options } : { label: '', items: [entry] }) : flat;
  const item = (option: SelectOption<Value>) => <ComboboxOption key={option.value} option={option}>
    <span className="orbit-select-option-label">{renderOption?.(option) ?? option.label}</span>
  </ComboboxOption>;
  return <BaseCombobox.Root value={selected} onValueChange={(next, details) => {
    // Editing the search query doesn't clear the stored selection. Only picking or
    // explicitly clearing does; this also supports value=null action pickers.
    if (details.reason === 'input-clear') return;
    onValueChange(next?.value ?? null);
    updateQuery('');
  }} items={items} isItemEqualToValue={(a, b) => a.value === b.value}
    inputValue={query} onInputValueChange={(next, details) => {
      if (details.reason === 'input-change' || details.reason === 'input-clear') updateQuery(next);
    }} filter={filter ? (option: SelectOption<Value>, search: string) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()) : null}
    autoHighlight name={name} disabled={disabled} open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <span ref={anchor} className={`orbit-choice orbit-combobox${className ? ` ${className}` : ''}`} data-size={size} data-variant={variant} data-open={layer.open || undefined} data-disabled={disabled || undefined} style={style}>
      {query === '' && selected && <span id={selectedId} className="orbit-combobox-value">{renderValue?.(selected.value, selected) ?? selected.label}</span>}
      <BaseCombobox.Input {...aria} aria-describedby={[aria['aria-describedby'], query === '' && selected && selectedId].filter(Boolean).join(' ') || undefined}
        id={id} ref={ref} className="orbit-combobox-input" placeholder={selected ? undefined : placeholder} aria-busy={loading || undefined} />
      {loading ? <Spinner size="small" aria-hidden /> : showArrow && <BaseCombobox.Trigger className="orbit-combobox-toggle" tabIndex={-1} aria-label="Show options"><DownOutlined aria-hidden /></BaseCombobox.Trigger>}
      {clearable && value !== null && !disabled && <BaseCombobox.Clear className="orbit-choice-clear" tabIndex={0} aria-label={clearLabel}><CloseCircleFilled aria-hidden /></BaseCombobox.Clear>}
    </span>
    <BaseCombobox.Portal container={layer.container()}>
      <BaseCombobox.Positioner anchor={anchor} side={side} align={align} sideOffset={4} collisionPadding={8}
        className="orbit-floating-positioner orbit-choice-positioner" data-match-width={matchTriggerWidth} style={{ zIndex: layer.zIndex }}>
        <BaseCombobox.Popup className={`orbit-select-popup${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle} finalFocus={returnFocus}>
          <BaseCombobox.Empty className="orbit-select-empty" role="status">{emptyContent}</BaseCombobox.Empty>
          <BaseCombobox.List className="orbit-select-list">
            {grouped ? (group: { label: string; items: SelectOption<Value>[] }) => <BaseCombobox.Group key={group.label || group.items[0]?.value} items={group.items}>
              {group.label && <BaseCombobox.GroupLabel className="orbit-select-group-label">{group.label}</BaseCombobox.GroupLabel>}
              <BaseCombobox.Collection>{item}</BaseCombobox.Collection>
            </BaseCombobox.Group> : item}
          </BaseCombobox.List>
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  </BaseCombobox.Root>;
}
