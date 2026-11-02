import { useHref, useLinkClickHandler } from 'react-router-dom';
import { LinkButton } from '../components/ui/Button';
import { Result } from '../components/ui/Result';

/** An address no route answers, signed in or out: it says so, and links back to the home page. */
export function NotFoundPage() {
  const home = useHref('/');
  const goHome = useLinkClickHandler<HTMLAnchorElement>('/');
  return (
    <Result
      status="404"
      title="Page not found"
      subTitle="This page doesn't exist or has moved."
      extra={<LinkButton variant="primary" href={home} onClick={goHome}>Go home</LinkButton>}
    />
  );
}
