import { describe, expect, it } from 'vitest';
import {
  isCompleteShortcutEligible,
  scopedAttachmentCreateBlockedMessage,
  sessionCapabilityOf,
  sessionResumeBlockedMessage,
  sessionResumeBlockedReasonOf,
  sessionSendBlockedMessage,
  sessionSendDispositionOf,
} from './sessionCapabilities';

describe('isCompleteShortcutEligible', () => {
  it('allows an Open detail selected from a non-Open surrounding scope', () => {
    expect(
      isCompleteShortcutEligible({ capabilities: { canComplete: true } }, 'OPEN'),
    ).toBe(true);
  });

  it('rejects a Completed detail and an explicit server denial', () => {
    expect(
      isCompleteShortcutEligible({ capabilities: { canComplete: true } }, 'COMPLETED'),
    ).toBe(false);
    expect(
      isCompleteShortcutEligible({ capabilities: { canComplete: false } }, 'OPEN'),
    ).toBe(false);
  });
});

describe('sessionCapabilityOf', () => {
  it('prefers an explicit server boolean over the legacy local fallback', () => {
    const session = {
      capabilities: {
        canSend: false,
        canResume: false,
        canComplete: true,
        canRestore: false,
      },
    };

    expect(sessionCapabilityOf(session, 'canSend', true)).toBe(false);
    expect(sessionCapabilityOf(session, 'canResume', true)).toBe(false);
    expect(sessionCapabilityOf(session, 'canComplete', false)).toBe(true);
    expect(sessionCapabilityOf(session, 'canRestore', true)).toBe(false);
  });

  it('uses the local fallback for old or partial payloads', () => {
    expect(sessionCapabilityOf({}, 'canResume', true)).toBe(true);
    expect(sessionCapabilityOf({ capabilities: {} }, 'canComplete', false)).toBe(false);
  });

  it('prefers canComplete and falls back to the legacy canArchive capability', () => {
    expect(
      sessionCapabilityOf(
        { capabilities: { canComplete: false, canArchive: true } },
        'canComplete',
        true,
      ),
    ).toBe(false);
    expect(
      sessionCapabilityOf({ capabilities: { canArchive: true } }, 'canComplete', false),
    ).toBe(true);
  });
});

describe('scopedAttachmentCreateBlockedMessage', () => {
  it('directs the user to re-add old-session attachments instead of silently dropping them', () => {
    expect(scopedAttachmentCreateBlockedMessage(1)).toBe(
      'This session can no longer be resumed, and the attachment belongs to it. Open New session and re-add the attachment before sending.',
    );
    expect(scopedAttachmentCreateBlockedMessage(2)).toBe(
      'This session can no longer be resumed, and the attachments belong to it. Open New session and re-add the attachments before sending.',
    );
  });
});

describe('sessionSendDispositionOf', () => {
  it('blocks a live run when the server denies send instead of creating a replacement', () => {
    expect(
      sessionSendDispositionOf(
        { runState: 'RUNNING', capabilities: { canSend: false } },
        false,
      ),
    ).toBe('BLOCK');
  });

  it('dispatches a freshly fetched terminal session from authoritative canResume', () => {
    expect(
      sessionSendDispositionOf(
        { runState: 'SUCCEEDED', capabilities: { canResume: true } },
        false,
      ),
    ).toBe('RESUME');
    expect(
      sessionSendDispositionOf(
        { runState: 'SUCCEEDED', capabilities: { canResume: false } },
        true,
      ),
    ).toBe('CREATE');
  });

  it('requires umbrella canSend authorization before resuming', () => {
    expect(
      sessionSendDispositionOf(
        {
          runState: 'SUCCEEDED',
          capabilities: { canResume: true, canSend: false },
        },
        true,
      ),
    ).toBe('BLOCK');
  });

  it('retains legacy fallbacks and always blocks Trash', () => {
    expect(sessionSendDispositionOf({ runState: 'RUNNING' }, false)).toBe('SEND');
    expect(sessionSendDispositionOf({ runState: 'SUCCEEDED' }, true)).toBe('RESUME');
    expect(
      sessionSendDispositionOf(
        { runState: 'SUCCEEDED', lifecycleState: 'TRASH', capabilities: { canResume: true } },
        true,
      ),
    ).toBe('BLOCK');
  });
});

describe('session capability reasons', () => {
  it('accepts only known resume blockers', () => {
    expect(
      sessionResumeBlockedReasonOf({ capabilities: { resumeBlockedReason: 'MISSING_CONTEXT' } }),
    ).toBe('MISSING_CONTEXT');
    expect(
      sessionResumeBlockedReasonOf({
        capabilities: { resumeBlockedReason: 'FUTURE_REASON' as never },
      }),
    ).toBeNull();
  });

  it.each([
    ['TRASHED', 'Restore this session to Open before resuming.'],
    ['ENDING', 'This session is ending. Try again when it finishes.'],
    ['NOT_TERMINAL', 'This session is still active and does not need to be resumed.'],
    ['NOT_STARTED', 'This session never started, so there is no context to resume.'],
    ['MISSING_CONTEXT', 'The previous session context is no longer available.'],
    ['NO_RUNNER', 'No runner is assigned to this session.'],
    ['RUNNER_OFFLINE', 'The assigned runner is offline.'],
  ] as const)('maps %s to useful resume copy', (reason, copy) => {
    expect(sessionResumeBlockedMessage(reason)).toBe(copy);
  });

  it('uses send-specific copy for a session that is still ending', () => {
    expect(sessionSendBlockedMessage('ENDING')).toBe(
      'This session is ending and cannot accept messages right now.',
    );
    expect(sessionSendBlockedMessage(null)).toBe(
      'This session cannot accept messages right now.',
    );
  });
});
