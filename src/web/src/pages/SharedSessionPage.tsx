import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchSharedAttachmentDataUrl, fetchSharedAttachmentObjectUrl, getSharedSession } from '../api';
import { AttachmentResolverContext, Transcript } from '../components/Transcript';

/**
 * Public, read-only view of a session shared via its token (`/s/<token>`). No auth, no app
 * shell — anyone with the link sees the transcript only. Images load through the public
 * share-attachment route (AttachmentResolverContext), so a logged-out viewer still sees them.
 */
export function SharedSessionPage() {
  const { token = '' } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared', token],
    queryFn: () => getSharedSession(token),
    enabled: !!token,
    retry: false,
  });
  const resolve = useMemo(() => (id: string) => fetchSharedAttachmentObjectUrl(token, id), [token]);
  const [downloading, setDownloading] = useState(false);

  // Build the same self-contained HTML the app's export produces, but embed images through
  // the public share route so a logged-out viewer's saved file still shows them.
  const download = async () => {
    if (!data || downloading) return;
    setDownloading(true);
    try {
      const { exportSessionHtml } = await import('../lib/sessionExport');
      await exportSessionHtml(
        {
          id: token,
          title: data.title,
          status: data.status,
          createdAt: data.createdAt,
          agent: { name: data.agentName },
        },
        data.events,
        (id) => fetchSharedAttachmentDataUrl(token, id),
      );
    } catch (e) {
      console.error('Download failed', e);
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="share-page">
        <div className="share-state">Loading…</div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="share-page">
        <div className="share-state">
          <div className="share-state-title">This shared link isn’t available</div>
          <div className="share-state-desc">It may have been revoked, or the link is incorrect.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="share-page">
      <header className="share-header">
        <div className="share-brand">Orbit</div>
        <div className="share-titlebar">
          <div className="share-title" title={data.title}>
            {data.title}
          </div>
          <div className="share-sub">
            {data.agentName && <span>{data.agentName}</span>}
            <span className="share-badge">Read-only</span>
          </div>
        </div>
        <button
          className="share-download"
          onClick={download}
          disabled={downloading || data.events.length === 0}
          aria-label="Download this conversation as a self-contained HTML file"
          title="Download this conversation as a self-contained HTML file"
        >
          {downloading ? (
            <span className="share-download-spin" aria-hidden />
          ) : (
            <svg
              className="share-download-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
          <span className="share-download-label">{downloading ? 'Preparing…' : 'Download HTML'}</span>
        </button>
      </header>
      <main className="share-scroll">
        <div className="share-inner">
          <AttachmentResolverContext.Provider value={resolve}>
            <Transcript events={data.events} />
          </AttachmentResolverContext.Provider>
        </div>
      </main>
      <footer className="share-footer">Shared from Orbit · read-only</footer>
    </div>
  );
}
