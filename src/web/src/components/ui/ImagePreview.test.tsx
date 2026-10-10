// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Image } from './Image';
import { ImagePreview, type ImagePreviewItem } from './ImagePreview';

/**
 * The picture viewer the replaced Image and Image.PreviewGroup opened, and the thumbnail that opens it on its own.
 * What it does is what a reader does with it: page a group with the arrows or ←/→ (stopping at either end), zoom
 * with the buttons, the wheel and a double click, turn and flip, drag, and close with the button, Esc or a press on
 * the mask — never on the picture — with focus back where it was. Geometry is the browser comparison's
 * (ui-migration/p52.browser.mjs); here jsdom lays nothing out, so a zoom is read from the transform it asks for.
 */

const ITEMS: ImagePreviewItem[] = [
  { src: 'blob:first', alt: 'First screen' },
  { src: 'blob:second', alt: 'Second screen' },
  { src: 'blob:third', alt: 'Third screen' },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  await settle();
}

/** A group held by its caller, as the transcript holds it. */
function Group({ onClose, start = 1, group = true }: { onClose?: () => void; start?: number; group?: boolean }) {
  const [open, setOpen] = useState(true);
  const [current, setCurrent] = useState(start);
  return (
    <>
      <button type="button" className="opener" onClick={() => setOpen(true)}>Open</button>
      <ImagePreview
        group={group}
        open={open}
        items={group ? ITEMS : ITEMS.slice(0, 1)}
        current={current}
        onCurrentChange={setCurrent}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      />
    </>
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const picture = () => dialog()!.querySelector<HTMLImageElement>('img')!;
const button = (name: string) => document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${name}"]`);
const position = () => dialog()?.querySelector('.orbit-image-preview-progress')?.textContent ?? null;

async function click(element: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  await settle();
}

async function key(target: Element, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A frame is the next task: transform changes made within one land together in it.
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => setTimeout(() => frame(performance.now()), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ImagePreview', () => {
  it('opens on the picture asked for, named by it, with focus on Close and the position under it', async () => {
    await render(<Group />);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-label')).toBe('Second screen');
    expect(picture().getAttribute('src')).toBe('blob:second');
    expect(position()).toBe('2 / 3');
    expect(document.activeElement).toBe(button('Close'));
    // The controls, in the replaced preview's order.
    expect([...dialog()!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Close', 'Previous image', 'Next image', 'Flip vertically', 'Flip horizontally', 'Rotate left', 'Rotate right', 'Zoom out', 'Zoom in',
    ]);
  });

  it('pages with the arrows and with ←/→, and stops at either end', async () => {
    await render(<Group />);
    await click(button('Next image')!);
    expect(picture().getAttribute('src')).toBe('blob:third');
    expect(position()).toBe('3 / 3');
    expect(button('Next image')!.disabled).toBe(true);
    await key(button('Close')!, 'ArrowRight');
    expect(position()).toBe('3 / 3');
    await key(button('Close')!, 'ArrowLeft');
    await key(button('Close')!, 'ArrowLeft');
    expect(picture().getAttribute('src')).toBe('blob:first');
    expect(position()).toBe('1 / 3');
    expect(button('Previous image')!.disabled).toBe(true);
    await click(button('Previous image')!);
    expect(position()).toBe('1 / 3');
  });

  it('shows a single picture with neither the position nor the arrows, and ←/→ do nothing', async () => {
    await render(<Group group={false} start={0} />);
    expect(position()).toBeNull();
    expect(button('Previous image')).toBeNull();
    expect(button('Next image')).toBeNull();
    await key(button('Close')!, 'ArrowRight');
    expect(picture().getAttribute('src')).toBe('blob:first');
  });

  it('zooms with the buttons, the wheel and a double click, and never below its own size', async () => {
    await render(<Group />);
    expect(button('Zoom out')!.disabled).toBe(true);
    await click(button('Zoom in')!);
    expect(picture().style.transform).toContain('scale3d(1.5, 1.5, 1)');
    expect(button('Zoom out')!.disabled).toBe(false);
    await click(button('Zoom out')!);
    expect(picture().style.transform).toContain('scale3d(1, 1, 1)');
    expect(picture().style.transform).toContain('translate3d(0px, 0px, 0)');
    await act(async () => {
      picture().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 10, clientY: 10, bubbles: true }));
    });
    await settle();
    expect(picture().style.transform).toContain('scale3d(1.5, 1.5, 1)');
    await act(async () => {
      picture().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    expect(picture().style.transform).toBe('translate3d(0px, 0px, 0) scale3d(1, 1, 1) rotate(0deg)');
    await act(async () => {
      picture().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    expect(picture().style.transform).toContain('scale3d(1.5, 1.5, 1)');
  });

  it('turns and flips the picture', async () => {
    await render(<Group />);
    await click(button('Rotate right')!);
    expect(picture().style.transform).toContain('rotate(90deg)');
    await click(button('Rotate left')!);
    await click(button('Rotate left')!);
    expect(picture().style.transform).toContain('rotate(-90deg)');
    await click(button('Flip horizontally')!);
    expect(picture().style.transform).toContain('scale3d(-1, 1, 1)');
    await click(button('Flip vertically')!);
    expect(picture().style.transform).toContain('scale3d(-1, -1, 1)');
  });

  it('shows the next picture at its own size, at once', async () => {
    await render(<Group />);
    await click(button('Zoom in')!);
    await click(button('Rotate right')!);
    // The switch itself does not animate: the reset lands with the transition off, and it comes back on after.
    const seen: string[] = [];
    const styles = new MutationObserver((records) => seen.push(...records.map((record) => record.oldValue ?? '')));
    styles.observe(picture(), { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    await click(button('Next image')!);
    seen.push(...styles.takeRecords().map((record) => record.oldValue ?? ''));
    styles.disconnect();
    expect(seen.some((style) => style.includes('scale3d(1, 1, 1) rotate(0deg)') && style.includes('transition-duration: 0s'))).toBe(true);
    expect(picture().getAttribute('src')).toBe('blob:third');
    expect(picture().style.transform).toBe('translate3d(0px, 0px, 0) scale3d(1, 1, 1) rotate(0deg)');
    expect(picture().style.transitionDuration).toBe('');
  });

  it('moves with a drag and settles back in the middle when it fits the window', async () => {
    await render(<Group />);
    await act(async () => {
      picture().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 130 }));
    });
    await settle();
    expect(dialog()!.classList.contains('orbit-image-preview-moving')).toBe(true);
    expect(picture().style.transform).toContain('translate3d(50px, 30px, 0)');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', {}));
    });
    await settle();
    expect(dialog()!.classList.contains('orbit-image-preview-moving')).toBe(false);
    // jsdom lays nothing out, so the picture "fits" and is centred again.
    expect(picture().style.transform).toContain('translate3d(0px, 0px, 0)');
  });

  it('closes on Esc, on Close and on the mask — not on the picture — and focus goes back where it was', async () => {
    const onClose = vi.fn();
    await render(<Group onClose={onClose} />);
    await click(picture());
    expect(onClose).not.toHaveBeenCalled();
    await click(dialog()!.querySelector('.orbit-image-preview-mask')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    const opener = container!.querySelector<HTMLButtonElement>('.opener')!;
    opener.focus();
    await click(opener);
    expect(document.activeElement).toBe(button('Close'));
    await key(button('Close')!, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await click(opener);
    await click(button('Close')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dialog()).toBeNull();
  });

  it('comes back at its own size after it was closed zoomed', async () => {
    await render(<Group />);
    await click(button('Zoom in')!);
    await click(button('Close')!);
    await click(container!.querySelector('.opener')!);
    expect(picture().style.transform).toBe('translate3d(0px, 0px, 0) scale3d(1, 1, 1) rotate(0deg)');
  });

  it('draws nothing while closed', async () => {
    await render(<ImagePreview open={false} items={ITEMS} onClose={() => {}} group />);
    expect(dialog()).toBeNull();
    expect(document.querySelector('.orbit-image-preview')).toBeNull();
  });
});

describe('Image', () => {
  async function thumbnail() {
    await render(<Image src="blob:diagram" alt="Layout diagram" className="md-image" cover={<span className="mask">Preview</span>} />);
    return container!.querySelector<HTMLElement>('[role="button"]')!;
  }

  it('is a button named by the picture, holding the picture and the cover drawn over it', async () => {
    const wrapper = await thumbnail();
    expect(wrapper.classList.contains('orbit-image')).toBe(true);
    expect(wrapper.getAttribute('aria-label')).toBe('Layout diagram');
    expect(wrapper.tabIndex).toBe(0);
    const img = wrapper.querySelector('img')!;
    expect(img.className).toBe('orbit-image-img md-image');
    expect(img.getAttribute('src')).toBe('blob:diagram');
    expect(img.getAttribute('alt')).toBe('Layout diagram');
    expect(wrapper.querySelector('.orbit-image-cover > .mask')?.textContent).toBe('Preview');
    expect(dialog()).toBeNull();
  });

  it('opens the picture on its own on a press, on Enter and on Space', async () => {
    const wrapper = await thumbnail();
    await click(wrapper.querySelector('.orbit-image-cover')!);
    expect(dialog()?.getAttribute('aria-label')).toBe('Layout diagram');
    expect(picture().getAttribute('src')).toBe('blob:diagram');
    expect(position()).toBeNull();
    expect(button('Next image')).toBeNull();
    await key(button('Close')!, 'Escape');
    expect(dialog()).toBeNull();

    await key(wrapper, 'Enter');
    expect(dialog()).not.toBeNull();
    await key(button('Close')!, 'Escape');
    await key(wrapper, ' ');
    expect(dialog()).not.toBeNull();
    await key(button('Close')!, 'Escape');
    await key(wrapper, 'a');
    expect(dialog()).toBeNull();
  });

  it('grows the viewer from the middle of what was pressed', async () => {
    const wrapper = await thumbnail();
    const cover = wrapper.querySelector<HTMLElement>('.orbit-image-cover')!;
    cover.getBoundingClientRect = () => ({ x: 100, y: 40, width: 200, height: 120, top: 40, left: 100, right: 300, bottom: 160, toJSON: () => ({}) });
    await click(cover);
    expect(dialog()!.querySelector<HTMLElement>('.orbit-image-preview-body')!.style.transformOrigin).toBe('200px 100px');
  });
});
