// Example effect: create ONE new text note inside a sandbox folder, then read it back and compare.
// The agent never chooses the path; the file name is generated here and existing files are never overwritten.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function sandboxNoteEffect(directory) {
  const root = resolve(directory);
  return async (preview) => {
    if (preview.action !== 'note.create') {
      const error = new Error('UNSUPPORTED_ACTION');
      error.code = 'UNSUPPORTED_ACTION';
      throw error;
    }
    const text = String(preview.payload?.text ?? '');
    await mkdir(root, { recursive: true });
    const name = `note-${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
    await writeFile(join(root, name), text, { flag: 'wx' });
    const back = await readFile(join(root, name), 'utf8');
    return {
      verified: back === text,
      detail: { file: name, bytes: Buffer.byteLength(back), sha256: createHash('sha256').update(back).digest('hex') }
    };
  };
}
