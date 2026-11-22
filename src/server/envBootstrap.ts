import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const serverDir = typeof import.meta.dirname === 'string' ? import.meta.dirname : path.resolve(process.cwd(), 'src/server');
export const APP_ROOT = path.resolve(serverDir, '../..');

const appEnvPath = path.join(APP_ROOT, '.env');
if (fs.existsSync(appEnvPath)) {
  dotenv.config({ path: appEnvPath });
}

const cwdEnvPath = path.resolve(process.cwd(), '.env');
if (cwdEnvPath !== appEnvPath && fs.existsSync(cwdEnvPath)) {
  dotenv.config({ path: cwdEnvPath });
}
