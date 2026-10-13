import { databaseFromEnv } from '../server/database.mjs';
import { Codespaces } from '../server/codespaces.mjs';
let db;
try {
  db = await databaseFromEnv();
  if (!db) throw new Error('Configure the scheduler Actions secrets first.');
  console.log(JSON.stringify(await new Codespaces(db).tick()));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
