import { website } from './site.mjs';
import { openPostgresStore } from './postgres-store.mjs';
import { createGeminiCredentials } from './gemini-credentials.mjs';

const port = Number(process.env.PORT ?? 3181);
const connectionString = process.env.MAPLE_DATABASE_URL;
try {
  const store = connectionString ? await openPostgresStore({ connectionString, namespace: process.env.MAPLE_DATABASE_NAMESPACE }) : undefined;
  const credentialStore = createGeminiCredentials({ dir: 'data', envFile: '.env' });
  try { await credentialStore.migrate(); }
  catch { console.error('無法完成舊 Gemini 金鑰的本機加密移轉。請從公告管理檢查金鑰設定。'); }
  delete process.env.GEMINI_API_KEY;
  const server = website({ store, credentialStore, enableNoticeAnalysis: true, embeddingModel: process.env.MAPLE_EMBEDDING_MODEL || undefined, enableSchedule: !store || process.env.MAPLE_ENABLE_SCHEDULE === '1' });
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
