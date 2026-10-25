import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import './TextControls.css';
import './NumberInput.css';

export interface NumberInputProps {
  /** null is an empty field. */
  value: number | null;
  /** Called while typing with each number in range, and on blur, Enter or a step with the value
   *  brought into range and to its precision. */
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places a settled value keeps; unset, those of the value or the step, whichever is more. */
  precision?: number;
  size?: 'small' | 'middle';
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** After the typed value has settled. */
  onPressEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** Holding a step button repeats it after this long, then at this pace (the replaced field's). */
const REPEAT_DELAY = 600;
const REPEAT_INTERVAL = 200;

/** A number as typed: digits with at most one point and a leading minus. */
const NUMBER_TEXT = /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;

/** What a field's text holds: null when empty, NaN when it is not (yet) a number. */
function parse(text: string): number | null {
  const cleaned = text.replace(/[^\w.-]+/g, '');
  if (!cleaned.trim()) return null;
  return NUMBER_TEXT.test(cleaned) ? Number(cleaned) : Number.NaN;
}

/** A number in plain decimal digits, never in exponent form. */
function numberText(value: number): string {
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(Math.min(100, decimalsOf(text)));
}

/** How many digits after the point a number carries. */
function decimalsOf(text: string): number {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
}

/** `text` to `places` decimals, half away from zero (or cut), in exact decimal arithmetic. */
function toFixed(text: string, places: number, cut = false): string {
  const negative = text.trim().startsWith('-');
  const [integer = '0', decimals = ''] = text.trim().replace(/^-/, '').split('.');
  let digits = BigInt((integer || '0') + decimals.padEnd(places, '0').slice(0, places));
  if (!cut && Number(decimals[places] ?? '0') >= 5) digits += 1n;
  const padded = digits.toString().padStart(places + 1, '0');
  const fixed = places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded;
  return negative && /[1-9]/.test(fixed) ? `-${fixed}` : fixed;
}

/** a + b, exactly, for decimals. */
function add(a: number, b: number): number {
  const places = Math.max(decimalsOf(numberText(a)), decimalsOf(numberText(b)));
  const scale = (value: number) => BigInt(toFixed(numberText(value), places, true).replace('.', ''));
  const sum = (scale(a) + scale(b)).toString();
  const negative = sum.startsWith('-');
  const padded = sum.replace('-', '').padStart(places + 1, '0');
  return Number(`${negative ? '-' : ''}${places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded}`);
}

/**
 * A number field as the replaced one behaves: typing reports each number that is in range (an empty
 * field as null) and leaves the text as typed; blur and Enter bring it into range, round it to its
 * precision and write it back settled, falling back to the last value when the text is no number;
 * ↑/↓ (×10 with Shift) and the step buttons that show on hover move it by `step` within range.
 */
export function NumberInput({
  value, onValueChange, min, max, step = 1, precision, size = 'middle', disabled = false, placeholder, id, name,
  className, style, onPressEnter, ...aria
}: NumberInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const typing = useRef(false);
  const composing = useRef(false);
  const shift = useRef(false);
  const repeat = useRef<ReturnType<typeof setTimeout>>(undefined);
  const placesOf = (number: number) => precision ?? Math.max(decimalsOf(numberText(number)), decimalsOf(numberText(step)));
  const format = (number: number | null, whileTyping: boolean) =>
    number === null ? '' : whileTyping ? numberText(number) : toFixed(numberText(number), placesOf(number));
  const [text, setText] = useState(() => format(value, false));

  const outside = (number: number) => (max !== undefined && number > max) || (min !== undefined && number < min);
  const clamp = (number: number) => (max !== undefined && number > max ? max : min !== undefined && number < min ? min : number);
  /** Report `target` (null: empty) the way the replaced field does, and return what the value is now. */
  const commit = (target: number | null, whileTyping: boolean): number | null => {
    let next = target;
    if (next !== null && !whileTyping) next = clamp(next);
    else if (next !== null && outside(next)) return value;
    if (disabled) return value;
    if (next !== null && !whileTyping) {
      const places = placesOf(next);
      let fixed = Number(toFixed(numberText(next), places));
      if (outside(fixed)) fixed = Number(toFixed(numberText(next), places, true));
      next = fixed;
    }
    if (next !== value) onValueChange(next);
    return next;
  };

  // A new value from outside is written back, unless it is what is being typed ("1." stays "1.").
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const typed = parse(text);
    if (typed !== value || !typing.current) setText(format(value, typing.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const settle = () => {
    const typed = parse(text);
    commit(Number.isNaN(typed) ? value : typed, false);
    setText(format(value, false));
  };
  const upDisabled = value !== null && max !== undefined && value >= max;
  const downDisabled = value !== null && min !== undefined && value <= min;
  const stepBy = (up: boolean) => {
    if ((up && upDisabled) || (!up && downDisabled)) return;
    typing.current = false;
    const offset = shift.current ? step * 10 : step;
    commit(add(value ?? 0, up ? offset : -offset), false);
    input.current?.focus();
  };
  const stepLatest = useRef(stepBy);
  stepLatest.current = stepBy;
  const stopRepeat = () => clearTimeout(repeat.current);
  useEffect(() => stopRepeat, []);
  const pressAction = (up: boolean) => (event: MouseEvent) => {
    event.preventDefault();
    stopRepeat();
    stepLatest.current(up);
    const loop = () => {
      stepLatest.current(up);
      repeat.current = setTimeout(loop, REPEAT_INTERVAL);
    };
    repeat.current = setTimeout(loop, REPEAT_DELAY);
  };
  const releaseAction = () => requestAnimationFrame(stopRepeat);

  const collect = (raw: string) => {
    // A full-width stop from an input method is the decimal point.
    const next = raw.replace(/。/g, '.');
    setText(next);
    if (composing.current) return;
    const typed = parse(next);
    if (!Number.isNaN(typed)) commit(typed, true);
  };

  return (
    <div
      className={`orbit-text-control orbit-number-input${className ? ` ${className}` : ''}`}
      data-size={size}
      data-disabled={disabled ? '' : undefined}
      style={style}
      onMouseDown={(event) => {
        if (input.current && event.target !== input.current) {
          input.current.focus();
          event.preventDefault();
        }
      }}
    >
      <input
        {...aria}
        ref={input}
        id={id}
        name={name}
        className="orbit-number-input-field"
        autoComplete="off"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value ?? undefined}
        step={step}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onBeforeInput={() => { typing.current = true; }}
        onChange={(event) => collect(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          collect(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          typing.current = true;
          shift.current = event.shiftKey;
          if (event.key === 'Enter') {
            if (!composing.current) typing.current = false;
            settle();
            onPressEnter?.(event);
          }
          if (!composing.current && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            stepBy(event.key === 'ArrowUp');
            event.preventDefault();
          }
        }}
        onKeyUp={() => {
          typing.current = false;
          shift.current = false;
        }}
        onBlur={() => {
          settle();
          typing.current = false;
        }}
      />
      {!disabled && (
        <div className="orbit-number-input-actions">
          <span role="button" aria-label="Increase Value" aria-disabled={upDisabled} className="orbit-number-input-action"
            onMouseDown={pressAction(true)} onMouseUp={releaseAction} onMouseLeave={releaseAction}>
            <UpOutlined aria-hidden />
          </span>
          <span role="button" aria-label="Decrease Value" aria-disabled={downDisabled} className="orbit-number-input-action"
            onMouseDown={pressAction(false)} onMouseUp={releaseAction} onMouseLeave={releaseAction}>
            <DownOutlined aria-hidden />
          </span>
        </div>
      )}
    </div>
  );
}
