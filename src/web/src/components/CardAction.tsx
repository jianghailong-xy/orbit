import type { JSX, ReactNode } from 'react';

/**
 * The action row and the action button every card that asks the reader for something renders.
 *
 * WHY ONE COMPONENT AND NOT TWO CARDS THAT LOOK ALIKE
 * --------------------------------------------------
 * The approval card's shape was settled by three rounds of beta and a screenshot: an action is a
 * full-width control at the system's default control size, not a 50pt slab, and the 44pt tap
 * target is spent on the OPTION rows instead — a mis-tapped option costs more than a mis-tapped
 * button. Those numbers are a decision somebody made once, and a second card that reinvents them
 * is a second card that will drift from them. So the sizes live here, in one class, and every card
 * that wants an action asks for one.
 *
 * WHAT IS NOT SHARED
 * ------------------
 * Only the affordance. The approval card blocks a running turn, is answered by whoever is at the
 * screen, and dies when it is answered; the decision rail is a derived read of durable facts,
 * answered mostly by another agent, and answering one changes nothing about the others. Nothing
 * here reaches into either of those: no card lifecycle, no delivery channel, no submit semantics —
 * a button, a row to put it in, and the one rule below.
 *
 * THE ONE RULE
 * ------------
 * An action that cannot succeed is `disabled`. Not hidden, not lit-and-then-refused: a control the
 * reader can press and that always fails teaches them the card is lying, and that is precisely the
 * state the decision rail was found in — a card headed DECISION REQUIRED whose primary action was
 * refused by the door every single time. Each card computes what "cannot succeed" means for its
 * own door; what this file guarantees is that the answer arrives as `disabled` and looks the same
 * in both places.
 */

/** The four looks the app already had, named for what they say rather than for which card had them. */
export type CardActionTone = 'primary' | 'secondary' | 'accent' | 'outline';

/** The size tokens. Named so a test can assert both cards render the same one. */
export const CARD_ACTION_CLASS = 'card-action';
export const CARD_ACTIONS_CLASS = 'card-actions';

/** The row an action sits in: horizontal with room to breathe, stacked full width on a phone. */
export function CardActions({
  className,
  children,
}: {
  /** The owning card's own spacing — where the row sits, never how the buttons inside it look. */
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={className ? `${CARD_ACTIONS_CLASS} ${className}` : CARD_ACTIONS_CLASS}>
      {children}
    </div>
  );
}

/** One action. `disabled` is the whole of "this would not work", and is never styled away. */
export function CardActionButton({
  tone = 'secondary',
  disabled = false,
  title,
  onClick,
  children,
}: {
  tone?: CardActionTone;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${CARD_ACTION_CLASS} ${CARD_ACTION_CLASS}--${tone}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
