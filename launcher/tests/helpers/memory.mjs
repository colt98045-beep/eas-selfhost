// In-memory KV and an admin_audit-capturing D1 stub for tests.
export function memoryKv(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

export function auditDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { if (/admin_audit/.test(sql)) rows.push({ actor: args[1], action: args[2], email: args[3] }); return {}; } }) };
    },
  };
}
