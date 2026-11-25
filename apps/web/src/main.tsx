import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import { LucideProvider } from 'lucide-react';
import { usePwaTheme, pwaCssVariablesResolver } from '@yefengr/pwa-foundation/mantine';
import '@mantine/core/styles.css';
import '@yefengr/pwa-foundation/foundation.css';
import '@yefengr/pwa-foundation/theme.css';
import '@yefengr/pwa-foundation/controls.css';
import './pwa-theme.css';
import './styles.css';
import { App } from './app';

function Ui() {
  const theme = usePwaTheme();
  return <LucideProvider strokeWidth={1.5} absoluteStrokeWidth>
    <MantineProvider defaultColorScheme="auto" theme={theme}
      colorSchemeManager={localStorageColorSchemeManager({ key: 'pi-steward-appearance' })} cssVariablesResolver={pwaCssVariablesResolver}>
      <App />
    </MantineProvider>
  </LucideProvider>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing Task Steward root');
// 默认 Portal 挂载到 body，作用域同时覆盖页面和浮层。
document.body.classList.add('pwa-ui-scope');
createRoot(root).render(<Ui />);
