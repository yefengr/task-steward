import { Button, createTheme, Modal } from '@mantine/core';
import type { CSSVariablesResolver } from '@mantine/core';
import { readPwaMotionDuration } from './motion-duration';

export function createStewardTheme() {
  return createTheme({
    primaryColor: 'steward',
    primaryShade: { light: 6, dark: 3 },
    colors: { steward: ['#EFF4FC', '#DDE7F7', '#BED2F3', '#98B8E6', '#7C9CD0', '#5F7FB4', '#446396', '#395687', '#2E4A78', '#223A61'] },
    fontFamily: 'var(--pwa-font-ui)',
    fontFamilyMonospace: 'var(--pwa-font-mono)',
    headings: { fontWeight: '600' },
    defaultRadius: 'sm',
    radius: { xs: 'var(--pwa-radius-xs)', sm: 'var(--pwa-radius-md)', md: 'var(--pwa-radius-md)', lg: 'var(--pwa-radius-lg)', xl: 'var(--pwa-radius-xl)' },
    breakpoints: { xs: '36em', sm: '48em', md: '62em', lg: '75em', xl: '88em' },
    respectReducedMotion: true,
    cursorType: 'pointer',
    components: {
      Button: Button.extend({ defaultProps: { size: 'md' } }),
      Modal: Modal.extend({ defaultProps: {
        centered: true, size: 480, radius: 'xl', overlayProps: { color: 'var(--pwa-scrim)', backgroundOpacity: 1 },
        transitionProps: { transition: 'fade', duration: readPwaMotionDuration('--pwa-duration-modal-in'),
          exitDuration: readPwaMotionDuration('--pwa-duration-modal-out') },
      } }),
    },
  });
}

const sharedVariables = {
  '--mantine-color-body': 'var(--pwa-bg)',
  '--mantine-color-text': 'var(--pwa-ink)',
  '--mantine-color-dimmed': 'var(--pwa-secondary)',
  '--mantine-color-default': 'var(--pwa-surface)',
  '--mantine-color-default-hover': 'var(--pwa-hover)',
  '--mantine-color-default-color': 'var(--pwa-ink)',
  '--mantine-color-default-border': 'var(--pwa-line)',
  '--mantine-color-anchor': 'var(--pwa-accent)',
  '--mantine-color-error': 'var(--pwa-error)',
  '--mantine-color-primary-filled': 'var(--pwa-accent)',
  '--mantine-color-primary-filled-hover': 'var(--pwa-accent-hover)',
  '--mantine-color-primary-contrast': 'var(--pwa-on-accent)',
  '--mantine-color-primary-light': 'var(--pwa-tonal)',
  '--mantine-color-primary-light-hover': 'var(--pwa-hover)',
  '--mantine-color-primary-light-color': 'var(--pwa-ink)',
};

export const stewardCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {}, light: sharedVariables, dark: sharedVariables,
});
