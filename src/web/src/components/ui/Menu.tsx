import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { CheckOutlined, RightOutlined } from '@ant-design/icons';
import { useFloating, type FloatingProps } from './Floating';
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
}

function Submenu({ item, contents, container, zIndex }: { item: MenuAction; contents: ReactNode; container: () => HTMLElement; zIndex: number }) {
  const layer = useFloating({});
  return <BaseMenu.SubmenuRoot open={layer.open} onOpenChange={layer.setOpen}>
    <BaseMenu.SubmenuTrigger className="orbit-menu-item" label={item.textValue}>{contents}<RightOutlined className="orbit-menu-submenu-icon" aria-hidden /></BaseMenu.SubmenuTrigger>
    <BaseMenu.Portal container={container()}>
      <BaseMenu.Positioner side="right" align="start" sideOffset={4} collisionPadding={8} className="orbit-floating-positioner" style={{ zIndex: zIndex + 1 }}>
        <BaseMenu.Popup className="orbit-menu" onClick={(event) => event.stopPropagation()}><Items items={item.children!} container={container} zIndex={zIndex + 1} /></BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.SubmenuRoot>;
}

function Items({ items, container, zIndex }: { items: MenuItem[]; container: () => HTMLElement; zIndex: number }) {
  return items.map((item) => {
    if (item.type === 'separator') return <BaseMenu.Separator key={item.key} className="orbit-menu-separator" />;
    if (item.type === 'group') return <BaseMenu.Group key={item.key}>
      <BaseMenu.GroupLabel className="orbit-menu-group-label">{item.label}</BaseMenu.GroupLabel>
      <Items items={item.children ?? []} container={container} zIndex={zIndex} />
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

export function Menu({ trigger, items, disabled, variant = 'default', side = 'bottom', align = 'start',
  popupClassName, popupStyle, returnFocus, ...state }: MenuProps) {
  const layer = useFloating(state);
  const anchor = useRef<HTMLButtonElement>(null);
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
    <BaseMenu.Trigger ref={anchor} render={trigger} disabled={disabled} onClick={(event) => event.stopPropagation()} />
    <BaseMenu.Portal container={layer.container()}>
      <BaseMenu.Positioner side={side} align={align} sideOffset={4} collisionPadding={8} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex }}>
        <BaseMenu.Popup finalFocus={returnFocus} className={`orbit-menu${popupClassName ? ` ${popupClassName}` : ''}`} data-variant={variant} onClick={(event) => event.stopPropagation()}
          style={{ '--orbit-menu-anchor-width': anchorWidth === undefined ? undefined : `${anchorWidth}px`, ...popupStyle } as CSSProperties}>
          <Items items={items} container={layer.container} zIndex={layer.zIndex} />
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}
