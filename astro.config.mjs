// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

/** @param {string | undefined} value */
const normalizeBase = (value) => {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/|\/$/g, '')}/`;
};

const base = normalizeBase(process.env.BASE_PATH);

export default defineConfig({
  site: process.env.SITE_URL,
  base,
  output: 'static',
  integrations: [react()],
  build: {
    assets: 'assets',
    inlineStylesheets: 'auto'
  },
  vite: {
    worker: {
      format: 'es'
    }
  }
});
