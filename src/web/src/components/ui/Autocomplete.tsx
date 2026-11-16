import { useRef, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from 'react';
import { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete';
import { useAnchorWidth, useDropdownPlacement, useFloating } from './Floating';
import './TextControls.css';

export interface AutocompleteProps<Item> extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'value' | 'onChange' | 'prefix'> {
  /** What the field holds: free text, which picking a suggestion replaces with `itemToValue` of it. */
  value: string;
  onValueChange: (value: string) => void;
  /** The suggestions to show for `value`, already filtered by the caller; none keeps the list closed. */
  items: readonly Item[];
  itemToValue: (item: Item) => string;
  renderItem: (item: Item) => ReactNode;
  /** Words above the suggestions, which the arrow keys don't reach. */
  header?: ReactNode;
  size?: 'small' | 'middle' | 'large';
  invalid?: boolean;
}

/**
 * A text field that offers suggestions under it: typing stays free, and picking one (click, or ↑/↓ and Enter) fills
 * the field with it. Nothing is highlighted until the arrow keys move, so Enter in the field still submits its form.
 */
export function Autocomplete<Item>({
  value, onValueChange, items, itemToValue, renderItem, header, size = 'middle', invalid = false, className, style,
  disabled, ...inputProps
}: AutocompleteProps<Item>) {
  const layer = useFloating({});
  const anchor = useRef<HTMLSpanElement>(null);
  const shown = layer.open && items.length > 0 && !disabled;
  const anchorWidth = useAnchorWidth(shown, anchor);
  const { positioner, ...placement } = useDropdownPlacement(shown, anchor, 4, 'start');
  return (
    <BaseAutocomplete.Root
      items={items}
      filter={null}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      itemToStringValue={itemToValue}
      open={shown}
      onOpenChange={layer.setOpen}
      openOnInputClick
      disabled={disabled}
      modal={false}
    >
      <span ref={anchor} className={['orbit-autocomplete', className].filter(Boolean).join(' ')} style={style}>
        <BaseAutocomplete.Input
          {...inputProps}
          className="orbit-text-control orbit-input"
          data-size={size}
          data-invalid={invalid ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
          aria-invalid={invalid || undefined}
        />
      </span>
      <BaseAutocomplete.Portal container={layer.container()}>
        <BaseAutocomplete.Positioner
          ref={positioner}
          anchor={anchor}
          side="bottom"
          align="start"
          {...placement}
          positionMethod={layer.positionMethod}
          className="orbit-floating-positioner orbit-choice-positioner"
          data-match-width
          style={{
            zIndex: layer.zIndex,
            '--orbit-choice-anchor-width': anchorWidth === undefined ? undefined : `${anchorWidth}px`,
          } as CSSProperties}
        >
          <BaseAutocomplete.Popup className="orbit-select-popup orbit-autocomplete-popup">
            {header}
            <BaseAutocomplete.List className="orbit-select-list">
              {(item: Item) => (
                <AutocompleteItem key={itemToValue(item)} item={item}>
                  {renderItem(item)}
                </AutocompleteItem>
              )}
            </BaseAutocomplete.List>
          </BaseAutocomplete.Popup>
        </BaseAutocomplete.Positioner>
      </BaseAutocomplete.Portal>
    </BaseAutocomplete.Root>
  );
}

/** As ComboboxOption: Base UI 1.8 cancels pointerdown, which suppresses WebKit's touch click, so a touch keeps its
 *  native click and skips the mouseup fallback, and a tap picks once. */
function AutocompleteItem<Item>({ item, children }: { item: Item; children: ReactNode }) {
  const touch = useRef(false);
  return (
    <BaseAutocomplete.Item
      value={item}
      className="orbit-select-option"
      onPointerDownCapture={(event) => {
        touch.current = event.pointerType === 'touch';
        if (touch.current) event.preventBaseUIHandler();
      }}
      onMouseUp={(event) => {
        if (touch.current) event.preventBaseUIHandler();
      }}
    >
      {children}
    </BaseAutocomplete.Item>
  );
}
