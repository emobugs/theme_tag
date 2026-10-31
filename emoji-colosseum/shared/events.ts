import type { TeamId } from './config';

export interface Viewer {
  id: string;
  name: string;
  avatar?: string;
}

// Нормализирани събития: еднакви независимо дали идват от TikTok, симулатор или контролния панел.
export type LiveEvent =
  | { kind: 'join'; user: Viewer; team: TeamId; switched: boolean }
  | { kind: 'gift'; user: Viewer; team: TeamId; coins: number; count: number; giftName: string; giftImage?: string }
  | { kind: 'like'; user: Viewer; team: TeamId | null; count: number }
  | { kind: 'share'; user: Viewer; team: TeamId | null }
  | { kind: 'follow'; user: Viewer; team: TeamId | null };

export interface GifterRow {
  id: string;
  name: string;
  avatar?: string;
  team: TeamId;
  coins: number;
}

export interface FameRow {
  name: string;
  team: TeamId;
  coins: number;
  at: number;
}

export interface StatsSnapshot {
  date: string;
  members: Record<TeamId, number>;
  roundCoins: Record<TeamId, number>;
  roundTop: GifterRow[];
  todayTop: GifterRow[];
  todayWins: Record<TeamId, number>;
  allTimeWins: Record<TeamId, number>;
  fame: FameRow[];
  rounds: number;
}

export type SourceKind = 'tiktok' | 'sim' | 'offline';

export type ServerMsg =
  | { t: 'hello'; primary: boolean; source: SourceKind; status: string; sim: boolean }
  | { t: 'status'; source: SourceKind; status: string; sim: boolean }
  | { t: 'primary'; primary: boolean }
  | { t: 'event'; e: LiveEvent }
  | { t: 'stats'; s: StatsSnapshot };

// Събития, които контролният панел може да инжектира (минават през същата логика като TikTok).
export type InjectMsg =
  | { kind: 'chat'; name: string; text: string }
  | { kind: 'gift'; name: string; team?: TeamId; coins: number; count: number; giftName?: string }
  | { kind: 'like'; name: string; count: number }
  | { kind: 'share'; name: string }
  | { kind: 'follow'; name: string };

export type ClientMsg =
  | { t: 'role'; role: 'overlay' | 'control' }
  | { t: 'inject'; e: InjectMsg }
  | { t: 'sim'; on: boolean }
  | { t: 'roundStart'; roundId: string }
  | { t: 'roundEnd'; roundId: string; winner: TeamId | null; reason: RoundEndReason; by?: { name: string; coins: number } };

export type RoundEndReason = 'time' | 'last' | 'crown' | 'none';
