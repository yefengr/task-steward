import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'docs/**', 'spikes/**', '.pi/**', '.claude/**'] },
  ...tseslint.configs.recommended,
);
