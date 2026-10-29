import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('study files use opaque keys and round-trip from the configured storage directory', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'campusloop-study-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  process.env.FILE_STORAGE_DIR=directory;
  const storage=await import(`../src/fileStorage.js?test=${Date.now()}`);
  const content=Buffer.from('%PDF-1.7\nCampusLoop test document');
  const key=await storage.storeStudyFile(content,'pdf');
  assert.match(key,/^[0-9a-f-]{36}$/i);
  assert.deepEqual(await readFile(path.join(directory,`study-${key}.pdf`)),content);
  assert.throws(()=>storage.openStudyFile('../escape','pdf'),/Invalid stored file key/);
  await storage.deleteStudyFile(key,'pdf');
});
