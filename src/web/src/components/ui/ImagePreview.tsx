import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import {
  CloseOutlined,
  LeftOutlined,
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
  src: string;
  alt?: string;
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
}

// ── zoom, drag and pinch ──────────────────────────────────────────────────────────────────────────
// The replaced preview's own arithmetic (rc-image, MIT, see ./rc-image.LICENSE), so a button, the wheel, a double
// click, a drag or a pinch moves the picture exactly as it did.

type Transform = { x: number; y: number; rotate: number; scale: number; flipX: boolean; flipY: boolean };
type Point = { x: number; y: number };
const INITIAL: Transform = { x: 0, y: 0, rotate: 0, scale: 1, flipX: false, flipY: false };
const SCALE_STEP = 0.5;
const MIN_SCALE = 1;
const MAX_SCALE = 50;

function clientSize() {
  return { width: document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight };
}

function fixPoint(start: number, size: number, client: number): number | undefined {
  const offsetStart = (size - client) / 2;
  if (size > client) {
    if (start > 0) return offsetStart;
    if (start < 0 && start + size < client) return -offsetStart;
  } else if (start < 0 || start + size > client) {
    return start < 0 ? offsetStart : -offsetStart;
  }
  return undefined;
}

/** Where a dragged or pinched picture settles: centred again when it fits, else with no gap at an edge. */
function rebound(width: number, height: number, left: number, top: number): Partial<Transform> {
  const client = clientSize();
  if (width <= client.width && height <= client.height) return { x: 0, y: 0 };
  const fix: Partial<Transform> = {};
  const x = fixPoint(left, width, client.width);
  const y = fixPoint(top, height, client.height);
  if (x !== undefined) fix.x = x;
  if (y !== undefined) fix.y = y;
  return fix;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pinchCenter(old1: Point, old2: Point, new1: Point, new2: Point): [number, number] {
  const moved1 = distance(old1, new1);
  const moved2 = distance(old2, new2);
  if (moved1 === 0 && moved2 === 0) return [old1.x, old1.y];
  const ratio = moved1 / (moved1 + moved2);
  return [old1.x + ratio * (old2.x - old1.x), old1.y + ratio * (old2.y - old1.y)];
}

function useImageTransform(image: RefObject<HTMLImageElement | null>) {
  const frame = useRef<number | null>(null);
  const queue = useRef<Transform[]>([]);
  const [transform, setTransform] = useState<Transform>(INITIAL);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  const reset = () => setTransform(INITIAL);
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
          return merged;
        });
      });
    }
    queue.current.push({ ...transform, ...next });
  };
  /** Scale by `ratio` around a point (the window's centre by default), keeping that point where it is. */
  const zoom = (ratio: number, centerX?: number, centerY?: number, isTouch = false) => {
    const img = image.current;
    if (!img) return;
    const { width, height, offsetWidth, offsetHeight, offsetLeft, offsetTop } = img;
    let newRatio = ratio;
    let newScale = transform.scale * ratio;
    if (newScale > MAX_SCALE) {
      newScale = MAX_SCALE;
      newRatio = MAX_SCALE / transform.scale;
    } else if (newScale < MIN_SCALE) {
      // A pinch may go below the minimum while the fingers are down; it springs back when they lift.
      newScale = isTouch ? newScale : MIN_SCALE;
      newRatio = newScale / transform.scale;
    }
    const diffRatio = newRatio - 1;
    const diffImgX = diffRatio * width * 0.5;
    const diffImgY = diffRatio * height * 0.5;
    const diffOffsetLeft = diffRatio * ((centerX ?? innerWidth / 2) - transform.x - offsetLeft);
    const diffOffsetTop = diffRatio * ((centerY ?? innerHeight / 2) - transform.y - offsetTop);
    let x = transform.x - (diffOffsetLeft - diffImgX);
    let y = transform.y - (diffOffsetTop - diffImgY);
    // Back at its own size and smaller than the window: centred again.
    if (ratio < 1 && newScale === 1) {
      const client = clientSize();
      if (offsetWidth * newScale <= client.width && offsetHeight * newScale <= client.height) {
        x = 0;
        y = 0;
      }
    }
    update({ x, y, scale: newScale });
  };
  return { transform, reset, update, zoom };
}

// ── the preview ───────────────────────────────────────────────────────────────────────────────────

/**
 * The full-screen picture viewer the replaced Image and Image.PreviewGroup opened: the picture on a dark mask, a
 * close button top right, previous/next arrows at the sides of a group, and under the picture the position in the
 * group and the flip, rotate and zoom buttons. A picture zooms with the buttons, the wheel and a double click, moves
 * when dragged, and pinches and moves by touch; ←/→ page a group. Esc, the close button or a press on the mask
 * closes it, and focus goes back where it was.
 */
export function ImagePreview({ open, onClose, items, current = 0, onCurrentChange, group = false, origin }: ImagePreviewProps) {
  const layer = useOverlayChild(open, onClose);
  const image = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { transform, reset, update, zoom } = useImageTransform(image);
  const [transition, setTransition] = useState(true);
  const [moving, setMoving] = useState(false);
  const [touching, setTouching] = useState(false);
  const drag = useRef({ diffX: 0, diffY: 0, transformX: 0, transformY: 0 });
  const touch = useRef<{ point1: Point; point2: Point; eventType: 'none' | 'move' | 'touchZoom' }>({
    point1: { x: 0, y: 0 },
    point2: { x: 0, y: 0 },
    eventType: 'none',
  });
  const count = items.length;
  const item = items[current];
  const switches = group && count > 1;

  // A switch shows the next picture at its own size at once; the frame after, zooming animates again.
  useEffect(() => {
    if (!transition) setTransition(true);
  }, [transition]);
  useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const go = (offset: number) => {
    const next = current + offset;
    if (next < 0 || next > count - 1) return;
    setTransition(false);
    reset();
    onCurrentChange?.(next);
  };

  /** Settle a picture let go after a drag or a pinch (see rebound). */
  const settle = () => {
    const img = image.current;
    if (!img) return;
    const width = img.offsetWidth * transform.scale;
    const height = img.offsetHeight * transform.scale;
    const { left, top } = img.getBoundingClientRect();
    const turned = transform.rotate % 180 !== 0;
    update(rebound(turned ? height : width, turned ? width : height, left, top));
  };

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

  // ←/→ page a group wherever focus is — on the window, as the replaced preview listened, so a key still pages when
  // the button that had focus was disabled at an end and focus fell back to the page. Ahead of the popup, which keeps
  // arrow keys from bubbling out of it.
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
  const onWheel = (event: ReactWheelEvent<HTMLImageElement>) => {
    if (!open || event.deltaY === 0) return;
    let ratio = 1 + Math.min(Math.abs(event.deltaY / 100), 1) * SCALE_STEP;
    if (event.deltaY > 0) ratio = 1 / ratio;
    zoom(ratio, event.clientX, event.clientY);
  };
  const onDoubleClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!open) return;
    if (transform.scale !== 1) update({ x: 0, y: 0, scale: 1 });
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
    if (MIN_SCALE > transform.scale) {
      update({ x: 0, y: 0, scale: MIN_SCALE });
      return;
    }
    settle();
  };

  const setPopup = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !open) return;
      // Notifications belong to the top open layer, as they do for Orbit dialogs.
      return registerFeedbackLayer(node, (layer.zIndex - 1000) / 100);
    },
    [open, layer.zIndex],
  );

  const actions: { key: string; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }[] = [
    { key: 'flipY', label: 'Flip vertically', icon: <SwapOutlined rotate={90} aria-hidden />, onClick: () => update({ flipY: !transform.flipY }) },
    { key: 'flipX', label: 'Flip horizontally', icon: <SwapOutlined aria-hidden />, onClick: () => update({ flipX: !transform.flipX }) },
    { key: 'rotateLeft', label: 'Rotate left', icon: <RotateLeftOutlined aria-hidden />, onClick: () => update({ rotate: transform.rotate - 90 }) },
    { key: 'rotateRight', label: 'Rotate right', icon: <RotateRightOutlined aria-hidden />, onClick: () => update({ rotate: transform.rotate + 90 }) },
    { key: 'zoomOut', label: 'Zoom out', icon: <ZoomOutOutlined aria-hidden />, onClick: () => zoom(1 / (1 + SCALE_STEP)), disabled: transform.scale <= MIN_SCALE },
    { key: 'zoomIn', label: 'Zoom in', icon: <ZoomInOutlined aria-hidden />, onClick: () => zoom(1 + SCALE_STEP), disabled: transform.scale === MAX_SCALE },
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
          className={`orbit-image-preview${moving ? ' orbit-image-preview-moving' : ''}`}
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
            className="orbit-image-preview-body"
            style={origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : undefined}
          >
            <img
              ref={image}
              className="orbit-image-preview-img"
              src={item?.src}
              alt={item?.alt}
              style={{
                transform: `translate3d(${x}px, ${y}px, 0) scale3d(${flipX ? '-' : ''}${scale}, ${flipY ? '-' : ''}${scale}, 1) rotate(${rotate}deg)`,
                transitionDuration: !transition || touching ? '0s' : undefined,
              }}
              onWheel={onWheel}
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
          {switches && (
            <>
              <button
                type="button"
                className="orbit-image-preview-switch orbit-image-preview-switch-prev"
                aria-label="Previous image"
                disabled={current === 0}
                onClick={() => go(-1)}
              >
                <LeftOutlined aria-hidden />
              </button>
              <button
                type="button"
                className="orbit-image-preview-switch orbit-image-preview-switch-next"
                aria-label="Next image"
                disabled={current === count - 1}
                onClick={() => go(1)}
              >
                <RightOutlined aria-hidden />
              </button>
            </>
          )}
          <div className="orbit-image-preview-footer">
            {group && (
              <div className="orbit-image-preview-progress">
                <bdi>{`${current + 1} / ${count}`}</bdi>
              </div>
            )}
            <div className="orbit-image-preview-actions">
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="orbit-image-preview-action"
                  aria-label={action.label}
                  disabled={action.disabled}
                  onClick={action.onClick}
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
