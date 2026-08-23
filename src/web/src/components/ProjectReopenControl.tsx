import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { api } from '../api';
import { projectReopenPreviewQuery } from '../lib/queries';
import type { ReopenImpact } from '../lib/attribution';

/**
 * Unit L7: reopening a settled project, with what it costs said before it is spent.
 *
 * A reopen is not an undo. It starts a NEW acceptance epoch, and every PASS the project has stops
 * being current the moment it commits — readable afterwards, and no longer a claim about the world
 * the project is now in. That is a large consequence behind a small status change, and until this
 * unit the only place it was written down was a database trigger.
 *
 * SO THE CONFIRMATION IS A NUMBER, NOT A CHECKBOX. The preview hands back the epoch the project is
 * at; pressing confirm sends that number back, and the server refuses if the project has moved
 * since (`REOPEN_ACKNOWLEDGEMENT_STALE`). A checkbox proves a second button was pressed. This
 * proves it was pressed on the project as it actually stands — which is the difference that
 * matters when the same project is open in two tabs.
 */

/** What the confirmation says, as data. Exported because it is the claim being made: a prompt that
 *  did not name both epochs and the count would be a confirmation of nothing in particular. */
export function reopenPrompt(impact: ReopenImpact): {
  headline: string;
  detail: string;
  acknowledgement: string | null;
} {
  return {
    headline: `Reopen this project? Acceptance epoch ${impact.fromEpoch} → ${impact.toEpoch}.`,
    detail:
      `${impact.retiringRuns} acceptance attempt${impact.retiringRuns === 1 ? '' : 's'} `
      + `${impact.retiringRuns === 1 ? 'is' : 'are'} retired. They stay readable and stop counting: `
      + 'the project cannot be DONE again until acceptance passes in the new epoch.'
      + (impact.wasLegacy
        ? ' This project was accepted under the pre-acceptance compatibility stamp, which the '
          + 'reopen also drops — its next DONE has to earn a run like any other.'
        : ''),
    acknowledgement: impact.acknowledgement,
  };
}

/** The write. The epoch the preview handed out is echoed back; that echo IS the confirmation. */
export function reopenProject(projectId: string, acknowledgement: string): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/reopen`, {
    method: 'POST',
    body: { acknowledgedAcceptanceEpoch: acknowledgement },
  });
}

/** The body, split out so a test can render every state against a fixture. */
export function ReopenBody({
  impact,
  confirming,
  busy,
  error,
  onAsk,
  onCancel,
  onConfirm,
}: {
  impact: ReopenImpact;
  confirming: boolean;
  busy: boolean;
  error: Error | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: (acknowledgement: string) => void;
}) {
  const prompt = reopenPrompt(impact);
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Tag aria-label={`Project status ${impact.status}`}>{impact.status}</Tag>
        <Typography.Text style={{ fontVariantNumeric: 'tabular-nums' }}>
          {`acceptance epoch ${impact.fromEpoch}`}
        </Typography.Text>
        {impact.wasLegacy ? <Tag aria-label="Accepted under the legacy stamp">LEGACY</Tag> : null}
      </div>

      {!impact.settled ? (
        // Not an error and not a button: an OPEN project has nothing to reopen, and the server
        // says so with a code rather than with a sentence, so the code is what is shown.
        <div style={{ marginTop: 8 }}>
          <Typography.Text code>{impact.refusalCode ?? 'PROJECT_NOT_SETTLED'}</Typography.Text>{' '}
          <Typography.Text type="secondary">{impact.requiredAction}</Typography.Text>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 8 }}>
            <Typography.Text>{prompt.headline}</Typography.Text>
            <div>
              <Typography.Text type="secondary">{prompt.detail}</Typography.Text>
            </div>
          </div>
          {error ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 8 }}
              message="This project was not reopened"
              description={error.message}
            />
          ) : null}
          <Space style={{ marginTop: 8 }}>
            {confirming ? (
              <>
                <Button
                  danger
                  type="primary"
                  size="small"
                  loading={busy}
                  disabled={prompt.acknowledgement === null}
                  onClick={() => onConfirm(prompt.acknowledgement!)}
                >
                  {`Yes, reopen at epoch ${impact.toEpoch}`}
                </Button>
                <Button size="small" disabled={busy} onClick={onCancel}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="small" onClick={onAsk}>
                Reopen…
              </Button>
            )}
          </Space>
        </>
      )}
    </div>
  );
}

/**
 * The card. Drawn on every project, including OPEN ones, because "nothing to reopen" is an answer
 * a reader is entitled to see rather than a section that silently is not there.
 */
export function ProjectReopenControl({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const preview = useQuery({
    ...projectReopenPreviewQuery(projectId),
    enabled: Boolean(projectId),
  });
  const [confirming, setConfirming] = useState(false);
  const reopen = useMutation({
    mutationFn: (acknowledgement: string) => reopenProject(projectId, acknowledgement),
    onSuccess: () => {
      setConfirming(false);
      // The project document, its acceptance standing, its crossings and this preview all move:
      // the prefix covers every one of them, and re-reading is what makes the next confirmation
      // about the epoch the project is in NOW.
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  return (
    <Card title="Reopen" size="small" style={{ marginTop: 16 }}>
      {preview.isPending ? (
        <Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : preview.isError ? (
        <Alert
          type="warning"
          showIcon
          message="Reopen impact could not be loaded"
          description={preview.error instanceof Error ? preview.error.message : undefined}
        />
      ) : preview.data ? (
        <ReopenBody
          impact={preview.data}
          confirming={confirming}
          busy={reopen.isPending}
          error={reopen.isError ? (reopen.error as Error) : null}
          onAsk={() => {
            reopen.reset();
            setConfirming(true);
          }}
          onCancel={() => setConfirming(false)}
          onConfirm={(acknowledgement) => reopen.mutate(acknowledgement)}
        />
      ) : null}
    </Card>
  );
}
