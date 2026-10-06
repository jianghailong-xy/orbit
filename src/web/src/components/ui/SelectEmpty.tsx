/** Retains the existing empty-state illustration. Adapted from Ant Design's
 * MIT-licensed Empty/simple; attribution and license: ./antd-empty.LICENSE. */
export function SelectEmpty() {
  return <div className="orbit-select-empty-content">
    <div className="orbit-select-empty-image" aria-hidden>
      <svg width="64" height="41" viewBox="0 0 64 41" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(0 1)" fill="none" fillRule="evenodd">
          <ellipse fill="var(--orbit-badge-default-bg)" cx="32" cy="33" rx="32" ry="7" />
          <g fillRule="nonzero" stroke="var(--orbit-empty-border)">
            <path d="M55 12.8 44.9 1.3Q44 0 42.9 0H21.1q-1.2 0-2 1.3L9 12.8V22h46z" />
            <path d="M41.6 16c0-1.7 1-3 2.2-3H55v18.1c0 2.2-1.3 3.9-3 3.9H12c-1.7 0-3-1.7-3-3.9V13h11.2c1.2 0 2.2 1.3 2.2 3s1 2.9 2.2 2.9h14.8c1.2 0 2.2-1.4 2.2-3" fill="var(--orbit-empty-fill)" />
          </g>
        </g>
      </svg>
    </div>
    <div>No data</div>
  </div>;
}
