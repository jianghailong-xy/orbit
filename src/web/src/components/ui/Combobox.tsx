import { useId, useRef, useState, type CSSProperties, type Ref } from 'react';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { CloseCircleFilled, DownOutlined, LoadingOutlined, SearchOutlined } from '@ant-design/icons';
import { SelectEmpty } from './SelectEmpty';
import { ComboboxOption } from './ComboboxOption';
import { useAnchorWidth, useDropdownPlacement, useFloating } from './Floating';
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
  const anchorWidth = useAnchorWidth(layer.open, anchor);
  const { positioner, ...placement } = useDropdownPlacement(layer.open, anchor, 4, align);
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
    // Picking the option that is already chosen only closes the list, as with the select this replaces.
    const picked = next?.value ?? null;
    if (picked !== value) onValueChange(picked);
    updateQuery('');
  }} items={items} isItemEqualToValue={(a, b) => a.value === b.value}
    inputValue={query} onInputValueChange={(next, details) => {
      if (details.reason === 'input-change' || details.reason === 'input-clear') updateQuery(next);
    }} filter={filter ? (option: SelectOption<Value>, search: string) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()) : null}
    // Nothing chosen, the replaced select opened with its first option active (defaultActiveFirstOption),
    // so Enter picks it. Base UI's runtime takes 'always' for that; its Combobox typing omits the value.
    autoHighlight={(value === null ? 'always' : true) as boolean} name={name} disabled={disabled} open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <span ref={anchor} className={`orbit-select orbit-combobox${className ? ` ${className}` : ''}`} data-size={size} data-variant={variant} data-open={layer.open || undefined} data-disabled={disabled || undefined} style={style}>
      {/* One line box holds the value, its placeholder and the search input laid over them, as in the
          replaced select: it is what fades while the list is open, and it places the typed text. */}
      <span className="orbit-combobox-field" data-search={query !== '' || undefined}>
        {/* Kept in flow while a search is typed, only hidden, so an unsized field keeps its width. */}
        {selected && <span id={selectedId} className="orbit-combobox-value">{renderValue?.(selected.value, selected) ?? selected.label}</span>}
        {/* Drawn beside the input, not as its own placeholder: the input is lifted to 16px on narrow
            screens (no iOS focus zoom) while the hint keeps the field's size, as the replaced one did. */}
        {!selected && placeholder && <span className="orbit-combobox-value orbit-combobox-placeholder" aria-hidden>{placeholder}</span>}
        <BaseCombobox.Input {...aria} aria-describedby={[aria['aria-describedby'], query === '' && selected && selectedId].filter(Boolean).join(' ') || undefined}
          id={id} ref={ref} className="orbit-combobox-input" aria-placeholder={selected ? undefined : placeholder} aria-busy={loading || undefined} />
      </span>
      {/* As the replaced searchable select: a spinning arc while loading, a magnifier while open. */}
      {loading ? <LoadingOutlined spin className="orbit-choice-arrow" aria-hidden /> : showArrow && <BaseCombobox.Trigger className="orbit-combobox-toggle" tabIndex={-1} aria-label="Show options">{layer.open ? <SearchOutlined aria-hidden /> : <DownOutlined aria-hidden />}</BaseCombobox.Trigger>}
      {clearable && value !== null && !disabled && <BaseCombobox.Clear className="orbit-choice-clear" tabIndex={0} aria-label={clearLabel}><CloseCircleFilled aria-hidden /></BaseCombobox.Clear>}
    </span>
    <BaseCombobox.Portal container={layer.container()}>
      <BaseCombobox.Positioner ref={positioner} anchor={anchor} side={side} align={align} {...placement}
        className="orbit-floating-positioner orbit-choice-positioner" data-match-width={matchTriggerWidth}
        style={{ zIndex: layer.zIndex, '--orbit-choice-anchor-width': anchorWidth === undefined ? undefined : `${anchorWidth}px` } as CSSProperties}>
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
