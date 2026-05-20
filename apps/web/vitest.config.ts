import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { mergeConfig, defineConfig as defineViteConfig } from 'vite';
import { defineConfig } from 'vitest/config';

export default mergeConfig(
  defineViteConfig({
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@pstn-twilio/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    },
  }),
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
);
