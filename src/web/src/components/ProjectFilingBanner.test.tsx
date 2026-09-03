import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectFilingBanner } from './ProjectFilingBanner';

vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const PROJECT = '2zQeDGWFFAgN2112jNEkD';

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
}

function paint(seed?: Record<string, unknown>) {
  const qc = client();
  if (seed) qc.setQueryData(['project', PROJECT], seed);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProjectFilingBanner projectId={PROJECT} />
    </QueryClientProvider>,
  );
}

/**
 * Acceptance criterion 1: a person can see, before they submit, which project the work is being
 * filed into — by name and by id.
 *
 * The incident this whole unit exists for was a batch landing in a project nobody meant, and the
 * reason nobody caught it is that no screen ever said which project a create was filing into.
 */
describe('ProjectFilingBanner', () => {
  it('names the project by title AND by Base62 id', () => {
    const html = paint({ publicId: PROJECT, title: 'Coordinator control loop', status: 'OPEN' });
    expect(html).toContain('Filing into');
    expect(html).toContain('Coordinator control loop');
    expect(html).toContain(PROJECT);
  });

  it('shows the id even before the title has loaded', () => {
    // A banner that rendered nothing until the fetch resolved would be absent for exactly as long
    // as somebody is reading the form.
    const html = paint();
    expect(html).toContain('Filing into');
    expect(html).toContain(PROJECT);
  });

  it('never reports an acceptance epoch: 0229 removed the column it read', () => {
    expect(paint({ title: 'p', status: 'OPEN' })).not.toContain('epoch');
    // Even if an older server still sent one, the banner has no place to put it.
    expect(paint({ title: 'p', status: 'OPEN', acceptanceEpoch: '4' } as never)).not.toContain('epoch');
  });

  it('warns before submit that a settled project takes no new work, with the code', () => {
    const html = paint({ publicId: PROJECT, title: 'p', status: 'DONE' });
    expect(html).toContain('This project is settled');
    expect(html).toContain('PROJECT_REOPEN_REQUIRED');
    expect(paint({ title: 'p', status: 'OPEN' })).not.toContain('This project is settled');
  });

  it('gives the status chip an accessible name rather than leaving it to colour', () => {
    expect(paint({ title: 'p', status: 'CANCELLED' })).toContain(
      'aria-label="Project status CANCELLED"',
    );
  });
});
