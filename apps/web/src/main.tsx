import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import './pwa-theme.css';
import './styles.css';
import { App } from './app';
import { createStewardTheme, stewardCssVariablesResolver } from './lib/ui/steward-theme';

const root = document.getElementById('root');
if (!root) throw new Error('Missing Task Steward root');
createRoot(root).render(<MantineProvider defaultColorScheme="auto" theme={createStewardTheme()}
  colorSchemeManager={localStorageColorSchemeManager({ key: 'pi-steward-appearance' })} cssVariablesResolver={stewardCssVariablesResolver}>
  <App />
</MantineProvider>);
