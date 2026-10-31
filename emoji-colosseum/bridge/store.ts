import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedState } from '../shared/room';

// JSON файл с атомарен запис (temp + rename), за да не се повреди при спиране на тока.

export function loadState(file: string): PersistedState | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
  } catch {
    return undefined;
  }
}

export function createSaver(file: string, getState: () => PersistedState, delayMs = 2000) {
  mkdirSync(dirname(file), { recursive: true });
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(getState()));
      renameSync(tmp, file);
    } catch (err) {
      console.error('[store] неуспешен запис', err);
    }
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(flush, delayMs);
  };

  return { schedule, flush };
}
