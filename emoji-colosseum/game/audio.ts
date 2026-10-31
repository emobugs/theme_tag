import type { SfxName } from './engine';

// Синтезирани звуци (WebAudio), без аудио файлове и без авторски права.
// В OBS browser source звукът тръгва сам. В обикновен браузър трябва един клик.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private last = new Map<SfxName, number>();
  private noiseBuf: AudioBuffer | null = null;

  constructor(private volume = 0.5, private muted = false) {}

  get ready() {
    return this.ctx?.state === 'running';
  }

  unlock() {
    if (this.muted) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  play(name: SfxName) {
    if (this.muted) return;
    if (!this.ctx) this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // ограничение на честотата, за да не става каша при много удари
    const minGap: Partial<Record<SfxName, number>> = { hit: 0.07, pop: 0.05, grow: 0.06, tick: 0.2 };
    const prev = this.last.get(name) ?? 0;
    if (t - prev < (minGap[name] ?? 0.03)) return;
    this.last.set(name, t);

    switch (name) {
      case 'hit':
        this.noise(t, 0.08, 900, 0.35);
        this.tone(t, 140, 60, 0.09, 'square', 0.15);
        break;
      case 'pop':
        this.tone(t, 500, 1200, 0.08, 'sine', 0.3);
        break;
      case 'grow':
        this.tone(t, 300, 700, 0.15, 'triangle', 0.25);
        break;
      case 'dash':
        this.noise(t, 0.3, 2500, 0.3, 400);
        break;
      case 'shield':
        this.tone(t, 600, 900, 0.35, 'sine', 0.25);
        this.tone(t + 0.05, 900, 1350, 0.35, 'sine', 0.15);
        break;
      case 'bomb':
        this.noise(t, 0.9, 400, 0.8);
        this.tone(t, 120, 30, 0.8, 'sine', 0.7);
        break;
      case 'meteor':
        this.noise(t, 1.4, 1200, 0.5, 200);
        this.tone(t + 0.9, 90, 25, 1.0, 'sawtooth', 0.4);
        break;
      case 'ko':
        this.tone(t, 400, 80, 0.5, 'sawtooth', 0.35);
        this.noise(t, 0.4, 600, 0.4);
        break;
      case 'revive':
        [523, 659, 784].forEach((f, i) => this.tone(t + i * 0.08, f, f, 0.18, 'triangle', 0.25));
        break;
      case 'crown':
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.12, f, f, 0.3, 'square', 0.18));
        break;
      case 'start':
        this.tone(t, 220, 880, 0.4, 'sawtooth', 0.25);
        break;
      case 'tick':
        this.tone(t, 880, 880, 0.08, 'square', 0.2);
        break;
    }
  }

  private tone(t: number, f0: number, f1: number, dur: number, type: OscillatorType, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(t: number, dur: number, freq: number, gain: number, freqEnd?: number) {
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(freq, t);
    if (freqEnd) filt.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur);
  }
}

// Глас (TTS) само за важни моменти. В OBS speechSynthesis често няма гласове;
// тогава тихо се пропуска.
export class Voice {
  private voice: SpeechSynthesisVoice | null = null;
  private lastAt = 0;

  constructor(private enabled = true) {
    if (!enabled || typeof speechSynthesis === 'undefined') return;
    const pick = () => {
      const all = speechSynthesis.getVoices();
      this.voice = all.find((v) => v.lang.toLowerCase().startsWith('bg')) ?? null;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  }

  say(text: string) {
    if (!this.enabled || typeof speechSynthesis === 'undefined' || !this.voice) return;
    const now = Date.now();
    if (now - this.lastAt < 2500 && speechSynthesis.speaking) return;
    this.lastAt = now;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice;
    u.lang = this.voice.lang;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
}
