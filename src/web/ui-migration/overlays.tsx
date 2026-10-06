import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OverlaysFixture } from '../src/components/ui/__fixtures__/OverlaysFixture';

createRoot(document.getElementById('root')!).render(<StrictMode><OverlaysFixture /></StrictMode>);
