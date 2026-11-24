// Runs the lockout overlay script from index.html against a tiny DOM stub and
// checks each reason renders its label, colour class and escaping.
import fs from "node:fs";
import vm from "node:vm";

let failed = 0;
const ok = (c, m) => { if (c) console.log("PASS " + m); else { failed++; console.log("FAIL " + m); } };

const html = fs.readFileSync("index.html", "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("eas-maint-lock"));
ok(Boolean(script), "overlay script found");

function el(tag) {
  return {
    tag, id: "", className: "", textContent: "", innerHTML: "", attrs: {}, children: [], parentNode: null, style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    addEventListener() {},
  };
}

async function render(data) {
  const body = el("body");
  const head = el("head");
  const all = () => [...head.children, ...body.children];
  const document = {
    head, body, documentElement: { style: {} },
    createElement: el,
    getElementById: (id) => all().find((n) => n.id === id) || null,
  };
  const ctx = {
    document,
    fetch: async () => ({ ok: true, json: async () => data }),
    setInterval: () => 0,
    Object, String,
  };
  vm.runInNewContext(script, ctx);
  await new Promise((r) => setTimeout(r, 10));
  return document.getElementById("eas-maint-lock");
}

const cases = [
  [{ on: true, reason: "outage" }, "r-outage", "Outage"],
  [{ on: true, reason: "maintenance" }, "r-maintenance", "Maintenance"],
  [{ on: true, reason: "update", source: "deploy" }, "r-update", "Update"],
  [{ on: true }, "r-maintenance", "Maintenance"],
  [{ on: true, reason: "bogus" }, "r-maintenance", "Maintenance"],
  [{ on: true, reason: "other", reason_label: "Carrier fault" }, "r-other", "Carrier fault"],
];
for (const [data, cls, label] of cases) {
  const node = await render(data);
  ok(node && node.className === cls, `${JSON.stringify(data)} -> class ${cls}`);
  ok(node && node.innerHTML.includes("</span> " + label + "</p>"), `${JSON.stringify(data)} -> label ${label}`);
}
const evil = await render({ on: true, reason: "other", reason_label: "<img src=x onerror=alert(1)>", message: "<b>x</b>" });
ok(!evil.innerHTML.includes("<img") && !evil.innerHTML.includes("<b>"), "custom reason and message are escaped");
ok((await render({ on: false })) === null, "no overlay when off");
ok(/#eas-maint-lock\.r-outage main\{border-top-color:#ef4444\}/.test(html) && /#eas-maint-lock\.r-update main\{border-top-color:#3b82f6\}/.test(html), "reason colours in overlay CSS");

if (failed) { console.log(`${failed} overlay test(s) failed`); process.exitCode = 1; } else console.log("overlay tests passed");
