// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

/**
 * The icon an avatar falls back to while there is no picture: the account menu's person, as the replaced
 * icon avatar drew it — straight in the centring box, at half the avatar's size, and gone once a picture
 * loads; back when the picture fails.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root!.render(node));
}

const avatar = () => container!.querySelector<HTMLElement>('.orbit-avatar')!;
const icon = <svg className="person" aria-hidden />;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
});

describe('Avatar icon', () => {
  it('draws the icon in place of the text, sized to half the avatar', async () => {
    await render(<Avatar size={36} icon={icon} style={{ background: 'var(--brand)' }}>Ignored</Avatar>);
    expect(avatar().classList.contains('orbit-avatar-icon')).toBe(true);
    expect(avatar().firstElementChild?.classList.contains('person')).toBe(true);
    expect(avatar().querySelector('.orbit-avatar-string')).toBeNull();
    expect(avatar().textContent).toBe('');
    expect(avatar().style.fontSize).toBe('18px');
    expect(avatar().style.width).toBe('36px');
    expect(avatar().style.background).toBe('var(--brand)');
  });

  it('gives way to a picture, and comes back when the picture fails', async () => {
    await render(<Avatar size={32} src="blob:photo" icon={icon} />);
    const img = avatar().querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:photo');
    expect(avatar().querySelector('.person')).toBeNull();
    expect(avatar().classList.contains('orbit-avatar-image')).toBe(true);
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(avatar().querySelector('img')).toBeNull();
    expect(avatar().querySelector('.person')).not.toBeNull();
    expect(avatar().style.fontSize).toBe('16px');
  });

  it('leaves a text avatar as it was', async () => {
    await render(<Avatar size={64} style={{ fontSize: 28 }}>B</Avatar>);
    expect(avatar().classList.contains('orbit-avatar-icon')).toBe(false);
    expect(avatar().querySelector('.orbit-avatar-string')?.textContent).toBe('B');
    expect(avatar().style.fontSize).toBe('28px');
  });
});
