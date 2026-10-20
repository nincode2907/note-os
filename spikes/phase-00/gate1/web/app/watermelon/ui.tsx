'use client';

import { useEffect, useState } from 'react';
import { Database, Model, appSchema, tableSchema } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { synchronize } from '@nozbe/watermelondb/sync';

const DATASET = 'phase00-gate1-v1';
class Note extends Model {
  static table = 'notes';
  @field('title') title!: string;
  @field('body') body!: string;
  @field('privacy') privacy!: string;
  @field('dataset_id') datasetId!: string;
  @field('revision') revision!: number;
  @field('deleted') deleted!: boolean;
}
const schema = appSchema({ version: 1, tables: [tableSchema({ name: 'notes', columns: [
  { name: 'title', type: 'string' }, { name: 'body', type: 'string' }, { name: 'privacy', type: 'string' },
  { name: 'dataset_id', type: 'string', isIndexed: true }, { name: 'revision', type: 'number' }, { name: 'deleted', type: 'boolean' },
] })] });
let database: Database | null = null;
async function getDb() {
  if (database) return database;
  const adapter = new LokiJSAdapter({ schema, dbName: 'noteos-gate1-watermelon', useWebWorker: false });
  database = new Database({ adapter, modelClasses: [Note] });
  return database;
}
function canonical(text: string) { return JSON.stringify({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }); }
function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(); }
async function syncDatabase(db: Database) {
  await synchronize({
    database: db,
    pullChanges: async ({ lastPulledAt }) => {
      const response = await fetch(`/api/sync?dataset_id=${DATASET}&last_pulled_at=${lastPulledAt ?? 0}`);
      if (!response.ok) throw new Error(`pull ${response.status}`);
      return response.json();
    },
    pushChanges: async ({ changes, lastPulledAt }) => {
      const notes: any = (changes as any).notes ?? { created: [], updated: [], deleted: [] };
      for (const group of ['created', 'updated']) notes[group] = notes[group].filter((row: any) => row.privacy !== 'DEVICE_ONLY');
      const response = await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: { notes }, lastPulledAt: lastPulledAt ?? 0 }) });
      if (!response.ok) throw new Error(`push ${response.status}: ${await response.text()}`);
    },
  });
}

export default function Harness() {
  const [rows, setRows] = useState<any[]>([]); const [status, setStatus] = useState('starting');
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [privacy, setPrivacy] = useState('PRIVATE_SERVER'); const [query, setQuery] = useState('');
  const refresh = async (db?: Database) => {
    const conn = db ?? await getDb();
    const result = await conn.get<Note>('notes').query().fetch();
    setRows(result.filter(row => row.datasetId === DATASET).map(row => ({ id: row.id, title: row.title, body: row.body, privacy: row.privacy, dataset_id: row.datasetId, revision: row.revision, deleted: row.deleted })));
  };
  useEffect(() => { let alive = true; (async () => {
    try {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
      const db = await getDb(); await refresh(db);
      if (!alive) return;
      try { await syncDatabase(db); if (alive) setStatus('connected'); }
      catch (error) { if (alive) setStatus(`offline or sync error: ${String(error)}`); }
      if (alive) await refresh(db);
    } catch (error) { setStatus(`error: ${String(error)}`); }
  })(); return () => { alive = false; }; }, []);
  async function create() {
    const db = await getDb(); const id = crypto.randomUUID();
    await db.write(async () => db.get<Note>('notes').create(note => { note._raw.id = id; note.title = title; note.body = canonical(text); note.privacy = privacy; note.datasetId = DATASET; note.revision = 0; note.deleted = false; }));
    setTitle(''); setText(''); await refresh(db); return id;
  }
  async function editFirst() {
    const row = rows.find(item => !item.deleted); if (!row) return; const db = await getDb();
    const note = await db.get<Note>('notes').find(row.id);
    await db.write(async () => note.update(record => { record.title = `${record.title} edited`; const parsed = JSON.parse(record.body); parsed.content[0].content[0].text += ' updated'; record.body = JSON.stringify(parsed); })); await refresh(db);
  }
  async function syncNow() { const db = await getDb(); setStatus('syncing'); await syncDatabase(db); await refresh(db); setStatus('connected'); }
  const visible = rows.filter(row => !row.deleted && (!query || normalize(`${row.title} ${row.body}`).includes(normalize(query))));
  return <main data-framework="watermelon"><h1>WatermelonDB Web LokiJS + IndexedDB</h1><p data-testid="status">Status: {status}</p><p>Rows: <span data-testid="row-count">{rows.length}</span></p>
    <label>Title <input aria-label="Title" value={title} onChange={e=>setTitle(e.target.value)} /></label>{' '}
    <label>Text <input aria-label="Text" value={text} onChange={e=>setText(e.target.value)} /></label>{' '}
    <label>Privacy <select aria-label="Privacy" value={privacy} onChange={e=>setPrivacy(e.target.value)}><option>PRIVATE_SERVER</option><option>DEVICE_ONLY</option></select></label>{' '}
    <button onClick={()=>void create()}>Create note</button><button onClick={()=>void editFirst()}>Edit first</button><button onClick={()=>void syncNow()}>Sync</button>
    <p><label>Search local <input aria-label="Search" value={query} onChange={e=>setQuery(e.target.value)} /></label> Results: <span data-testid="search-count">{visible.length}</span></p>
    <ul data-testid="notes">{visible.map(row=><li key={row.id} data-note-id={row.id} data-privacy={row.privacy}><strong>{row.title}</strong> — {row.privacy} — <code>{row.body}</code></li>)}</ul>
  </main>;
}
