import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Problem } from './notice.mjs';
import { backupFromFiles, backupPayloadLimit, validateBackup } from './backup.mjs';

export async function openPostgresStore({ connectionString, namespace = 'maple-dev' } = {}) {
  if (!connectionString) throw new Error('請先設定 MAPLE_DATABASE_URL。');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) throw new Error('資料集名稱格式有誤。');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const request = new AsyncLocalStorage();
  pool.on('error', () => console.error('PostgreSQL 閒置連線中斷；下次操作將重新連線。'));

  async function transaction(action) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [namespace]);
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(5507314)');
      await client.query(`CREATE TABLE IF NOT EXISTS maple_saved_files (
        namespace text NOT NULL,
        name text NOT NULL,
        content bytea NOT NULL,
        PRIMARY KEY (namespace, name)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS maple_active_dataset (
        namespace text PRIMARY KEY,
        dataset text NOT NULL
      )`);
      await client.query('ALTER TABLE maple_active_dataset ADD COLUMN IF NOT EXISTS previous_dataset text');
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  const active = async (db = pool) => {
    const { rows } = await db.query('SELECT dataset FROM maple_active_dataset WHERE namespace = $1', [namespace]);
    return rows[0]?.dataset ?? namespace;
  };
  const dataset = async () => request.getStore() ?? active();
  const previousDataset = async () => {
    const { rows } = await pool.query('SELECT previous_dataset FROM maple_active_dataset WHERE namespace = $1', [namespace]);
    return rows[0]?.previous_dataset;
  };
  function filesFrom(backup) {
    const files = validateBackup(backup);
    if (!files.size) throw new Problem('備份沒有可移轉的資料。');
    return files;
  }
  async function insertAll(db, target, files) {
    for (const [name, content] of files) {
      await db.query('INSERT INTO maple_saved_files (namespace, name, content) VALUES ($1, $2, $3)', [target, name, content]);
    }
  }
  // Compare names and bytes in PostgreSQL to avoid fetching another copy of a large backup.
  function sameFiles(db, target, files) {
    return db.query(`SELECT count(*) = $2 AS identical FROM maple_saved_files
      WHERE namespace = $1 HAVING count(*) = $2 AND count(*) FILTER (
        WHERE encode(sha256(content), 'hex') = ($3::jsonb ->> name)
      ) = $2`, [target, files.size, JSON.stringify(Object.fromEntries(
        [...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])
      ))]).then(({ rows }) => Boolean(rows[0]?.identical));
  }
  let vectorSchema;
  function prepareVectors() {
    vectorSchema ??= transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(5507315)');
      await client.query(`CREATE TABLE IF NOT EXISTS maple_notice_vectors (
        dataset text NOT NULL, model text NOT NULL, key text NOT NULL, embedding vector NOT NULL,
        PRIMARY KEY (dataset, model, key)
      )`);
    }).catch(error => {
      vectorSchema = undefined;
      throw error;
    });
    return vectorSchema;
  }
  return {
    async vectorSearch(model, entries, query, embed) {
      await prepareVectors();
      const target = await dataset();
      const keys = entries.map(entry => entry.key);
      const { rows } = await pool.query(`SELECT key FROM maple_notice_vectors
        WHERE dataset = $1 AND model = $2 AND key = ANY($3::text[]) AND vector_dims(embedding) = $4`,
      [target, model, keys, query.length]);
      const existing = new Set(rows.map(row => row.key));
      const missing = entries.filter(entry => !existing.has(entry.key));
      for (let offset = 0; offset < missing.length; offset += 24) {
        const batch = missing.slice(offset, offset + 24);
        const vectors = await embed(batch.map(entry => entry.text));
        await pool.query(`INSERT INTO maple_notice_vectors (dataset, model, key, embedding)
          SELECT $1, $2, item.key, item.value::vector FROM unnest($3::text[], $4::text[]) AS item(key, value)
          ON CONFLICT (dataset, model, key) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [target, model, batch.map(entry => entry.key), vectors.map(vector => JSON.stringify(vector))]);
      }
      const result = await pool.query(`SELECT key FROM maple_notice_vectors
        WHERE dataset = $1 AND model = $2 AND key = ANY($3::text[]) AND vector_dims(embedding) = $4
          AND (embedding <=> $5::vector) <= 0.45
        ORDER BY embedding <=> $5::vector, key LIMIT 12`,
      [target, model, keys, query.length, JSON.stringify(query)]);
      return result.rows.map(row => row.key);
    },
    async run(action) {
      return request.run(await active(), action);
    },
    previousDataset,
    async cacheKey() {
      return dataset();
    },
    async read(name, encoding) {
      const { rows } = await pool.query('SELECT content FROM maple_saved_files WHERE namespace = $1 AND name = $2', [await dataset(), name]);
      if (!rows.length) throw Object.assign(new Error('找不到保存的資料。'), { code: 'ENOENT' });
      return encoding ? rows[0].content.toString(encoding) : rows[0].content;
    },
    async write(name, value) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await transaction(async client => {
        const target = await active(client);
        if (request.getStore() && target !== request.getStore()) throw new Problem('資料剛完成還原，請重新操作。', 409);
        await client.query(`INSERT INTO maple_saved_files (namespace, name, content) VALUES ($1, $2, $3)
          ON CONFLICT (namespace, name) DO UPDATE SET content = EXCLUDED.content
          WHERE maple_saved_files.content IS DISTINCT FROM EXCLUDED.content`, [target, name, data]);
      });
    },
    async importBackup(backup) {
      const files = filesFrom(backup);
      return transaction(async client => {
        const target = await active(client);
        if (await sameFiles(client, target, files)) return files.size;
        const existing = await client.query('SELECT 1 FROM maple_saved_files WHERE namespace = $1 LIMIT 1', [target]);
        if (existing.rowCount) throw new Problem('目標資料集已有不同資料，請使用新的 MAPLE_DATABASE_NAMESPACE 進行試移轉。', 409);
        await insertAll(client, target, files);
        return files.size;
      });
    },
    async restoreBackup(backup) {
      const files = filesFrom(backup);
      return transaction(async client => {
        const current = await active(client);
        if (request.getStore() && current !== request.getStore()) throw new Problem('資料剛完成還原，請重新操作。', 409);
        if (await sameFiles(client, current, files)) return;
        const target = namespace + ':' + randomUUID();
        await insertAll(client, target, files);
        await client.query(`INSERT INTO maple_active_dataset (namespace, dataset, previous_dataset) VALUES ($1, $2, $3)
          ON CONFLICT (namespace) DO UPDATE SET dataset = EXCLUDED.dataset, previous_dataset = EXCLUDED.previous_dataset`,
        [namespace, target, current]);
      });
    },
    async createBackup(now, { previous = false } = {}) {
      const target = previous ? await previousDataset() : await dataset();
      if (!target) throw new Problem('找不到還原前的資料版本。', 404);
      const { rows } = await pool.query(`WITH size AS (
          SELECT COALESCE(sum(4 * ((octet_length(content)::bigint + 2) / 3) + octet_length(name) + 160), 0) AS total
          FROM maple_saved_files WHERE namespace = $1
        )
        SELECT size.total > $2::bigint AS oversized, files.name, files.content
        FROM size LEFT JOIN maple_saved_files files ON files.namespace = $1 AND size.total <= $2::bigint
        ORDER BY files.name`, [target, backupPayloadLimit]);
      if (rows[0].oversized) throw new Problem('備份資料超過目前可還原的大小。', 413);
      return backupFromFiles(rows.filter(row => row.name !== null).map(({ name, content }) => [name, content]), now);
    },
    close: () => pool.end(),
  };
}
