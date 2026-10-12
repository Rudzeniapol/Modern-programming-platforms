'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-var': 'error'
};

module.exports = [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    // Сервер и тесты — Node.js, CommonJS.
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { ...rules, 'no-console': 'error', strict: ['error', 'global'] }
  },
  {
    // Клиент — браузер, ES-модули, без сборщика и фреймворков.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules
  }
];
