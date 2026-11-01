import type { Viewer } from '../shared/events';

// Общият интерфейс на всички платформи. Всеки адаптер (tiktok, twitch, youtube)
// превежда своите събития към тези извиквания, а bridge-ът върши останалото.

export interface PlatformSink {
  chat(user: Viewer, text: string): void;
  /** coins = стойност на ЕДИН подарък в монети (≈ центове), count = колко пъти */
  gift(user: Viewer, coins: number, count: number, giftName: string, giftImage?: string): void;
  like(user: Viewer, count: number): void;
  share(user: Viewer): void;
  follow(user: Viewer): void;
  status(text: string, connected: boolean): void;
}

export interface Adapter {
  stop(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
