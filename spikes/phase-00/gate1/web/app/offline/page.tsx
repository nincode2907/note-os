import Link from 'next/link';

export default function OfflinePage() {
  return <div className="page-wrap">
    <p className="eyebrow">Saved on this device</p>
    <h1 className="page-title">You’re offline</h1>
    <p className="page-lede">Your local notes remain on this device. Reconnect to the private network when you want Auto Sync to resume.</p>
    <div className="backup-panel">
      <h2 className="section-title">Continue with local notes</h2>
      <p>Open Notes to read and edit notes already stored in this browser or Home Screen app. Your changes are saved locally first.</p>
      <Link className="btn btn-primary" href="/">Open Notes</Link>
    </div>
  </div>;
}
