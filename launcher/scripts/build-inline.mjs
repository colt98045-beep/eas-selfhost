// Rebuild worker-inline/ for a connector deploy that cannot upload asset buckets.
// Source of truth stays src/ + public/ + wrangler.jsonc. The output is gitignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const outDir = path.join(root, "worker-inline");

function parseJsonc(src) {
  let out = "", inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) throw new Error("unterminated comment");
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  }[ext] || "application/octet-stream";
}

function walk(dir, base = "") {
  const entries = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const rel = `${base}/${name}`;
    const st = fs.statSync(full);
    if (st.isDirectory()) entries.push(...walk(full, rel));
    else entries.push({ full, rel });
  }
  return entries;
}

function jsString(value) {
  return JSON.stringify(value);
}

const cfg = parseJsonc(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
const files = {};
for (const entry of walk(publicDir)) {
  const type = mimeFor(entry.full);
  const buf = fs.readFileSync(entry.full);
  const text = buf.toString("utf8");
  const canText = !type.startsWith("image/") && !type.startsWith("font/") && type !== "application/octet-stream";
  files[entry.rel] = canText
    ? { type, kind: "text", body: text }
    : { type, kind: "b64", body: buf.toString("base64") };
}

const workerFirst = cfg.assets && cfg.assets.run_worker_first;
const patternLit = workerFirst === true ? "true" : jsString(workerFirst || []);

const shim = `// Generated equivalent of wrangler.jsonc assets + run_worker_first.
// Built because the Cloudflare connector cannot upload static asset buckets.
// Do not commit this directory. Source of truth is src/ + public/.
// Regenerate with: node scripts/build-inline.mjs

import app from "../src/index.js";

const FILES = ${JSON.stringify(files)};

const HTML_HANDLING = ${jsString((cfg.assets && cfg.assets.html_handling) || "auto-trailing-slash")};
const NOT_FOUND_HANDLING = ${jsString((cfg.assets && cfg.assets.not_found_handling) || "none")};
const WORKER_FIRST = ${patternLit};

function exists(pathname) {
  return Object.prototype.hasOwnProperty.call(FILES, pathname) ? pathname : null;
}

function decodePath(pathname) {
  return pathname
    .split("/")
    .map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    })
    .join("/")
    .replace(/\\/+/g, "/");
}

function matchWorkerFirst(pathname) {
  if (WORKER_FIRST === true) return true;
  if (!Array.isArray(WORKER_FIRST)) return false;
  for (const pattern of WORKER_FIRST) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "/api/"
      if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) return true;
    } else if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1); // "/admin"
      if (pathname === prefix || pathname.startsWith(prefix)) return true;
    } else if (pathname === pattern) {
      return true;
    }
  }
  return false;
}

async function getIntent(pathname, skipRedirects = false) {
  if (HTML_HANDLING !== "auto-trailing-slash") return null;
  return htmlHandlingAutoTrailingSlash(pathname, skipRedirects);
}

async function safeRedirect(file, destination, skip) {
  if (skip) return null;
  if (!exists(destination)) {
    const intent = await getIntent(destination, true);
    if (intent && intent.asset && intent.asset.path === exists(file)) {
      return { asset: null, redirect: destination };
    }
  }
  return null;
}

async function htmlHandlingAutoTrailingSlash(pathname, skipRedirects) {
  let redirectResult = null;
  const exact = exists(pathname);
  if (pathname.endsWith("/index")) {
    if (exact) return { asset: { path: exact, status: 200 }, redirect: null };
    if ((redirectResult = await safeRedirect(\`\${pathname}.html\`, pathname.slice(0, -5), skipRedirects))) return redirectResult;
    if ((redirectResult = await safeRedirect(\`\${pathname.slice(0, -6)}.html\`, pathname.slice(0, -6), skipRedirects))) return redirectResult;
  } else if (pathname.endsWith("/index.html")) {
    if ((redirectResult = await safeRedirect(pathname, pathname.slice(0, -10), skipRedirects))) return redirectResult;
    if ((redirectResult = await safeRedirect(\`\${pathname.slice(0, -11)}.html\`, pathname.slice(0, -11), skipRedirects))) return redirectResult;
  } else if (pathname.endsWith("/")) {
    const idx = exists(\`\${pathname}index.html\`);
    if (idx) return { asset: { path: idx, status: 200 }, redirect: null };
    if ((redirectResult = await safeRedirect(\`\${pathname.slice(0, -1)}.html\`, pathname.slice(0, -1), skipRedirects))) return redirectResult;
  } else if (pathname.endsWith(".html")) {
    if ((redirectResult = await safeRedirect(pathname, pathname.slice(0, -5), skipRedirects))) return redirectResult;
    if ((redirectResult = await safeRedirect(\`\${pathname.slice(0, -5)}/index.html\`, \`\${pathname.slice(0, -5)}/\`, skipRedirects))) return redirectResult;
  }
  if (exact) return { asset: { path: exact, status: 200 }, redirect: null };
  const html = exists(\`\${pathname}.html\`);
  if (html) return { asset: { path: html, status: 200 }, redirect: null };
  if ((redirectResult = await safeRedirect(\`\${pathname}/index.html\`, \`\${pathname}/\`, skipRedirects))) return redirectResult;
  return notFound(pathname);
}

function notFound(_pathname) {
  if (NOT_FOUND_HANDLING === "single-page-application") {
    const e = exists("/index.html");
    return e ? { asset: { path: e, status: 200 }, redirect: null } : null;
  }
  if (NOT_FOUND_HANDLING === "404-page") return null;
  return null;
}

function fileResponse(pathName, method, status = 200) {
  const file = FILES[pathName];
  const headers = {
    "content-type": file.type,
  };
  if (method === "HEAD") return new Response(null, { status, headers });
  if (file.kind === "b64") {
    const bin = Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0));
    return new Response(bin, { status, headers });
  }
  return new Response(file.body, { status, headers });
}

function intentResponse(request, intent) {
  const url = new URL(request.url);
  if (intent.redirect !== null) {
    const location = intent.redirect + url.search;
    return new Response(null, {
      status: 307,
      headers: { Location: location },
    });
  }
  if (intent.asset) {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "cache-control": "no-store" },
      });
    }
    return fileResponse(intent.asset.path, method, intent.asset.status);
  }
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const ASSETS = {
  async fetch(request) {
    const pathname = decodePath(new URL(request.url).pathname);
    const intent = await getIntent(pathname);
    if (!intent) {
      return new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return intentResponse(request, intent);
  },
};

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    const bound = Object.assign({}, env, { ASSETS });
    if (matchWorkerFirst(pathname)) {
      return app.fetch(request, bound, ctx);
    }
    const intent = await getIntent(decodePath(pathname));
    if (intent) return intentResponse(request, intent);
    return app.fetch(request, bound, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (typeof app.scheduled !== "function") return;
    const bound = Object.assign({}, env, { ASSETS });
    return app.scheduled(controller, bound, ctx);
  },
};
`;

// Simplify matchWorkerFirst - the generated version above has a slightly messy glob. Write a clean one instead.
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "shim-entry.js"), shim);
console.log(`Wrote ${path.join(outDir, "shim-entry.js")} (${Object.keys(files).length} assets)`);
