import { createReadStream } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const storageRoot = path.resolve(process.env.FILE_STORAGE_DIR || path.join(process.cwd(), 'storage'));
const filePath = key => {
  if (!/^[0-9a-f-]{36}$/i.test(String(key))) throw new Error('Invalid stored file key');
  return path.join(storageRoot, `${key}.pdf`);
};
const resourcePath = (key, extension) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(key)) || !['pdf','docx','pptx','zip'].includes(extension)) throw new Error('Invalid stored file key');
  return path.join(storageRoot, `study-${key}.${extension}`);
};
export async function storePdf(buffer) {
  const key=randomUUID(); await mkdir(storageRoot,{recursive:true});
  await writeFile(filePath(key),buffer,{flag:'wx'}); return key;
}
export function openPdf(key) { return createReadStream(filePath(key)); }
export async function deletePdf(key) { try { await unlink(filePath(key)); } catch (error) { if(error.code!=='ENOENT')throw error; } }
export async function storeStudyFile(buffer, extension) {
  const key=randomUUID(); await mkdir(storageRoot,{recursive:true});
  await writeFile(resourcePath(key,extension),buffer,{flag:'wx'}); return key;
}
export function openStudyFile(key, extension) { return createReadStream(resourcePath(key,extension)); }
export async function deleteStudyFile(key, extension) { try { await unlink(resourcePath(key,extension)); } catch (error) { if(error.code!=='ENOENT')throw error; } }
