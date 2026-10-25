import { GlobalOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getShareLink } from '../api';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { wikiSpacePath } from '../lib/wiki';
import { ShareModal, shareLinkQueryKey } from './ShareModal';
import { Button } from './ui/Button';

/**
 * The Wiki head's way to the space's public link (docs/share-links-design.md §10, mock share-links
 * 08 ① ②): `Share` beside Settings while the space has none, and the project header's
 * `Shared · Live` pill while it has one — either opening the Share dialog. The link is the space's,
 * not the page's, which is why it is in the head every Wiki page wears. Whether one is open is read
 * under the dialog's own key, so a change made there shows here at once. A phone keeps the head's
 * buttons to their icons (mock 12 ①).
 */
export function WikiShareButton({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  const shareQ = useQuery({ queryKey: shareLinkQueryKey('WIKI', spaceId), queryFn: () => getShareLink('WIKI', spaceId) });
  const live = shareQ.data?.link != null && shareQ.data.link.state !== 'ENDED';
  return (
    <>
      {live ? (
        <button
          type="button"
          className="session-shared-pill"
          title="Anyone with the link can view this wiki — open its sharing settings"
          aria-label="Shared · Live"
          onClick={() => setOpen(true)}
        >
          <GlobalOutlined />
          {phone ? null : ' Shared · Live'}
        </button>
      ) : (
        <Button icon={<GlobalOutlined />} aria-label="Share" onClick={() => setOpen(true)}>
          {phone ? null : 'Share'}
        </Button>
      )}
      <ShareModal open={open} onClose={() => setOpen(false)} kind="WIKI" rootId={spaceId} appPath={wikiSpacePath(spaceSlug)} />
    </>
  );
}
