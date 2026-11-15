import pg from 'pg';
import { Problem } from './notice.mjs';
import { backupFromFiles, backupPayloadLimit, validateBackup } from './backup.mjs';

export async function openPostgresStore({ connectionString, namespace = 'maple-dev' } = {}) {
  if (!connectionString) throw new Error('請先設定 MAPLE_DATABASE_URL。');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) throw new Error('資料集名稱格式有誤。');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('PostgreSQL 閒置連線中斷；下次操作將重新連線。'));
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS maple_saved_files (
      namespace text NOT NULL,
      name text NOT NULL,
      content bytea NOT NULL,
      PRIMARY KEY (namespace, name)
    )`);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async read(name, encoding) {
      const { rows } = await pool.query('SELECT content FROM maple_saved_files WHERE namespace = $1 AND name = $2', [namespace, name]);
      if (!rows.length) throw Object.assign(new Error('找不到保存的資料。'), { code: 'ENOENT' });
      return encoding ? rows[0].content.toString(encoding) : rows[0].content;
    },
    async write(name, value) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await pool.query(`INSERT INTO maple_saved_files (namespace, name, content)
        SELECT $1, $2, $3 FROM pg_advisory_xact_lock(hashtext($1))
        ON CONFLICT (namespace, name) DO UPDATE SET content = EXCLUDED.content`, [namespace, name, data]);
    },
    async importBackup(backup) {
      const files = validateBackup(backup);
      if (!files.size) throw new Problem('備份沒有可移轉的資料。');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [namespace]);
        const existing = await client.query('SELECT 1 FROM maple_saved_files WHERE namespace = $1 LIMIT 1', [namespace]);
        if (existing.rowCount) throw new Problem('目標資料集已有資料，請使用新的 MAPLE_DATABASE_NAMESPACE 進行試移轉。', 409);
        for (const [name, content] of files) {
          await client.query('INSERT INTO maple_saved_files (namespace, name, content) VALUES ($1, $2, $3)', [namespace, name, content]);
        }
        await client.query('COMMIT');
        return files.size;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async createBackup(now) {
      const { rows } = await pool.query(`WITH size AS (
          SELECT COALESCE(sum(4 * ((octet_length(content)::bigint + 2) / 3) + octet_length(name) + 160), 0) AS total
          FROM maple_saved_files WHERE namespace = $1
        )
        SELECT size.total > $2::bigint AS oversized, files.name, files.content
        FROM size LEFT JOIN maple_saved_files files ON files.namespace = $1 AND size.total <= $2::bigint
        ORDER BY files.name`, [namespace, backupPayloadLimit]);
      if (rows[0].oversized) throw new Problem('備份資料超過目前可還原的大小。', 413);
      return backupFromFiles(rows.filter(row => row.name !== null).map(({ name, content }) => [name, content]), now);
    },
    close: () => pool.end(),
  };
}
