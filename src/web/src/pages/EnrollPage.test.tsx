import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EnrollmentDetails, type DeviceInfo } from './EnrollPage';

const enrollment = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  userCode: 'BEW3X-BUA6F',
  name: 'devbox',
  hostname: 'vmi3337007',
  labels: [],
  maxConcurrent: 16,
  status: 'PENDING',
  ...over,
});

function descriptionRow(html: string, label: string): string {
  const row = (html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []).find((candidate) =>
    candidate.includes(label),
  );
  expect(row, `missing ${label} row`).toBeDefined();
  return row!;
}

describe('runner enrollment identity', () => {
  it('shows the chosen runner name separately from the machine hostname', () => {
    const html = renderToStaticMarkup(<EnrollmentDetails info={enrollment()} />);

    const runner = descriptionRow(html, 'Runner');
    expect(runner).toContain('devbox');
    expect(runner).not.toContain('vmi3337007');

    const hostname = descriptionRow(html, 'Hostname');
    expect(hostname).toContain('vmi3337007');
    expect(hostname).not.toContain('devbox');

    expect(html).not.toContain('Workspaces');
    expect(html).not.toContain('devbox/…');
  });

  it('does not repeat the hostname when it is also the runner name', () => {
    const html = renderToStaticMarkup(
      <EnrollmentDetails info={enrollment({ name: 'vmi3337007' })} />,
    );

    expect(descriptionRow(html, 'Runner')).toContain('vmi3337007');
    expect(
      (html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []).some((row) => row.includes('Hostname')),
    ).toBe(false);
  });
});
