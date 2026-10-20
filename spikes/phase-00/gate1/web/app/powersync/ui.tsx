'use client';

import { useEffect, useState } from 'react';
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';

const DATASET = 'phase00-gate1-v1';
const schema = new Schema({
  notes: new Table({ title: column.text, body: column.text, privacy: column.text, dataset_id: column.text, revision: column.integer, deleted: column.integer, updated_at: column.text }),
  device_notes: new Table({ title: column.text, body: column.text, privacy: column.text, dataset_id: column.text, revision: column.integer, deleted: column.integer, updated_at: column.text }, { localOnly: true }),
});
let database: PowerSyncDatabase | null = null;

async function getDb() {
  if (database) return database;
  const db = new PowerSyncDatabase({ schema, database: { dbFilename: 'noteos-gate1-powersync.db' } });
  await db.init();
  (window as any).__gate1Db = db;
  database = db;
  await db.connect({
    async fetchCredentials() {
      const response = await fetch('/api/gate1/powersync-credentials');
      if (!response.ok) throw new Error(`credentials ${response.status}`);
      return response.json();
    },
    async uploadData(database) {
      let transaction = await database.getNextCrudTransaction();
      while (transaction) {
        for (const entry of transaction.crud) {
          if (entry.table !== 'notes') continue;
          const note = { id: entry.id, title: entry.opData?.title ?? '', body: entry.opData?.body ?? '', privacy: entry.opData?.privacy, dataset_id: entry.opData?.dataset_id ?? DATASET, deleted: entry.op === 'DELETE' };
          if (note.privacy !== 'PRIVATE_SERVER') continue;
          const result = await fetch('/api/delta/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mutationId: `ps-${entry.transactionId ?? transaction.transactionId ?? entry.clientId}-${entry.id}-${entry.op}`, baseRevision: Number(entry.opData?.revision ?? 0), note }) });
          if (!result.ok) throw new Error(`upload ${result.status}: ${await result.text()}`);
        }
        await transaction.complete();
        transaction = await database.getNextCrudTransaction();
      }
    },
  });
  return db;
}

function canonical(text: string) { return JSON.stringify({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }); }
function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(); }

export default function Harness() {
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState('starting');
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [privacy, setPrivacy] = useState('PRIVATE_SERVER'); const [query, setQuery] = useState('');
  const refresh = async (db?: PowerSyncDatabase) => {
    const conn = db ?? await getDb();
    const synced = await conn.getAll('SELECT id,title,body,privacy,dataset_id,revision,deleted FROM notes WHERE dataset_id = ?', [DATASET]);
    const local = await conn.getAll('SELECT id,title,body,privacy,dataset_id,revision,deleted FROM device_notes WHERE dataset_id = ?', [DATASET]);
    setRows([...synced, ...local]);
  };
  useEffect(() => { let alive = true; (async () => {
    try {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
      const db = await getDb(); if (!alive) return;
      setStatus('connected'); await refresh(db);
      db.registerListener({ onChange: () => { if (alive) void refresh(db); } });
    } catch (error) { setStatus(`error: ${String(error)}`); }
  })(); return () => { alive = false; }; }, []);
  async function create() {
    const db = await getDb(); const id = crypto.randomUUID();
    const table = privacy === 'DEVICE_ONLY' ? 'device_notes' : 'notes';
    await db.execute(`INSERT INTO ${table} (id,title,body,privacy,dataset_id,revision,deleted,updated_at) VALUES (?,?,?,?,?,0,0,?)`, [id, title, canonical(text), privacy, DATASET, new Date().toISOString()]);
    setTitle(''); setText(''); await refresh(db); return id;
  }
  async function editFirst() {
    const row = rows.find(item => !item.deleted); if (!row) return;
    const db = await getDb(); const table = row.privacy === 'DEVICE_ONLY' ? 'device_notes' : 'notes';
    await db.execute(`UPDATE ${table} SET title=?, body=?, updated_at=? WHERE id=?`, [`${row.title} edited`, canonical(`${JSON.parse(row.body).content[0].content[0].text} updated`), new Date().toISOString(), row.id]); await refresh(db);
  }
  async function syncNow() { const db = await getDb(); setStatus('sync requested'); await new Promise(resolve => setTimeout(resolve, 1000)); await refresh(db); setStatus('connected'); }
  const visible = rows.filter(row => !row.deleted && (!query || normalize(`${row.title} ${row.body}`).includes(normalize(query))));
  return <main data-framework="powersync"><h1>PowerSync Web SDK</h1><p data-testid="status">Status: {status}</p><p>Rows: <span data-testid="row-count">{rows.length}</span></p>
    <label>Title <input aria-label="Title" value={title} onChange={e=>setTitle(e.target.value)} /></label>{' '}
    <label>Text <input aria-label="Text" value={text} onChange={e=>setText(e.target.value)} /></label>{' '}
    <label>Privacy <select aria-label="Privacy" value={privacy} onChange={e=>setPrivacy(e.target.value)}><option>PRIVATE_SERVER</option><option>DEVICE_ONLY</option></select></label>{' '}
    <button onClick={()=>void create()}>Create note</button><button onClick={()=>void editFirst()}>Edit first</button><button onClick={()=>void syncNow()}>Sync</button>
    <p><label>Search local <input aria-label="Search" value={query} onChange={e=>setQuery(e.target.value)} /></label> Results: <span data-testid="search-count">{visible.length}</span></p>
    <ul data-testid="notes">{visible.map(row=><li key={row.id} data-note-id={row.id} data-privacy={row.privacy}><strong>{row.title}</strong> — {row.privacy} — <code>{row.body}</code></li>)}</ul>
  </main>;
}
