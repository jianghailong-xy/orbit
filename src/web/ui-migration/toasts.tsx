import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastsFixture } from '../src/components/ui/__fixtures__/ToastsFixture';

createRoot(document.getElementById('root')!).render(<StrictMode><ToastsFixture /></StrictMode>);
