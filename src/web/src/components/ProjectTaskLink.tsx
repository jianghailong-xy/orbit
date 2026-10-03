import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { projectTaskLink } from '../lib/projectTaskRoute';

/**
 * A link, on a project's page, to one of the project's tasks: it opens the task over this page
 * (lib/projectTaskRoute), a new history entry from the page and a replacement from a task already
 * open over it. A real `<a href>`, so ⌘/middle-click still opens the task in a tab of its own.
 */
export function ProjectTaskLink({
  projectId,
  taskId,
  children,
  ...rest
}: {
  projectId: string;
  taskId: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const location = useLocation();
  const link = projectTaskLink(location, projectId, taskId);
  return (
    <Link {...rest} to={link.to} replace={link.replace} state={link.state}>
      {children}
    </Link>
  );
}
