import ReactMarkdown, { type Options } from 'react-markdown';
import { mendCjkBold } from '../lib/cjkBold';

/** `react-markdown`, reading bold that CJK punctuation would leave drawn with its stars. */
export default function Markdown({ children, ...options }: Options) {
  return <ReactMarkdown {...options}>{children ? mendCjkBold(children) : children}</ReactMarkdown>;
}
