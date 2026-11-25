import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.resolve(process.env.SCREEN_NOTES_DATA_DIR ?? path.join(root, 'data'));
export const portRange = 20;
const portFlag = process.argv.indexOf('--port');
export const preferredPort = Number(process.env.SCREEN_NOTES_PORT ?? (portFlag < 0 ? 17860 : process.argv[portFlag + 1]));
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65536 - portRange) {
  throw new Error('屏幕笔记端口配置无效');
}

function directoryId(directory) {
  const resolved = fs.existsSync(directory) ? fs.realpathSync.native(directory) : directory;
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
}

export const identity = {
  product: 'screen-notes',
  runtime_version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  install_id: directoryId(root),
  data_id: directoryId(dataDir)
};
