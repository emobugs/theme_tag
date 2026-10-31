import type { Metadata, Viewport } from 'next';
import { Manrope, Unbounded } from 'next/font/google';
import './globals.css';

const display = Unbounded({ subsets: ['latin', 'cyrillic'], weight: ['700', '800', '900'], variable: '--font-display' });
const body = Manrope({ subsets: ['latin', 'cyrillic'], weight: ['500', '600', '700', '800'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'Emoji Колизеум',
  description: 'Faceless TikTok LIVE игра: емоджи отбори, подаръците решават битката.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07051a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
