import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactNative from 'eslint-plugin-react-native'
import prettier from 'eslint-config-prettier'

export default [
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        __DEV__: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
        // RN runtime globals used by the Puncheoke bridge client.
        WebSocket: 'readonly',
        WebSocketMessageEvent: 'readonly',
        // Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time — the
        // documented way to read a build-time flag in app code.
        process: 'readonly',
        // Jest globals (test files) — narrow the impact by only listing what
        // our tests actually use.
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-native': reactNative,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      ...reactPlugin.configs['recommended'].rules,
      ...reactHooks.configs['recommended'].rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Web-only modules. Metro picks a `*.web.ts` over its sibling for the PC
    // build and the tablet never bundles it, so these may use the page's
    // globals — and nothing else in `src` may.
    files: ['src/**/*.web.{ts,tsx}'],
    languageOptions: {
      globals: {
        navigator: 'readonly',
        document: 'readonly',
        window: 'readonly',
        FileSystemFileHandle: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    // The verifier and guard scripts. Every QA verdict and two CI gates rest
    // on these, and until 2026-11-25 `tools/**` was ignored wholesale: plain
    // JavaScript that neither eslint nor tsc ever read. Linted with the
    // recommended rules above; type-checked by `npm run typecheck:tools`.
    files: [
      'tools/analysis/**/*.{mjs,js}',
      'tools/guards/**/*.mjs',
      'tools/dev/**/*.mjs',
      'tools/pc/**/*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        structuredClone: 'readonly',
        // Built into node 22 and later; the PC smoke test drives a browser
        // through it (`tools/pc/app/cdp.mjs`).
        WebSocket: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // The drivers wrap best-effort device pokes and teardown — kill a
      // process that may already be gone, dismiss a keyguard that may not be
      // up — in `try {} catch {}`. All sixteen were read; none hides a result.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The verifiers' own tests: ES modules, transformed and run by jest.
    files: [
      'tools/analysis/__tests__/**/*.js',
      'tools/dev/__tests__/**/*.js',
      'tools/pc/**/__tests__/**/*.js',
    ],
    languageOptions: {
      globals: {
        require: 'readonly',
        __dirname: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
  },
  {
    // The PC glove check (`npm run pc:glove-check`): TypeScript that runs in a
    // browser page, importing the app's protocol code. Same rules as `src`,
    // minus React, plus the page's globals.
    files: ['tools/pc/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        HTMLElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLTableCellElement: 'readonly',
        HTMLTemplateElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        DocumentFragment: 'readonly',
        Navigator: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Everything else under tools/ stays out for now: the voice and avatar
    // pipelines, the spikes, and Puncheoke's bridge and tablet-voice tools.
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'dist/**',
      '.expo/**',
      'coverage/**',
      'captures/**',
      'artifacts/**',
      'tools/audition/**',
      'tools/avatar/**',
      'tools/backlog/**',
      'tools/effects/**',
      'tools/punchbridge/**',
      'tools/spike/**',
      'tools/spikes/**',
      'tools/tablet-voice/**',
      'tools/voice/**',
      'tools/analysis/manifests/**',
      'tools/analysis/suites/**',
      'tools/analysis/monitor/**',
      'tools/analysis/reports/**',
    ],
  },
]
