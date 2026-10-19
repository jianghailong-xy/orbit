import { InfoCircleOutlined } from '@ant-design/icons';
import type { WikiSystemModelStatus } from '@orbit/shared';
import { WIKI_PRIVACY_NOTE } from '../lib/wikiReviewMode';
import { WIKI_MODEL_STATE_WORDS, WIKI_SYSTEM_MODEL, wikiModelTone } from '../lib/wikiRuns';

/**
 * The deployment's System model as the wiki names it (mock 35 ①–④): `System model · qwen3.8-27b-fp8` and its
 * state — green while it is up, amber while it cannot be reached (it comes back by itself), red for what somebody
 * has to set right. Never its address or its key, which no read carries. The settings page, Set up and the Runs
 * card's head all say it this way.
 */
export function WikiModelLine({ model }: { model: Pick<WikiSystemModelStatus, 'state' | 'model'> }) {
  const tone = wikiModelTone(model.state);
  return (
    <span className="wk-model-line">
      {WIKI_SYSTEM_MODEL}
      {model.model && <span className="dim"> · {model.model}</span>}
      <span className={`wk-model-state ${tone}`}>
        <span className="wk-dot" aria-hidden="true" />
        {WIKI_MODEL_STATE_WORDS[model.state]}
      </span>
    </span>
  );
}

/** Where the wiki's material goes while the server runs it (design §2.2): the deployment's own System model. */
export function WikiPrivacyNote() {
  return (
    <div className="wk-privacy">
      <InfoCircleOutlined className="ic" />
      <span>{WIKI_PRIVACY_NOTE}</span>
    </div>
  );
}
