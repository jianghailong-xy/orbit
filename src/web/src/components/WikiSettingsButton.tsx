import { SettingOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { WIKI_SETTINGS, wikiSettingsPath } from '../lib/wikiReviewMode';

/**
 * The Wiki head's way into the space's settings (mock 11 ①): `⚙ Settings` beside New entry, and the
 * gear alone on a phone, where the head keeps its buttons to their icons (mock 12 ①).
 */
export function WikiSettingsButton({ spaceSlug }: { spaceSlug: string }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <Button icon={<SettingOutlined />} aria-label={WIKI_SETTINGS} onClick={() => navigate(wikiSettingsPath(spaceSlug))}>
      {phone ? null : WIKI_SETTINGS}
    </Button>
  );
}
