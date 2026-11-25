import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';

// The native shell finds (and hides) this window by its exact title during capture.
document.title = '屏幕笔记 · 笔记库';

const target = document.getElementById('app');
if (!target) throw new Error('#app not found');

// Svelte 5 mount API; falls back to the legacy constructor when running with Svelte 4.
const app = (mount as unknown as (comp: unknown, opts: unknown) => unknown)(App, { target });
export default app;
