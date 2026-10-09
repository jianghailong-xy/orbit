import { useRef, useState, type Ref } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { CheckOutlined, CloseCircleFilled, CloseOutlined, DownOutlined, SearchOutlined } from '@ant-design/icons';
import { flattenOptions, type SelectOption, type SelectProps } from './Select';
import { SelectEmpty } from './SelectEmpty';
import { ComboboxOption } from './ComboboxOption';
import { Spinner } from './Spinner';
import { useDropdownPlacement, useFloating } from './Floating';

export interface MultiSelectProps extends Omit<SelectProps, 'value' | 'onValueChange' | 'ref' | 'renderValue'> {
  value: string[];
  onValueChange: (value: string[]) => void;
  ref?: Ref<HTMLInputElement>;
  /** Tags are free-form entries; current email fields keep their popup closed. */
  mode?: 'multiple' | 'tags';
  maxTagCount?: number;
  searchValue?: string;
  onSearch?: (query: string) => void;
  tokenSeparators?: string[];
}

export function MultiSelect({ options, value, onValueChange, mode = 'multiple', maxTagCount,
  searchValue, onSearch, tokenSeparators = [], id, name, ref, disabled, loading, placeholder,
  clearable, clearLabel = 'Clear selection', size = 'middle', variant = 'outlined', showArrow = true,
  matchTriggerWidth = true, emptyContent = <SelectEmpty />, renderOption, className, style,
  open, onOpenChange, side = 'bottom', align = 'start', popupClassName, popupStyle, returnFocus, ...aria }: MultiSelectProps) {
  const [localQuery, setLocalQuery] = useState('');
  const query = searchValue ?? localQuery;
  const composing = useRef(false);
  const anchor = useRef<HTMLDivElement>(null);
  const updateQuery = (next: string) => { setLocalQuery(next); onSearch?.(next); };
  const layer = useFloating({ open, onOpenChange: (next) => { if (!next) updateQuery(''); onOpenChange?.(next); } });
  const { positioner, ...placement } = useDropdownPlacement(layer.open, anchor, 4, align);
  const flat = flattenOptions(options);
  const selected = value.map((entry) => flat.find((option) => option.value === entry) ?? { value: entry, label: entry });
  const visible = maxTagCount === undefined ? selected : selected.slice(0, maxTagCount);
  const addTags = (entries: string[], remainder: string) => {
    onValueChange([...new Set([...value, ...entries.map((entry) => entry.trim()).filter(Boolean)])]);
    updateQuery(remainder);
  };
  const inputQuery = (next: string) => {
    if (mode === 'tags' && !composing.current && tokenSeparators.some((separator) => next.includes(separator))) {
      const parts = tokenSeparators.reduce((entries, separator) => entries.flatMap((entry) => entry.split(separator)), [next]);
      const remainder = parts.pop() ?? '';
      addTags(parts, remainder);
    } else updateQuery(next);
  };
  const grouped = options.some((entry) => 'options' in entry);
  const items = grouped ? options.map((entry) => 'options' in entry ? { label: entry.label, items: entry.options } : { label: '', items: [entry] }) : flat;
  const item = (option: SelectOption) => <ComboboxOption key={option.value} option={option} className="orbit-select-option orbit-multi-option">
    <span className="orbit-select-option-label">{renderOption?.(option) ?? option.label}</span>
    <BaseCombobox.ItemIndicator className="orbit-multi-item-check"><CheckOutlined aria-hidden /></BaseCombobox.ItemIndicator>
  </ComboboxOption>;
  return <BaseCombobox.Root multiple value={selected} items={items} isItemEqualToValue={(a, b) => a.value === b.value}
    onValueChange={(next, details) => {
      if (details.reason === 'input-clear') return;
      onValueChange(next.map((option) => option.value)); updateQuery('');
    }} inputValue={query} onInputValueChange={(next, details) => {
      if (details.reason === 'input-change' || details.reason === 'input-clear') inputQuery(next);
    }} filter={(option: SelectOption, search) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())}
    // As the replaced multiple select: opening highlights the first option (Enter picks it); free tags don't.
    autoHighlight={(mode === 'tags' ? true : 'always') as boolean} name={name} disabled={disabled} open={layer.open} onOpenChange={(next, details) => {
      // AntD keeps a multiple picker open after selecting a search result.
      if (!next && details.reason === 'item-press') { details.cancel(); return; }
      layer.setOpen(next);
    }} modal={false}>
    <div ref={anchor} className={`orbit-select orbit-multi${className ? ` ${className}` : ''}`} data-size={size} data-variant={variant} data-disabled={disabled || undefined} style={style}>
      <BaseCombobox.Chips className="orbit-multi-chips">
        {visible.map((option) => <BaseCombobox.Chip key={option.value} className="orbit-multi-chip">
          <span className="orbit-multi-chip-label">{option.label}</span>
          {!disabled && <BaseCombobox.ChipRemove className="orbit-multi-chip-remove" aria-label={`Remove ${option.label}`}><CloseOutlined aria-hidden /></BaseCombobox.ChipRemove>}
        </BaseCombobox.Chip>)}
        {visible.length < selected.length && <span className="orbit-multi-chip" aria-label={`${selected.length - visible.length} more selected`}><span className="orbit-multi-chip-label">{`+ ${selected.length - visible.length} ...`}</span></span>}
        <span className="orbit-multi-input-wrap">
          <span className="orbit-multi-measure" aria-hidden>{query || '\u200b'}</span>
          <BaseCombobox.Input {...aria} id={id} ref={ref} className="orbit-combobox-input" aria-busy={loading || undefined}
            onBlur={() => { if (mode === 'tags' && !composing.current && query.trim()) addTags([query], ''); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(event) => { composing.current = false; inputQuery(event.currentTarget.value); }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (mode === 'tags' && event.key === 'Enter' && query.trim()) {
                event.preventDefault(); event.preventBaseUIHandler(); addTags([query], '');
              } else if (event.key === 'Backspace' && !query && value.length) {
                event.preventDefault(); event.preventBaseUIHandler(); onValueChange(value.slice(0, -1));
              }
            }} />
        </span>
        {value.length === 0 && !query && <span className="orbit-multi-placeholder">{placeholder}</span>}
      </BaseCombobox.Chips>
      {/* As the replaced searchable select: a magnifier while open. */}
      {loading ? <Spinner size="small" aria-hidden /> : showArrow && <BaseCombobox.Trigger className="orbit-combobox-toggle" tabIndex={-1} aria-label="Show options">{layer.open && mode === 'multiple' ? <SearchOutlined aria-hidden /> : <DownOutlined aria-hidden />}</BaseCombobox.Trigger>}
      {clearable && value.length > 0 && !disabled && <BaseCombobox.Clear className="orbit-choice-clear" tabIndex={0} aria-label={clearLabel}><CloseCircleFilled aria-hidden /></BaseCombobox.Clear>}
    </div>
    <BaseCombobox.Portal container={layer.container()}>
      <BaseCombobox.Positioner ref={positioner} anchor={anchor} side={side} align={align} {...placement} positionMethod={layer.positionMethod}
        className="orbit-floating-positioner orbit-choice-positioner" data-match-width={matchTriggerWidth} style={{ zIndex: layer.zIndex }}>
        <BaseCombobox.Popup className={`orbit-select-popup${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle} finalFocus={returnFocus}>
          <BaseCombobox.Empty className="orbit-select-empty" role="status">{emptyContent}</BaseCombobox.Empty>
          <BaseCombobox.List className="orbit-select-list">
            {grouped ? (group: { label: string; items: SelectOption[] }) => <BaseCombobox.Group key={group.label || group.items[0]?.value} items={group.items}>
              {group.label && <BaseCombobox.GroupLabel className="orbit-select-group-label">{group.label}</BaseCombobox.GroupLabel>}
              <BaseCombobox.Collection>{item}</BaseCombobox.Collection>
            </BaseCombobox.Group> : item}
          </BaseCombobox.List>
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  </BaseCombobox.Root>;
}
