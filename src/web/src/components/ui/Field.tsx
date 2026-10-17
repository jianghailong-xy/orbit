import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import './Field.css';

/** What a field's control is given so its label, messages and state reach assistive technology. */
export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
  'aria-describedby'?: string;
}

export interface FieldProps {
  /** The control's id: the label points at it, and its messages are `${id}_help` and `${id}_extra`. */
  id: string;
  /** Without one, the control names itself (a checkbox's own text). */
  label?: ReactNode;
  /** One message per broken check, under the control; none means the field is fine. */
  errors?: readonly string[];
  /** Standing help under the control. */
  extra?: ReactNode;
  required?: boolean;
  /** The control, given the ids and states to carry. */
  children: (control: FieldControlProps) => ReactNode;
}

const LEAVE_MS = 100;

/**
 * A labelled form field in the replaced form's vertical layout: the label over the control, then its
 * messages in the 24px the field's bottom margin keeps for them, so a one-line message moves nothing.
 * Messages fade in 5px down and fade back out (not with reduced motion).
 */
export function Field({ id, label, errors = [], extra, required, children }: FieldProps) {
  const shown = useLeaving(errors);
  const hasErrors = errors.length > 0;
  const describedBy = [hasErrors && `${id}_help`, extra != null && `${id}_extra`].filter(Boolean).join(' ');
  const control: FieldControlProps = {
    id,
    ...(hasErrors ? { 'aria-invalid': true } : {}),
    ...(required ? { 'aria-required': true } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  };
  const help = shown.messages.length > 0;
  return (
    <div className="orbit-field" data-help={help || undefined}>
      {label != null && (
        <div className="orbit-field-label">
          <label htmlFor={id}>{label}</label>
        </div>
      )}
      <div className="orbit-field-control">
        <div className="orbit-field-input">
          <div className="orbit-field-input-content">{children(control)}</div>
        </div>
        {(help || extra != null) && (
          <div className="orbit-field-additional">
            {help && (
              <div id={`${id}_help`} className="orbit-field-help" data-leaving={shown.leaving || undefined}>
                {shown.messages.map((message, index) => (
                  <div key={`${index}:${message}`} className="orbit-field-error">{message}</div>
                ))}
              </div>
            )}
            {extra != null && <div id={`${id}_extra`} className="orbit-field-extra">{extra}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The messages to draw: the current ones, or for a moment the ones just resolved, fading out. */
function useLeaving(errors: readonly string[]) {
  const [leaving, setLeaving] = useState<readonly string[]>([]);
  const last = useRef(errors);
  const key = errors.join('\n');
  useEffect(() => {
    const previous = last.current;
    last.current = errors;
    if (errors.length || !previous.length || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setLeaving([]);
      return;
    }
    setLeaving(previous);
    const timer = setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return errors.length ? { messages: errors, leaving: false } : { messages: leaving, leaving: leaving.length > 0 };
}

/** The check a validated field shows at the end of its control: passed or failed. */
export function FieldFeedback({ status }: { status: 'success' | 'error' }) {
  return (
    <span className="orbit-field-feedback" data-status={status} aria-hidden>
      {status === 'success' ? <CheckCircleFilled /> : <CloseCircleFilled />}
    </span>
  );
}
