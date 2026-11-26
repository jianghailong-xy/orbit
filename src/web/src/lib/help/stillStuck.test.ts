import { describe, expect, it } from 'vitest';
import { reportBody, reportIssueUrl, reportTitle, scrubForReport, type ReportInput } from './stillStuck';

/**
 * Still stuck → Report on GitHub (docs/mocks/help-center board 02 ② right frame, side note 5): the issue body is built by
 * reportBody alone. It carries Orbit's version and client, and the
 * question and answer — and never a repository name, a file's contents or a key, wherever in the conversation they were.
 */


// Everything the person's conversation might hold that a report must not.
const SECRETS = {
  openai: 'sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34',
  anthropic: 'sk-ant-api03-ZyXw9876VuTs5432RqPo1098',
  github: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearer: 'Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  hex: '3f6c0e9a1b2d4c5e6f708192a3b4c5d6e7f80912',
  base64: 'q8Z3vR7xK2mN9pL4wT6yH1jF5sD0aG3cV8bX2nM7kQ9e',
  envValue: 'hunter2-Secret-99',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----',
};
const REPOS = {
  url: 'https://github.com/acme-corp/payments-api',
  ssh: 'git@github.com:acme-corp/payments-api.git',
  gitlab: 'https://gitlab.com/acme-corp/infra/terraform-live.git',
  workspace: 'payments-api',
  slug: 'acme-corp/payments-api',
  folder: 'billing-worker',
};
const FILE_LINE = 'const STRIPE_WEBHOOK_HANDLER = createHandler(process.env);';
const FILE_PATH = '/home/mia/src/billing-worker/src/webhooks.ts';

const leaky: ReportInput = {
  orbitVersion: '0.1.257',
  client: 'web',
  privateNames: ['payments-api', 'acme-corp/payments-api', 'billing-worker'],
  exchanges: [
    {
      question: [
        `My session in ${REPOS.workspace} (${REPOS.url}) fails. The remote is ${REPOS.ssh}.`,
        `I set OPENAI_API_KEY=${SECRETS.openai} and ANTHROPIC_API_KEY="${SECRETS.anthropic}".`,
        `GitHub token ${SECRETS.github}, AWS ${SECRETS.aws}, header Authorization: ${SECRETS.bearer}.`,
        `The file is ${FILE_PATH}:`,
        '```ts',
        FILE_LINE,
        '```',
        SECRETS.privateKey,
        `Also ${REPOS.gitlab} and the session token ${SECRETS.jwt}, digest ${SECRETS.hex}, blob ${SECRETS.base64}.`,
        `password: ${SECRETS.envValue}`,
        `It runs in ~/work/${REPOS.folder} too.`,
      ].join('\n'),
      answer: [
        `build-box last checked in **2 h 4 min ago**, so it most likely went to sleep [1].`,
        '',
        `In ${REPOS.slug}, check:`,
        '',
        '    ' + FILE_LINE,
        '',
        '1. Wake build-box [1].',
        '2. Run `orbit doctor` on it.',
        '',
        'Sources:',
        '[1] [A machine shows Offline](orbit:/help/machines-and-engines/a-machine-shows-offline)',
      ].join('\n'),
    },
  ],
};

describe('reportBody', () => {
  const body = reportBody(leaky);

  it('carries Orbit version and client, and no machine: the server answered', () => {
    expect(body).toContain('Orbit 0.1.257 · web');
    expect(body).not.toContain('Machine:');
  });

  it('carries the question and the answer, without the answer\'s source list', () => {
    expect(body).toContain('### Question');
    expect(body).toContain('My session in');
    expect(body).toContain('### Answer');
    expect(body).toContain('build-box last checked in **2 h 4 min ago**, so it most likely went to sleep [1].');
    expect(body).toContain('2. Run `orbit doctor` on it.');
    expect(body).not.toContain('cite:');
    expect(body).not.toContain('Sources:');
    expect(body).toContain('Not included: repository names, file contents, keys');
  });

  it('excludes every key, whatever its shape or wherever it was written', () => {
    for (const [what, secret] of Object.entries(SECRETS)) {
      const core = what === 'bearer' ? secret.slice('Bearer '.length) : secret;
      expect(body, what).not.toContain(core);
    }
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).not.toContain('b3BlbnNzaC1rZXk');
    expect(body).toContain('OPENAI_API_KEY=[key removed]');
  });

  it('excludes repository names: addresses, owner/repo, and the person\'s workspace and folder names', () => {
    expect(body).not.toContain('acme-corp');
    expect(body).not.toContain('payments-api');
    expect(body).not.toContain('terraform-live');
    expect(body).not.toContain('billing-worker');
    expect(body).not.toContain('github.com/acme');
    expect(body).toContain('[repository removed]');
  });

  it('excludes file contents and the paths they live at', () => {
    expect(body).not.toContain('STRIPE_WEBHOOK_HANDLER');
    expect(body).not.toContain('createHandler');
    expect(body).not.toContain('webhooks.ts');
    expect(body).not.toContain('/home/mia');
    expect(body).toContain('[code block removed]');
    expect(body).toContain('[path removed]');
  });

  it('a question that got no answer says so', () => {
    const none = reportBody({ ...leaky, exchanges: [{ question: 'Hi?', answer: '' }] });
    expect(none).toContain('Orbit 0.1.257 · web');
    expect(none).toContain('(no answer)');
  });

  it('keeps ordinary words: help paths, routes and plain prose are not taken for keys or repositories', () => {
    const plain = scrubForReport('Open Settings → Machines at /settings/machines and read help/machines-and-engines/a-machine-shows-offline. Add a key: open Settings.');
    expect(plain).toBe('Open Settings → Machines at /settings/machines and read help/machines-and-engines/a-machine-shows-offline. Add a key: open Settings.');
  });
});

describe('the issue', () => {
  it('the title is the first question, scrubbed', () => {
    expect(reportTitle(`Why does ${REPOS.workspace} fail?`, leaky.privateNames)).toBe('Help: Why does [name removed] fail?');
  });

  it('opens a new issue on the release repository with title and body filled in', () => {
    const url = new URL(reportIssueUrl('jianghailong-xy/orbit', 'Help: x', 'the body'));
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/jianghailong-xy/orbit/issues/new');
    expect(url.searchParams.get('title')).toBe('Help: x');
    expect(url.searchParams.get('body')).toBe('the body');
  });

  it('a whole report stays a URL GitHub opens', () => {
    const long = 'word '.repeat(5000);
    const url = reportIssueUrl('jianghailong-xy/orbit', 'Help', reportBody({ ...leaky, exchanges: Array(5).fill({ question: long, answer: long }) }));
    expect(url.length).toBeLessThan(16_000);
  });
});
