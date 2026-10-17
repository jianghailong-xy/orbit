// Evidence page (never committed): the web transcript's own <Transcript>, under the app's own
// stylesheets in the app's order (main.tsx), with five conversations that each end on an answered
// question — the same five the iPhone/Mac probe photographs (.aqc-probe/stub.py).
import './components/ui/Overlay.css';
import './components/ReviewCard.css';
import 'antd/dist/reset.css';
import './index.css';
import './components/ui/foundation.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Transcript, type RunEvent } from './components/Transcript';

const SWIPE_Q =
  "On iPad, what should a swipe right from the left edge do? Today there are two places on the iPad where the swipe does nothing: (1) the hidden sidebar only opens from the toolbar button; (2) the in-column pages with a Back button (a folder's page, a project's sessions page, a task opened over its project, a runner's engine or name page) only go back from that button. On the iPhone the same swipe opens the drawer on a list page and goes back on a pushed page.";
const SWIPE = {
  question: SWIPE_Q,
  header: 'Swipe right',
  multiSelect: false,
  options: [
    {
      label: 'Both, like the iPhone (Recommended)',
      description:
        "On a list page, swiping right from the screen's left edge opens the sidebar (swiping left on it closes it). On an in-column page with a Back button, swiping right from that column's left edge goes back one page.",
    },
    { label: 'Open the sidebar only', description: "Swiping right from the screen's left edge opens the sidebar; going back still uses only the Back button." },
    { label: 'Swipe back only', description: 'On an in-column page with a Back button, swiping right goes back; the sidebar still opens only from the toolbar button.' },
  ],
};
const TOP_Q =
  'When a project page is opened from the session list (or from a folder), swiping from the left edge will go back to that list. What should the top-left button be on that page?';
const TOP = {
  question: TOP_Q,
  header: 'Top-left',
  multiSelect: false,
  options: [
    { label: '‹ Back (Recommended)', description: 'Standard iOS: the button and the swipe both go back to the list.' },
    { label: 'Keep ☰', description: '☰ opens the drawer and the edge swipe goes back.' },
  ],
};
const CLIENTS_Q = 'Which clients should get the new card in this change?';
const CLIENTS = {
  question: CLIENTS_Q,
  header: 'Clients',
  multiSelect: true,
  options: [
    { label: 'iOS and macOS', description: 'One SwiftUI view serves both.' },
    { label: 'Web', description: 'The same words, in its own component.' },
    { label: 'Android', description: 'No per-tool cards there yet; this would be the first.' },
  ],
};
const TRAILER =
  '. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
const answered = (...pairs: [string, string][]) =>
  'The user answered: ' + pairs.map(([q, a]) => `"${q}"="${a}"`).join(', ') + TRAILER;
const ASKING =
  "Two places on the iPad ignore the swipe today, and on a list page they want different things from the same gesture — so I'm asking before I change either.";

const SCENARIOS: { id: string; title: string; questions: unknown[]; result: string; isError: boolean; after: string }[] = [
  { id: 'q1', title: 'One question', questions: [SWIPE], result: answered([SWIPE_Q, 'Both, like the iPhone (Recommended)']), isError: false,
    after: 'Both, then. The sidebar first: on a list page an edge swipe opens it, and a left swipe on it closes it.' },
  { id: 'q2', title: 'Two questions', questions: [SWIPE, TOP], result: answered([SWIPE_Q, 'Open the sidebar only'], [TOP_Q, '‹ Back (Recommended)']), isError: false,
    after: 'The sidebar only, and ‹ Back on a project page opened from the list. Starting with the sidebar.' },
  { id: 'q3', title: 'Typed answer', questions: [SWIPE], result: answered([SWIPE_Q, 'Only on list pages for now; leave going back to the button.']), isError: false,
    after: 'List pages only, then: the edge swipe opens the sidebar there, and Back stays a button.' },
  { id: 'q4', title: 'Multiple choice', questions: [CLIENTS], result: answered([CLIENTS_Q, 'Web,iOS and macOS']), isError: false,
    after: 'iOS, macOS and the web, then. Android waits until it has per-tool cards.' },
  { id: 'q5', title: 'Reply in chat', questions: [SWIPE], result: "Before I pick: does the left swipe still close the sidebar once it's open?", isError: true,
    after: "It does: once the sidebar is open, a left swipe anywhere on it closes it, as the drawer does on the iPhone." },
];

const events = (s: (typeof SCENARIOS)[number]): RunEvent[] => [
  { seq: 1, type: 'user', ts: '2026-10-10T02:08:00.000Z', payload: { text: 'On the iPad, a swipe from the left edge does nothing.' } },
  { seq: 2, type: 'assistant', ts: '2026-10-10T02:09:00.000Z', payload: { text: ASKING } },
  { seq: 3, type: 'tool_use', ts: '2026-10-10T02:09:01.000Z', payload: { id: 'toolu_q', name: 'AskUserQuestion', input: { questions: s.questions } } },
  { seq: 4, type: 'tool_result', ts: '2026-10-10T02:14:00.000Z', payload: { toolUseId: 'toolu_q', content: s.result, isError: s.isError } },
  { seq: 5, type: 'assistant', ts: '2026-10-10T02:14:05.000Z', payload: { text: s.after } },
];

function Page() {
  return (
    <MemoryRouter>
      {SCENARIOS.map((s) => (
        <section className="shot-scn" id={s.id} key={s.id}>
          <div className="shot-title">{s.title}</div>
          <Transcript events={events(s)} />
        </section>
      ))}
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
