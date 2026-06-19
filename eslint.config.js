// @ts-check
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // The `const Foo = z.object(...)` + `type Foo = z.infer<...>` idiom shares a
      // name across the value and type namespaces (a deliberate, widespread zod
      // pattern). Both the core and TS `no-redeclare` rules misflag it; genuine
      // redeclarations are already caught by `tsc`, so disable both here.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'off',
      // Business logic must be strongly typed — no `any` escapes (code-style.md).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // No silent catches: empty blocks are forbidden (code-style.md).
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'off',
    },
  },
  {
    // Tests may use a looser style.
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
];
