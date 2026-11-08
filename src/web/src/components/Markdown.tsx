import ReactMarkdown, { type Options } from 'react-markdown';
import { mendCjkMarkdown } from '../lib/cjkMarkdown';

/** `react-markdown`, reading the bold and the bare URLs that CJK running straight on from them would break. */
export default function Markdown({ children, ...options }: Options) {
  return <ReactMarkdown {...options}>{children ? mendCjkMarkdown(children) : children}</ReactMarkdown>;
}
