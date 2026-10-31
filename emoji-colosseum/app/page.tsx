import Link from 'next/link';

export default function Home() {
  return (
    <main className="page">
      <h1>Emoji Колизеум</h1>
      <p>Faceless TikTok LIVE игра. Зрителите избират емоджи отбор в чата, подаръците решават битката.</p>

      <div className="card">
        <h2>Страници</h2>
        <div className="links">
          <Link href="/overlay">
            Overlay
            <span>Слага се като Browser Source (1080x1920) в TikTok LIVE Studio или OBS.</span>
          </Link>
          <Link href="/overlay?offline=1">
            Офлайн демо
            <span>Симулирани зрители направо в браузъра, без bridge и без TikTok.</span>
          </Link>
          <Link href="/control">
            Контролен панел
            <span>Тестови подаръци, лайкове и включване на симулатора. Работи от телефон.</span>
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>Параметри на overlay-а</h2>
        <p>
          <code>?offline=1</code> демо без bridge · <code>?ws=ws://IP:8787</code> друг bridge ·{' '}
          <code>?mute=1</code> без звук · <code>?vol=0.3</code> сила · <code>?tts=0</code> без глас ·{' '}
          <code>?debug=1</code> статус на връзката
        </p>
      </div>
    </main>
  );
}
