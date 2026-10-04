import 'antd/dist/reset.css';
import '../src/index.css';
import '../src/components/ui/foundation.css';
import { createRoot } from 'react-dom/client';
import { ControlsFixture } from '../src/components/ui/__fixtures__/ControlsFixture';

createRoot(document.getElementById('root')!).render(<ControlsFixture />);
