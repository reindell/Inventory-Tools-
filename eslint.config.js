import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default ts.config(
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    ignores: [
      'dist/**',
      'dist-server/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      '.data/**',
      '.tmp/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { localStorage: 'readonly', document: 'readonly', matchMedia: 'readonly' },
    },
  },
  { files: ['server/**/*.js'], languageOptions: { globals: { Buffer: 'readonly' } } },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
);
