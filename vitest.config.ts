// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}']
  }
});
