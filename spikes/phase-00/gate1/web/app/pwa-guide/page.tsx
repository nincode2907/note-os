import Link from 'next/link';

export default function PwaGuidePage() {
  return <div className="page-wrap">
    <header className="page-heading">
      <div><p className="eyebrow">Home Screen app</p><h1 className="page-title">Install and move safely</h1>
        <p className="page-lede">The Home Screen app may have a separate local notes store from the Safari tab.</p></div>
      <Link className="btn btn-quiet" href="/sync">Sync Setup</Link>
    </header>
    <section className="backup-panel">
      <h2 className="section-title">Install on iPhone</h2>
      <ol><li>Open <code>https://noteos.tail913fb3.ts.net</code> in Safari.</li><li>Tap Share, choose <strong>Add to Home Screen</strong>, then tap Add.</li><li>Launch noteOS from its Home Screen icon to use the standalone app.</li></ol>
    </section>
    <section className="backup-panel">
      <h2 className="section-title">Safari and Home Screen storage</h2>
      <p>Safari and the installed Home Screen app can keep separate local notes. Installing noteOS does not copy, move, or delete Safari data. If the Home Screen app starts with zero local notes, your Safari notes remain in Safari.</p>
      <ol><li>In Safari, open Sync Setup and check its local note count. Pair the browser and explicitly approve only the notes you want on the private server.</li><li>Install and open the Home Screen app. Check its own local count before doing anything with enrollment.</li><li>Pair the Home Screen app separately. Auto Sync pulls records already approved on the server into that app’s local store.</li><li>For notes that exist only in Safari and are not on the server, approve only the selected notes from Safari. Do not bulk-enroll or clear either app’s storage.</li></ol>
      <p>Each app remains usable offline after it has loaded. Changes wait on that device until the private server is reachable; iOS may suspend background work, so Auto Sync resumes when noteOS is opened or returned to the foreground.</p>
    </section>
    <section className="backup-panel">
      <h2 className="section-title">If a note is not visible</h2>
      <p>Return to the original Safari tab and verify its local count. Then check pairing and approved server records in Sync Setup. A different or empty Home Screen store does not mean the Safari copy was removed.</p>
      <Link className="btn btn-secondary" href="/sync">Open Sync Setup</Link>
    </section>
  </div>;
}
