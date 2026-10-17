import { cloneElement, isValidElement, useEffect, type ComponentProps, type ReactElement } from 'react';
import type { ReviewCard as ReviewCardComponent } from '../components/ReviewCard';

/** Card contract tests render the complete form. Dialog interaction tests use the real shell. */
export function ReviewCard({ children, id, onOpenChange }: ComponentProps<typeof ReviewCardComponent>) {
  useEffect(() => { onOpenChange(true); }, [onOpenChange]);
  return id && isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children;
}
