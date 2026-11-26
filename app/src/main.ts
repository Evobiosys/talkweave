// SPDX-License-Identifier: AGPL-3.0-or-later

import { mount } from 'svelte';
import App from './app.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) {
  throw new Error('main.ts: #app mount target not found');
}

const app = mount(App, { target });

export default app;
