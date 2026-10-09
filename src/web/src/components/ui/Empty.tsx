import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import './Empty.css';

export interface EmptyProps extends ComponentPropsWithoutRef<'div'> {
  /** `default`: the 100px illustration; `simple`: the 40px one, in muted text (a list's own empty state). */
  image?: 'default' | 'simple';
  description?: ReactNode;
}

/** The replaced empty state's two illustrations, Ant Design's MIT-licensed Empty and Empty/simple
 *  (attribution and license: ./antd-empty.LICENSE), with their colours read from the theme. Each
 *  carries its "No data" title, as the replaced one did. */
function DefaultImage() {
  return <svg width="184" height="152" viewBox="0 0 184 152" xmlns="http://www.w3.org/2000/svg">
    <title>No data</title>
    <g fill="none" fillRule="evenodd">
      <g transform="translate(24 31.7)">
        <ellipse fillOpacity=".8" fill="var(--orbit-empty-shadow)" cx="67.8" cy="106.9" rx="67.8" ry="12.7" />
        <path fill="var(--orbit-empty-outline)" d="M122 69.7 98.1 40.2a6 6 0 0 0-4.6-2.2H42.1a6 6 0 0 0-4.6 2.2l-24 29.5V85H122z" />
        <path fill="var(--orbit-badge-default-bg)" d="M33.8 0h68a4 4 0 0 1 4 4v93.3a4 4 0 0 1-4 4h-68a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4" />
        <path fill="var(--orbit-empty-border)" d="M42.7 10h50.2a2 2 0 0 1 2 2v25a2 2 0 0 1-2 2H42.7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2m.2 39.8h49.8a2.3 2.3 0 1 1 0 4.5H42.9a2.3 2.3 0 0 1 0-4.5m0 11.7h49.8a2.3 2.3 0 1 1 0 4.6H42.9a2.3 2.3 0 0 1 0-4.6m79 43.5a7 7 0 0 1-6.8 5.4H20.5a7 7 0 0 1-6.7-5.4l-.2-1.8V69.7h26.3c2.9 0 5.2 2.4 5.2 5.4s2.4 5.4 5.3 5.4h34.8c2.9 0 5.3-2.4 5.3-5.4s2.3-5.4 5.2-5.4H122v33.5q0 1-.2 1.8" />
      </g>
      <path fill="var(--orbit-empty-border)" d="m149.1 33.3-6.8 2.6a1 1 0 0 1-1.3-1.2l2-6.2q-4.1-4.5-4.2-10.4c0-10 10.1-18.1 22.6-18.1S184 8.1 184 18.1s-10.1 18-22.6 18q-6.8 0-12.3-2.8" />
      <g fill="var(--bg-raised)" transform="translate(149.7 15.4)">
        <circle cx="20.7" cy="3.2" r="2.8" />
        <path d="M5.7 5.6H0L2.9.7zM9.3.7h5v5h-5z" />
      </g>
    </g>
  </svg>;
}

function SimpleImage() {
  return <svg width="64" height="41" viewBox="0 0 64 41" xmlns="http://www.w3.org/2000/svg">
    <title>No data</title>
    <g transform="translate(0 1)" fill="none" fillRule="evenodd">
      <ellipse fill="var(--orbit-badge-default-bg)" cx="32" cy="33" rx="32" ry="7" />
      <g fillRule="nonzero" stroke="var(--orbit-empty-border)">
        <path d="M55 12.8 44.9 1.3Q44 0 42.9 0H21.1q-1.2 0-2 1.3L9 12.8V22h46z" />
        <path d="M41.6 16c0-1.7 1-3 2.2-3H55v18.1c0 2.2-1.3 3.9-3 3.9H12c-1.7 0-3-1.7-3-3.9V13h11.2c1.2 0 2.2 1.3 2.2 3s1 2.9 2.2 2.9h14.8c1.2 0 2.2-1.4 2.2-3" fill="var(--orbit-empty-fill)" />
      </g>
    </g>
  </svg>;
}

/** Present, as the replaced empty state read it: an empty string or `false` draws nothing. */
const shown = (node: ReactNode) => node != null && node !== false && node !== '';

/** An empty state: the illustration, a sentence saying what is missing, and the way out (children). */
export function Empty({ image = 'default', description = 'No data', className, children, ...props }: EmptyProps) {
  return (
    <div {...props} className={`orbit-empty${image === 'simple' ? ' orbit-empty-simple' : ''}${className ? ` ${className}` : ''}`}>
      <div className="orbit-empty-image">{image === 'simple' ? <SimpleImage /> : <DefaultImage />}</div>
      {shown(description) && <div className="orbit-empty-description">{description}</div>}
      {shown(children) && <div className="orbit-empty-footer">{children}</div>}
    </div>
  );
}
