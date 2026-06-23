// @ts-check
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    // `deploy/**` is infrastructure tooling (shell scripts, JSON policies, and the
    // CloudFront edge Function) — not app source: it isn't built or imported, and the
    // CloudFront Function intentionally defines a global `handler` the edge runtime
    // invokes (which the app's `no-unused-vars`/module rules would misflag).
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**', 'deploy/**'],
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
      // Node runtime globals. TypeScript (with @types/node) already verifies these
      // far more accurately than the core `no-undef` rule, which we disable below.
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        globalThis: 'readonly',
        NodeJS: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript handles undefined-identifier checking; the core rule produces
      // false positives on type-only names (e.g. the NodeJS namespace).
      'no-undef': 'off',
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
  {
    // Plain-Node maintenance scripts (run via `node`, not tsx) — e.g. the Postman
    // collection finalizer. Give them the Node globals they use; no TS parser needed.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  prettier,
];
