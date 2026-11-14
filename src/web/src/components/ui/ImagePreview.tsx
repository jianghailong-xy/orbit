import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type TouchEvent as ReactTouchEvent } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import {
  CloseOutlined,
  CompressOutlined,
  LeftOutlined,
  OneToOneOutlined,
  RightOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  SwapOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { registerFeedbackLayer } from './feedbackPortal';
import { useOverlayChild } from './Overlay';
import './ImagePreview.css';

export interface ImagePreviewItem {
  /** Absent while its bytes are still being read: the viewer waits on an empty frame. */
  src?: string;
  alt?: string;
}

/** A button in the pill under the picture. */
export interface ImagePreviewAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export interface ImagePreviewProps {
  open: boolean;
  /** Close button, Esc, or a press on the dark area around the picture. */
  onClose: () => void;
  items: readonly ImagePreviewItem[];
  /** Which item is shown; ←/→ and the arrows ask for another with onCurrentChange. */
  current?: number;
  onCurrentChange?: (index: number) => void;
  /** A set of pictures paged together: "n / total" under the picture and, with more than one, the arrows. */
  group?: boolean;
  /** Where the opening zoom grows from, in viewport pixels: the centre of the thumbnail that was pressed. */
  origin?: { x: number; y: number } | null;
  /** How a group states its position, given the shown picture's number and the total. `n / total` by default. */
  position?: (shown: number, total: number) => string;
  /** What the picture is, under the position. It gets a line of its own, and the picture moves up to leave it room. */
  caption?: ReactNode;
  /** More buttons, after the zoom buttons. */
  actions?: readonly ImagePreviewAction[];
}

// ── zoom, drag and pinch ──────────────────────────────────────────────────────────────────────────
// The replaced preview's own arithmetic (rc-image, MIT, see ./rc-image.LICENSE), so a button, the wheel, a double
// click, a drag or a pinch moves the picture exactly as it did.

type Transform = { x: number; y: number; rotate: number; scale: number; flipX: boolean; flipY: boolean };
type Point = { x: number; y: number };
const INITIAL: Transform = { x: 0, y: 0, rotate: 0, scale: 1, flipX: false, flipY: false };
const SCALE_STEP = 0.5;
const MAX_SCALE = 50;
/** A wheel or a trackpad that scrolls by lines moves the picture this many pixels a line. */
const LINE_PX = 16;

/**
 * Scale 1 is the picture's actual size: one of its pixels on one of the screen's, which is how a screenshot or a
 * board rendered at 2x was taken, so its words read at the size they were written. A picture opens at its actual size
 * or at the size the viewer always gave it (see fitScale), whichever is larger, so none opens smaller than it used to:
 * one larger than the window opens from its top (and its left edge when it is wider) and scrolls, and a 1x picture
 * still fills the room it filled. The fit button and a double click go between the two. A touch screen opens at the
 * fit, as a phone holds a board too small to read at its actual size either way.
 */
const opensWhole = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;

/**
 * Where a picture of `size` rests on one axis of the area from `start` to `end`, whose part above the footer ends at
 * `visibleEnd`: centred when it fits (lifted clear of the footer if need be), else `offset` held so the picture covers
 * the area with no gap at either edge. The offset is from the area's centre, where the picture's box is laid out.
 */
function rest(size: number, start: number, end: number, visibleEnd: number, offset: number): number {
  const center = (start + end) / 2;
  if (size <= visibleEnd - start) return Math.min(0, visibleEnd - center - size / 2);
  return Math.min(start - center + size / 2, Math.max(visibleEnd - center - size / 2, offset));
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pinchCenter(old1: Point, old2: Point, new1: Point, new2: Point): [number, number] {
  const moved1 = distance(old1, new1);
  const moved2 = distance(old2, new2);
  if (moved1 === 0 && moved2 === 0) return [old1.x, old1.y];
  const ratio = moved1 / (moved1 + moved2);
  return [old1.x + ratio * (old2.x - old1.x), old1.y + ratio * (old2.y - old1.y)];
}

function useImageTransform(
  image: RefObject<HTMLImageElement | null>,
  minScale: () => number,
  rested: (transform: Transform) => Transform,
) {
  const frame = useRef<number | null>(null);
  const queue = useRef<Transform[]>([]);
  const [transform, setTransform] = useState<Transform>(INITIAL);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  const reset = (to: Transform = INITIAL) => setTransform(to);
  /** The transform as it will be next frame: the last change asked for in this one, else the one drawn. */
  const latest = () => queue.current[queue.current.length - 1] ?? transform;
  // Changes made within one frame land together in the next. Each is the transform it was worked out from plus its
  // own change, so the last one made wins.
  const update = (next: Partial<Transform>) => {
    if (frame.current === null) {
      queue.current = [];
      frame.current = requestAnimationFrame(() => {
        setTransform((state) => {
          let merged = state;
          for (const queued of queue.current) merged = { ...merged, ...queued };
          frame.current = null;
          queue.current = [];
          return merged;
        });
      });
    }
    queue.current.push({ ...latest(), ...next });
  };
  /** Scale by `ratio` around a point (the window's centre by default), keeping that point where it is. */
  const zoom = (ratio: number, centerX?: number, centerY?: number, isTouch = false) => {
    const img = image.current;
    if (!img) return;
    const current = latest();
    const min = minScale();
    const { width, height, offsetLeft, offsetTop } = img;
    let newRatio = ratio;
    let newScale = current.scale * ratio;
    if (newScale > MAX_SCALE) {
      newScale = MAX_SCALE;
      newRatio = MAX_SCALE / current.scale;
    } else if (newScale < min) {
      // A pinch may go below the minimum while the fingers are down; it springs back when they lift.
      newScale = isTouch ? newScale : min;
      newRatio = newScale / current.scale;
    }
    const diffRatio = newRatio - 1;
    const diffImgX = diffRatio * width * 0.5;
    const diffImgY = diffRatio * height * 0.5;
    const diffOffsetLeft = diffRatio * ((centerX ?? innerWidth / 2) - current.x - offsetLeft);
    const diffOffsetTop = diffRatio * ((centerY ?? innerHeight / 2) - current.y - offsetTop);
    const next = { ...current, x: current.x - (diffOffsetLeft - diffImgX), y: current.y - (diffOffsetTop - diffImgY), scale: newScale };
    update(isTouch ? next : rested(next));
  };
  return { transform, reset, update, zoom, latest };
}

// ── the preview ───────────────────────────────────────────────────────────────────────────────────

/**
 * The full-screen picture viewer the replaced Image and Image.PreviewGroup opened: the picture on a dark mask, a
 * close button top right, previous/next arrows at the sides of a group, and under the picture the position in the
 * group, the flip, rotate and zoom buttons, the scale and the actual size / fit button. A picture opens at its actual
 * size (see opensWhole); the wheel scrolls one larger than the window, ⌘ or Ctrl with the wheel (a trackpad's pinch)
 * zooms, a double click goes between the actual size and the whole picture, a drag moves it, and a touch pinches and
 * moves it; ←/→ page a group. Esc, the close button or a press on the mask
 * closes it, and focus goes back where it was.
 */
export function ImagePreview({ open, onClose, items, current = 0, onCurrentChange, group = false, origin, position, caption, actions: moreActions = [] }: ImagePreviewProps) {
  const layer = useOverlayChild(open, onClose);
  const image = useRef<HTMLImageElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const count = items.length;
  const item = items[current];
  const switches = group && count > 1;
  /** The picture's actual size in CSS pixels, once it has loaded. */
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const size = natural && natural.src === item?.src ? natural : null;

  /** Where the picture's area is in the window, from layout: its rect would be the opening zoom's, which starts at
   *  scale 0, and a picture that loads from the cache lands during it. */
  const areaRect = () => {
    const el = body.current;
    if (!el) return null;
    const left = el.offsetLeft;
    const top = el.offsetTop;
    return { left, top, width: el.offsetWidth, height: el.offsetHeight, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
  };
  /** The size the viewer gave a picture before it knew actual size, as a scale: the whole picture, as turned, in the
   *  window's width and 70% of its height (the room above the footer when captioned), and never above one of its
   *  pixels to a CSS pixel. Below 1 for a picture larger than the window, above 1 for a 1x picture on a 2x screen. */
  const fitScale = (rotate: number) => {
    const area = areaRect();
    if (!size || !area || !area.width || !area.height) return 1;
    const turned = rotate % 180 !== 0;
    const width = turned ? size.height : size.width;
    const height = turned ? size.width : size.height;
    return Math.min(window.devicePixelRatio || 1, area.width / width, (area.height * (caption != null ? 1 : 0.7)) / height);
  };
  /** Where a picture comes to rest: see rest(), on each axis of the area it is laid out in. */
  const rested = (next: Transform): Transform => {
    const img = image.current;
    const area = areaRect();
    if (!img || !area) return next;
    const turned = next.rotate % 180 !== 0;
    const width = (turned ? img.offsetHeight : img.offsetWidth) * next.scale;
    const height = (turned ? img.offsetWidth : img.offsetHeight) * next.scale;
    const foot = footer.current;
    const visibleBottom = foot && foot.offsetHeight ? Math.min(area.bottom, foot.getBoundingClientRect().top - 16) : area.bottom;
    return {
      ...next,
      x: rest(width, area.left, area.right, area.right, next.x),
      y: rest(height, area.top, area.bottom, visibleBottom, next.y),
    };
  };
  const { transform, reset, update, zoom, latest } = useImageTransform(image, () => Math.min(1, fitScale(latest().rotate)), rested);
  const [transition, setTransition] = useState(true);
  const [moving, setMoving] = useState(false);
  const [touching, setTouching] = useState(false);
  const drag = useRef({ diffX: 0, diffY: 0, transformX: 0, transformY: 0 });
  const touch = useRef<{ point1: Point; point2: Point; eventType: 'none' | 'move' | 'touchZoom' }>({
    point1: { x: 0, y: 0 },
    point2: { x: 0, y: 0 },
    eventType: 'none',
  });

  // A switch shows the next picture at its own size at once; the frame after, zooming animates again.
  useEffect(() => {
    if (!transition) setTransition(true);
  }, [transition]);
  useEffect(() => {
    if (!open) {
      reset();
      setNatural(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A picture that has loaded is laid out at its actual size, then put where it opens: at that size from its top-left
  // corner, or whole on a touch screen (rested() centres whatever fits).
  const onLoad = () => {
    const img = image.current;
    if (!img || !item?.src || !img.naturalWidth) return;
    const ratio = window.devicePixelRatio || 1;
    setNatural({ src: item.src, width: img.naturalWidth / ratio, height: img.naturalHeight / ratio });
  };
  useLayoutEffect(() => {
    if (!size) return;
    setTransition(false);
    reset(rested({ ...INITIAL, scale: opensWhole() ? fitScale(0) : Math.max(1, fitScale(0)), x: Infinity, y: Infinity }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const go = (offset: number) => {
    const next = current + offset;
    if (next < 0 || next > count - 1) return;
    setTransition(false);
    reset();
    onCurrentChange?.(next);
  };

  /** Settle a picture let go after a drag or a pinch (see rest). */
  const settle = () => update(rested(latest()));

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (open && moving) update({ x: event.pageX - drag.current.diffX, y: event.pageY - drag.current.diffY });
    };
    const onMouseUp = () => {
      if (!open || !moving) return;
      setMoving(false);
      // A press that did not move the picture is left alone, so it stays a click.
      const { transformX, transformY } = drag.current;
      if (!(transform.x !== transformX && transform.y !== transformY)) return;
      settle();
    };
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
    };
  });

  // ←/→ page a group wherever focus is in the viewer — on the window, as the replaced preview listened, and ahead of
  // the popup, which keeps arrow keys from bubbling out of it.
  useEffect(() => {
    if (!open || !switches) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  // While open, a finger moving on the page moves the picture and nothing else.
  useEffect(() => {
    if (!open) return;
    const prevent = (event: TouchEvent) => event.preventDefault();
    window.addEventListener('touchmove', prevent, { passive: false });
    return () => window.removeEventListener('touchmove', prevent);
  }, [open]);

  const onMouseDown = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { diffX: event.pageX - transform.x, diffY: event.pageY - transform.y, transformX: transform.x, transformY: transform.y };
    setMoving(true);
  };
  // The wheel anywhere in the viewer: with ⌘ or Ctrl (which a trackpad's pinch sends too) it zooms around the pointer,
  // else it scrolls a picture larger than the window. Either way the page behind, and the browser's own zoom, stay put.
  // It moves the picture at once, as a scroll does, rather than easing after it.
  const [instant, setInstant] = useState(false);
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (wheelEnd.current) clearTimeout(wheelEnd.current);
  }, []);
  const onWheel = useRef<(event: WheelEvent) => void>(() => {});
  onWheel.current = (event: WheelEvent) => {
    event.preventDefault();
    if (!open) return;
    setInstant(true);
    if (wheelEnd.current) clearTimeout(wheelEnd.current);
    wheelEnd.current = setTimeout(() => setInstant(false), 150);
    if (event.ctrlKey || event.metaKey) {
      if (event.deltaY === 0) return;
      let ratio = 1 + Math.min(Math.abs(event.deltaY / 100), 1) * SCALE_STEP;
      if (event.deltaY > 0) ratio = 1 / ratio;
      zoom(ratio, event.clientX, event.clientY);
      return;
    }
    const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? window.innerHeight : 1;
    // Shift turns a plain wheel sideways where the system does not.
    const [dx, dy] = event.shiftKey && event.deltaX === 0 ? [event.deltaY, 0] : [event.deltaX, event.deltaY];
    const now = latest();
    update(rested({ ...now, x: now.x - dx * unit, y: now.y - dy * unit }));
  };
  /** Between the actual size and the fit (see fitScale); a picture whose fit is its actual size zooms in and back instead. */
  const onDoubleClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!open) return;
    const fit = fitScale(transform.rotate);
    if (transform.scale === 1 && fit !== 1) update(rested({ ...transform, x: 0, y: 0, scale: fit }));
    else if (transform.scale !== 1) zoom(1 / transform.scale, event.clientX, event.clientY);
    else zoom(1 + SCALE_STEP, event.clientX, event.clientY);
  };
  const onTouchStart = (event: ReactTouchEvent<HTMLImageElement>) => {
    event.stopPropagation();
    setTouching(true);
    const { touches } = event;
    if (touches.length > 1) {
      touch.current = {
        point1: { x: touches[0].clientX, y: touches[0].clientY },
        point2: { x: touches[1].clientX, y: touches[1].clientY },
        eventType: 'touchZoom',
      };
    } else if (touches.length === 1) {
      touch.current = { ...touch.current, point1: { x: touches[0].clientX - transform.x, y: touches[0].clientY - transform.y }, eventType: 'move' };
    }
  };
  const onTouchMove = (event: ReactTouchEvent<HTMLImageElement>) => {
    const { touches } = event;
    const { point1, point2, eventType } = touch.current;
    if (touches.length > 1 && eventType === 'touchZoom') {
      const next1 = { x: touches[0].clientX, y: touches[0].clientY };
      const next2 = { x: touches[1].clientX, y: touches[1].clientY };
      const [centerX, centerY] = pinchCenter(point1, point2, next1, next2);
      zoom(distance(next1, next2) / distance(point1, point2), centerX, centerY, true);
      touch.current = { point1: next1, point2: next2, eventType: 'touchZoom' };
    } else if (eventType === 'move' && touches.length > 0) {
      update({ x: touches[0].clientX - point1.x, y: touches[0].clientY - point1.y });
    }
  };
  const onTouchEnd = () => {
    if (!open) return;
    if (touching) setTouching(false);
    touch.current = { ...touch.current, eventType: 'none' };
    const min = Math.min(1, fitScale(transform.rotate));
    if (min > transform.scale) {
      update(rested({ ...transform, x: 0, y: 0, scale: min }));
      return;
    }
    settle();
  };

  const setPopup = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !open) return;
      const wheel = (event: WheelEvent) => onWheel.current(event);
      // Not passive, so a wheel can be kept from the page behind and ⌘/Ctrl with it from the browser's zoom.
      node.addEventListener('wheel', wheel, { passive: false });
      // Notifications belong to the top open layer, as they do for Orbit dialogs.
      const unregister = registerFeedbackLayer(node, (layer.zIndex - 1000) / 100);
      return () => {
        node.removeEventListener('wheel', wheel);
        unregister();
      };
    },
    [open, layer.zIndex],
  );

  const fit = fitScale(transform.rotate);
  const actual = transform.scale === 1;
  const actions: ImagePreviewAction[] = [
    { key: 'flipY', label: 'Flip vertically', icon: <SwapOutlined rotate={90} aria-hidden />, onClick: () => update({ flipY: !transform.flipY }) },
    { key: 'flipX', label: 'Flip horizontally', icon: <SwapOutlined aria-hidden />, onClick: () => update({ flipX: !transform.flipX }) },
    { key: 'rotateLeft', label: 'Rotate left', icon: <RotateLeftOutlined aria-hidden />, onClick: () => update(rested({ ...transform, rotate: transform.rotate - 90 })) },
    { key: 'rotateRight', label: 'Rotate right', icon: <RotateRightOutlined aria-hidden />, onClick: () => update(rested({ ...transform, rotate: transform.rotate + 90 })) },
    { key: 'zoomOut', label: 'Zoom out', icon: <ZoomOutOutlined aria-hidden />, onClick: () => zoom(1 / (1 + SCALE_STEP)), disabled: transform.scale <= Math.min(1, fit) },
    { key: 'zoomIn', label: 'Zoom in', icon: <ZoomInOutlined aria-hidden />, onClick: () => zoom(1 + SCALE_STEP), disabled: transform.scale === MAX_SCALE },
    actual
      ? { key: 'fit', label: 'Fit to window', icon: <CompressOutlined aria-hidden />, onClick: () => update(rested({ ...transform, x: 0, y: 0, scale: fit })), disabled: fit === 1 }
      : { key: 'actual', label: 'Actual size', icon: <OneToOneOutlined aria-hidden />, onClick: () => update(rested({ ...transform, x: Infinity, y: Infinity, scale: 1 })) },
    ...moreActions,
  ];
  const { x, y, scale, rotate, flipX, flipY } = transform;

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <BaseDialog.Portal container={typeof document === 'undefined' ? undefined : layer.getContainer()}>
        <BaseDialog.Popup
          ref={setPopup}
          className={`orbit-image-preview${moving ? ' orbit-image-preview-moving' : ''}${caption != null ? ' orbit-image-preview-captioned' : ''}`}
          style={{ zIndex: layer.zIndex + 80 }}
          aria-label={item?.alt || 'Image preview'}
          // Focus starts on the close button, as it did in the replaced preview; Base UI would move it a frame later.
          initialFocus={() => {
            closeButton.current?.focus({ preventScroll: true });
            return false;
          }}
        >
          <div className="orbit-image-preview-mask" onClick={onClose} />
          <div
            ref={body}
            className="orbit-image-preview-body"
            style={origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : undefined}
          >
            <img
              ref={image}
              className="orbit-image-preview-img"
              src={item?.src}
              alt={item?.alt}
              style={{
                ...(size ? { width: size.width, height: size.height, maxWidth: 'none', maxHeight: 'none' } : null),
                transform: `translate3d(${x}px, ${y}px, 0) scale3d(${flipX ? '-' : ''}${scale}, ${flipY ? '-' : ''}${scale}, 1) rotate(${rotate}deg)`,
                transitionDuration: !transition || touching || instant ? '0s' : undefined,
              }}
              onLoad={onLoad}
              onMouseDown={onMouseDown}
              onDoubleClick={onDoubleClick}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
            />
          </div>
          <button ref={closeButton} type="button" className="orbit-image-preview-close" aria-label="Close" onClick={onClose}>
            <CloseOutlined aria-hidden />
          </button>
          {/* A button that can't act is greyed with aria-disabled, never disabled: a disabled button drops the focus it
              holds onto the page behind the viewer, whose keys then act under it (↑/↓ switched the session). This one
              keeps focus, so keys and Tab stay in the viewer and Esc hands focus back; a press on it does nothing. */}
          {switches && (
            <>
              <button
                type="button"
                className="orbit-image-preview-switch orbit-image-preview-switch-prev"
                aria-label="Previous image"
                aria-disabled={current === 0 || undefined}
                onClick={() => go(-1)}
              >
                <LeftOutlined aria-hidden />
              </button>
              <button
                type="button"
                className="orbit-image-preview-switch orbit-image-preview-switch-next"
                aria-label="Next image"
                aria-disabled={current === count - 1 || undefined}
                onClick={() => go(1)}
              >
                <RightOutlined aria-hidden />
              </button>
            </>
          )}
          <div ref={footer} className="orbit-image-preview-footer">
            {group && (
              <div className="orbit-image-preview-progress">
                <bdi>{position ? position(current + 1, count) : `${current + 1} / ${count}`}</bdi>
              </div>
            )}
            {caption != null && <div className="orbit-image-preview-caption">{caption}</div>}
            <div className="orbit-image-preview-actions">
              <span className="orbit-image-preview-scale">{Math.round(scale * 100)}%</span>
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="orbit-image-preview-action"
                  aria-label={action.label}
                  aria-disabled={action.disabled || undefined}
                  onClick={action.disabled ? undefined : action.onClick}
                >
                  {action.icon}
                </button>
              ))}
            </div>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
