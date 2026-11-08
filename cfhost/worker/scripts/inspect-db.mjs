import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
  console.log(name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n);
}
console.log(db.prepare('SELECT username, name FROM agents').all());
console.log('integrity:', db.prepare('PRAGMA integrity_check').get());
