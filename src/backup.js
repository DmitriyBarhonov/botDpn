/**
 * Резервная копия базы средствами самого better-sqlite3.
 * Запуск: node --env-file=.env src/backup.js
 *
 * Преимущество перед копированием файла: db.backup() учитывает WAL и даёт
 * согласованный снимок на работающем боте. Утилита sqlite3 в системе не нужна.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';

const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 30);
const BACKUP_DIR = process.env.BACKUP_DIR ?? './backups';

const config = loadConfig();
mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const out = join(BACKUP_DIR, `bot-${stamp}.db`);

const db = new Database(config.dbFile, { readonly: true });
await db.backup(out);
db.close();
console.log(`Копия готова: ${out}`);

// Удаляем копии старше KEEP_DAYS.
const cutoff = Date.now() - KEEP_DAYS * 86400_000;
let removed = 0;
for (const file of readdirSync(BACKUP_DIR)) {
  if (!/^bot-.*\.db$/.test(file)) continue;
  const path = join(BACKUP_DIR, file);
  if (statSync(path).mtimeMs < cutoff) {
    unlinkSync(path);
    removed++;
  }
}
if (removed) console.log(`Удалено старых копий: ${removed}`);
