// Minimal D1-compatible wrapper over node:sqlite for tests. Runs real SQL so
// upserts, GROUP BY and the migration files are exercised for real.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function sqliteD1({ files = ["schema/access-log.sql", "schema/migrations/0003_uptime.sql"] } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(fs.readFileSync(path.join(root, file), "utf8"));
  const statements = [];
  function stmt(sql, args = []) {
    return {
      sql,
      args,
      bind(...next) {
        return stmt(sql, next);
      },
      async run() {
        statements.push(sql);
        const info = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
      async all() {
        statements.push(sql);
        return { success: true, results: db.prepare(sql).all(...args) };
      },
      async first(column) {
        statements.push(sql);
        const row = db.prepare(sql).get(...args);
        if (!row) return null;
        return column ? row[column] : row;
      },
    };
  }
  return {
    db,
    statements,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(list) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of list) {
          if (/^\s*select/i.test(s.sql)) out.push(await s.all());
          else out.push(await s.run());
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
  };
}

export function memoryKv(initial = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(initial)) map.set(k, typeof v === "string" ? v : JSON.stringify(v));
  let writes = 0;
  return {
    map,
    get writes() {
      return writes;
    },
    async get(key, type) {
      const value = map.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      writes++;
      map.set(key, value);
    },
    async delete(key) {
      writes++;
      map.delete(key);
    },
  };
}
