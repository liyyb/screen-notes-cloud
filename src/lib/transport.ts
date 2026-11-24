/**
 * One transport contract for both backends:
 *  - Tauri 2 (Rust): uses window.__TAURI_INTERNALS__ + invoke()
 *  - Local demo runtime (Node): POST /api/<command> on 127.0.0.1
 *
 * The UI never depends on which backend is running.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __SCREEN_NOTES_API_BASE__?: string;
    __SCREEN_NOTES_BACKEND__?: string;
  }
}

export function backendName(): string {
  if (typeof window === 'undefined') return 'node';
  return window.__SCREEN_NOTES_BACKEND__ ?? (window.__TAURI_INTERNALS__ ? 'tauri' : 'node');
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(command, args)) as T;
  }
  const base = window.__SCREEN_NOTES_API_BASE__ ?? '';
  let response: Response;
  try {
    response = await fetch(`${base}/api/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
  } catch (e) {
    throw new Error(`无法连接本地服务：${(e as Error).message}`);
  }
  let payload: { data?: T; error?: string };
  try {
    payload = await response.json();
  } catch {
    throw new Error(`本地服务返回异常 (HTTP ${response.status})`);
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload.data as T;
}
