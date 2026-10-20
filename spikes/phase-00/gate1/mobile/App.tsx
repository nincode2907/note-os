import React, { useEffect, useState } from 'react';
import { Button, SafeAreaView, Text, View } from 'react-native';
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/react-native';
import { Database, Model, appSchema, tableSchema } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { field } from '@nozbe/watermelondb/decorators';

const localOnly = new Schema({ notes: new Table({ title: column.text, body: column.text, privacy: column.text, dataset_id: column.text }, { localOnly: true }) });
const wmSchema = appSchema({ version: 1, tables: [tableSchema({ name: 'notes', columns: [
  { name: 'title', type: 'string' }, { name: 'body', type: 'string' }, { name: 'privacy', type: 'string' }, { name: 'dataset_id', type: 'string' },
] })] });
class Note extends Model { static table = 'notes'; @field('title') title!: string; @field('body') body!: string; @field('privacy') privacy!: string; @field('dataset_id') datasetId!: string; }

export default function App() {
  const [candidate, setCandidate] = useState<'powersync' | 'watermelon'>('powersync');
  const [instance, setInstance] = useState<PowerSyncDatabase | Database | null>(null);
  const [row, setRow] = useState<any>(null); const [status, setStatus] = useState('starting');
  async function open() {
    if (candidate === 'powersync') {
      const db = new PowerSyncDatabase({ schema: localOnly, database: { dbFilename: 'noteos-gate1-powersync.db' } });
      await db.init(); setInstance(db); setStatus('PowerSync native SQLite open');
      const rows = await db.getAll('SELECT * FROM notes'); setRow(rows[0] ?? null); return;
    }
    const adapter = new SQLiteAdapter({ schema: wmSchema, dbName: 'noteos-gate1-watermelon', jsi: false });
    const db = new Database({ adapter, modelClasses: [Note] }); setInstance(db); setStatus('Watermelon native SQLite open');
    const rows = await db.get<Note>('notes').query().fetch(); setRow(rows[0]?._raw ?? null);
  }
  useEffect(() => { void open().catch(error => setStatus(`BLOCKED: ${String(error)}`)); }, [candidate]);
  async function create() {
    if (!instance) return;
    const id = `gate1-${Date.now()}`; const title = `Native persistence ${candidate}`;
    const body = JSON.stringify({ schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Offline native smoke note.' }] }] });
    if (candidate === 'powersync') {
      const db = instance as PowerSyncDatabase;
      await db.execute('INSERT INTO notes (id,title,body,privacy,dataset_id) VALUES (?,?,?,?,?)', [id, title, body, 'DEVICE_ONLY', 'phase00-gate1-v1']);
      setRow((await db.getAll('SELECT * FROM notes WHERE id=?', [id]))[0]);
    } else {
      const db = instance as Database;
      await db.write(async () => db.get<Note>('notes').create(note => { note._raw.id = id; note.title = title; note.body = body; note.privacy = 'DEVICE_ONLY'; note.datasetId = 'phase00-gate1-v1'; }));
      setRow((await db.get<Note>('notes').find(id))._raw);
    }
    setStatus('created in candidate native adapter; restart the app to verify persistence');
  }
  return <SafeAreaView style={{ padding: 24, gap: 12 }}><Text style={{ fontSize: 22 }}>noteOS Gate 1 native adapter smoke test</Text>
    <View style={{ flexDirection: 'row', gap: 8 }}><Button title="PowerSync" onPress={() => { setCandidate('powersync'); setInstance(null); }} /><Button title="WatermelonDB" onPress={() => { setCandidate('watermelon'); setInstance(null); }} /></View>
    <Text>{status}</Text><Button title="Create DEVICE_ONLY note" onPress={() => void create()} /><Text selectable>{row ? JSON.stringify(row) : 'No local note loaded'}</Text>
  </SafeAreaView>;
}
