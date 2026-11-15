import { website } from './site.mjs';
import { openPostgresStore } from './postgres-store.mjs';

const port = Number(process.env.PORT ?? 3181);
const connectionString = process.env.MAPLE_DATABASE_URL;
try {
  const store = connectionString ? await openPostgresStore({ connectionString, namespace: process.env.MAPLE_DATABASE_NAMESPACE }) : undefined;
  const server = website({ store, enableSchedule: !store || process.env.MAPLE_ENABLE_SCHEDULE === '1' });
  server.once('error', async () => {
    console.error('網站無法啟動，請確認指定的連接埠可用。');
    await store?.close();
    process.exitCode = 1;
  });
  server.once('close', () => { void store?.close(); });
  server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
} catch {
  console.error('PostgreSQL 無法啟動，請核對本機服務及資料庫連線設定。');
  process.exitCode = 1;
}
