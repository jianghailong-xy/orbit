import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { createRoot } from 'react-dom/client';
import { FoundationFixture } from '../src/components/ui/__fixtures__/FoundationFixture';

createRoot(document.getElementById('root')!).render(<FoundationFixture />);
