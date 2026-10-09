import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { CheckOutlined, RightOutlined } from '@ant-design/icons';
import { useDropdownPlacement, useFloating, useSubmenuPlacement, type FloatingProps } from './Floating';
import './Floating.css';

interface MenuAction {
  key: string;
  label: ReactNode;
  textValue?: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  closeOnSelect?: boolean;
  /** A checked item exposes checkbox semantics and stays open by default. */
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  children?: MenuItem[];
  type?: 'item';
}
export type MenuItem = MenuAction | { type: 'separator'; key: string }
  | { type: 'group'; key: string; label: ReactNode; children?: MenuItem[] };

export interface MenuProps extends FloatingProps {
  trigger: ReactElement;
  items: MenuItem[];
  disabled?: boolean;
  /** The composer's existing phone attachment density; desktop stays compact. */
  variant?: 'default' | 'attachment';
  /** False leaves ↑ and ↓ on the closed trigger to the page, as the replaced dropdown's trigger did (the Tasks
   *  page steps through its rows with them); Enter, Space and a click still open it, and the open menu keeps its
   *  arrows. */
  openOnArrowKeys?: boolean;
}

/**
 * Base UI moves focus into an opened menu on the next animation frame. Until then keys reach its trigger, which
 * would act on them itself: restart the highlight (arrows), close the menu without running an item (Enter), tab on
 * from the trigger. So hand them to `target`, the item focus is moving to, where they act as in the menu: Tab
 * moves focus there and lets the browser tab on from it; the other keys are dispatched to it and focus is left to
 * Base UI, as an arrow that wraps round the menu moves it a frame later and a key pressed before then must come
 * back here, not run the item it left.
 */
function handOver(event: ReactKeyboardEvent<HTMLElement> & { preventBaseUIHandler(): void }, target: HTMLElement, keys: string[]) {
  if (!keys.includes(event.key)) return;
  if (event.key === 'Tab' && !event.shiftKey) {
    target.focus({ preventScroll: true });
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.preventBaseUIHandler();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, code: event.code, bubbles: true, cancelable: true,
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey }));
}

function Submenu({ item, contents, container, zIndex }: { item: MenuAction; contents: ReactNode; container: () => HTMLElement | undefined; zIndex: number }) {
  const layer = useFloating({});
  const anchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const { positioner, ...placement } = useSubmenuPlacement(anchor);
  return <BaseMenu.SubmenuRoot open={layer.open} onOpenChange={layer.setOpen}>
    <BaseMenu.SubmenuTrigger ref={anchor} className="orbit-menu-item" label={item.textValue} onKeyDown={(event) => {
      // Opened from the keyboard, the submenu highlights its first item before focus moves into it; until then
      // the parent menu would take these keys, an arrow, Home or End moving to another of its items for the next
      // Enter to run. Opened by hover, nothing in it is highlighted and the keys stay the parent's.
      const target = layer.open ? popup.current?.querySelector<HTMLElement>('[data-highlighted]') : null;
      if (!target) return;
      // An item run from here takes focus as it runs; doing that while the menus close stops Base UI giving
      // focus back to the menu button, so Enter and Space first move focus to the item, as the next frame would.
      if (event.key === 'Enter' || event.key === ' ') target.focus({ preventScroll: true });
      handOver(event, target, ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'ArrowLeft', 'Tab']);
    }}>{contents}<RightOutlined className="orbit-menu-submenu-icon" aria-hidden /></BaseMenu.SubmenuTrigger>
    <BaseMenu.Portal container={container()}>
      <BaseMenu.Positioner ref={positioner} side="right" align="start" {...placement} collisionPadding={8} positionMethod={layer.positionMethod} className="orbit-floating-positioner" style={{ zIndex: zIndex + 1 }}>
        <BaseMenu.Popup ref={popup} className="orbit-menu" onClick={(event) => event.stopPropagation()}><Items items={item.children!} container={container} zIndex={zIndex + 1} /></BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.SubmenuRoot>;
}

function Items({ items, container, zIndex }: { items: MenuItem[]; container: () => HTMLElement | undefined; zIndex: number }) {
  return items.map((item) => {
    if (item.type === 'separator') return <BaseMenu.Separator key={item.key} className="orbit-menu-separator" />;
    if (item.type === 'group') return <BaseMenu.Group key={item.key}>
      <BaseMenu.GroupLabel className="orbit-menu-group-label">{item.label}</BaseMenu.GroupLabel>
      <div className="orbit-menu-group-list"><Items items={item.children ?? []} container={container} zIndex={zIndex} /></div>
    </BaseMenu.Group>;
    const contents = <>
      {item.icon != null && <span className="orbit-menu-icon" aria-hidden>{item.icon}</span>}
      <span className="orbit-menu-label">{item.label}</span>
    </>;
    const common = { className: 'orbit-menu-item', disabled: item.disabled, label: item.textValue,
      'data-danger': item.danger || undefined, 'data-selected': item.selected || undefined };
    // Disabled actions remain readable but are outside arrow-key navigation,
    // matching the existing workspace menus. They register no selectable item.
    if (item.disabled) return <div key={item.key} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-disabled="true" aria-checked={item.checked} className="orbit-menu-item" data-disabled>{contents}</div>;
    if (item.children) return <Submenu key={item.key} item={item} contents={contents} container={container} zIndex={zIndex} />;
    if (item.checked !== undefined) return <BaseMenu.CheckboxItem key={item.key} {...common}
      checked={item.checked} onCheckedChange={item.onCheckedChange} onClick={item.onSelect} closeOnClick={item.closeOnSelect ?? false}>
      {contents}<BaseMenu.CheckboxItemIndicator className="orbit-menu-check" keepMounted><CheckOutlined aria-hidden /></BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>;
    return <BaseMenu.Item key={item.key} {...common} onClick={item.onSelect} closeOnClick={item.closeOnSelect ?? true}>{contents}</BaseMenu.Item>;
  });
}

export function Menu({ trigger, items, disabled, variant = 'default', openOnArrowKeys = true, side = 'bottom', align = 'start',
  popupClassName, popupStyle, returnFocus, ...state }: MenuProps) {
  const layer = useFloating(state);
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const { positioner, ...placement } = useDropdownPlacement(layer.open, anchor, 4, align);
  const [anchorWidth, setAnchorWidth] = useState<number>();
  useLayoutEffect(() => {
    if (!layer.open || !anchor.current) return;
    const node = anchor.current;
    const measure = () => setAnchorWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layer.open]);
  return <BaseMenu.Root open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <BaseMenu.Trigger ref={anchor} render={trigger} disabled={disabled} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      // Keys that beat the focus move go to the highlighted item, else the menu, as Select's do: Home and End
      // move the highlight before an Enter runs it, and Tab and Shift+Tab leave the menu and close it, as they
      // do with focus in it (the menu convention).
      const menu = popup.current;
      if (layer.open && menu) handOver(event, menu.querySelector<HTMLElement>('[data-highlighted]') ?? menu, ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Tab']);
      // Not opening on the arrows: Base UI's handler, which would open the menu and stop the key, is skipped, so the
      // key goes on to the page's own handler.
      else if (!layer.open && !openOnArrowKeys && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) event.preventBaseUIHandler();
    }} />
    <BaseMenu.Portal container={layer.container()}>
      <BaseMenu.Positioner ref={positioner} side={side} align={align} {...placement} positionMethod={layer.positionMethod} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex }}>
        <BaseMenu.Popup ref={popup} finalFocus={returnFocus} className={`orbit-menu${popupClassName ? ` ${popupClassName}` : ''}`} data-variant={variant} onClick={(event) => event.stopPropagation()}
          style={{ '--orbit-menu-anchor-width': anchorWidth === undefined ? undefined : `${anchorWidth}px`, ...popupStyle } as CSSProperties}>
          <Items items={items} container={layer.container} zIndex={layer.zIndex} />
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}
