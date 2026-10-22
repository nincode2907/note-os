// Mounted only into the isolated synthetic verification container, never copied to runtime.
import { createHash } from 'node:crypto';
import { serverNotes } from './sync-foundation-fixtures.mjs';
if(process.env.NOTEOS_SYNC_TEST_ONLY!=='1') throw new Error('Synthetic test container only');
const {openStore,serverMeta,transaction,appendChange}=await import('/app/sync-server/storage.mjs');
const {issuePairingCode}=await import('/app/sync-server/auth.mjs');
const {canonicalJson}=await import('/app/app/lib/sync-protocol.mjs');
const action=process.argv[2];
const db=openStore(process.env.NOTEOS_SYNC_STORAGE,{initialize:action==='init'});
try {
 if(action==='init') console.log(JSON.stringify(serverMeta(db)));
 if(action==='pair') process.stdout.write(issuePairingCode(db)); // Captured privately by the test runner; never logged.
 if(action==='seed') {
  if(db.prepare('SELECT count(*) n FROM sync_entities').get().n) throw new Error('Refusing to replace existing fixture records');
  transaction(db,()=>{for(const note of serverNotes){
   const {id,revision,createdAt,updatedAt,...content}=note;
   const hash=createHash('sha256').update(canonicalJson(content)).digest('hex'),c=appendChange(db,'note',id,1);
   db.prepare('INSERT INTO sync_entities VALUES(?,?,?,?,?,?,?,?)').run('note',id,1,canonicalJson(note),hash,note.lifecycle,id==='audio'?1:0,c);
  }});console.log('Seeded 4 synthetic server notes.');
 }
 if(action==='state') {
  const state=['sync_entities','sync_tombstones','sync_operations','sync_changelog'].map(t=>db.prepare(`SELECT * FROM ${t}`).all());
  console.log(JSON.stringify({...serverMeta(db),noteCount:state[0].length,stateHash:createHash('sha256').update(JSON.stringify(state)).digest('hex')}));
 }
} finally {db.close();}
