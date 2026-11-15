import { readFile } from 'node:fs/promises';
import { openPostgresStore } from './postgres-store.mjs';
import { Problem } from './notice.mjs';

const backupPath = process.argv[2];
let store;
try {
  if (!backupPath) throw new Problem('請在指令後提供網站下載的 JSON 備份檔路徑。');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  store = await openPostgresStore({
    connectionString: process.env.MAPLE_DATABASE_URL,
    namespace: process.env.MAPLE_DATABASE_NAMESPACE,
  });
  const count = await store.importBackup(backup);
  console.log('試移轉完成，共保存 ' + count + ' 筆備份檔案。');
} catch (error) {
  console.error(error instanceof Problem ? error.message : '試移轉失敗，請核對備份檔、資料庫連線與本機設定。');
  process.exitCode = 1;
} finally {
  await store?.close();
}
