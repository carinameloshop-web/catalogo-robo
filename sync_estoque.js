// Robô de atualização de estoque: Terasoft -> Supabase (catálogo)
// Atualiza SOMENTE estoque e preço de cada peça já cadastrada.
// NÃO mexe em foto, descrição, tipo, marca. Senhas vêm de secrets (env), nunca no código.
const https = require("https");

const SB_URL = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/produtos";
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY; // chave de ESCRITA (secret)
const TERA_AUTH = "Basic " + Buffer.from(process.env.TERASOFT_AUTH || "").toString("base64"); // "user:senha" (secret)
const pad = (n) => String(n).padStart(6, "0");
const CONC = 15;

if (!SB_SERVICE) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }
if (!process.env.TERASOFT_AUTH) { console.error("Faltou TERASOFT_AUTH"); process.exit(1); }

async function lerCodigos() {
  let all = [], off = 0;
  while (true) {
    const r = await fetch(SB_URL + "?select=codigo&limit=1000&offset=" + off, {
      headers: { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE },
    });
    const d = await r.json();
    all = all.concat(d.map((x) => x.codigo));
    if (d.length < 1000) break;
    off += 1000;
  }
  return all;
}

function terasoft(code) {
  return new Promise((res) => {
    const req = https.request({
      hostname: "apiserver.ip.inf.br", port: 12067,
      path: "/consulta?EP=produto&SKU=" + pad(code),
      headers: { Authorization: TERA_AUTH }, rejectUnauthorized: false, timeout: 15000,
    }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => {
        try { const j = JSON.parse(d); const p = Array.isArray(j) ? j[0] : j;
          res(p ? { estoque: p.ESTOQUE, preco: p.VENDA } : null);
        } catch (e) { res(null); }
      });
    });
    req.on("error", () => res(null));
    req.on("timeout", () => { req.destroy(); res(null); });
    req.end();
  });
}

async function atualizar(codigo, estoque, preco) {
  const body = {};
  if (estoque != null) body.estoque = estoque;
  if (preco != null) body.preco = preco;
  if (!Object.keys(body).length) return false;
  const r = await fetch(SB_URL + "?codigo=eq." + encodeURIComponent(codigo), {
    method: "PATCH",
    headers: { apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE,
      "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

(async () => {
  const t0 = Date.now();
  const codigos = await lerCodigos();
  console.log("Peças a atualizar:", codigos.length);
  let i = 0, ok = 0, semTera = 0;
  async function worker() {
    while (i < codigos.length) {
      const cod = codigos[i++];
      const t = await terasoft(cod);
      if (!t) { semTera++; continue; }
      if (await atualizar(cod, t.estoque, t.preco)) ok++;
      if ((ok + semTera) % 500 === 0) console.log("progresso:", ok + semTera, "/", codigos.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log("FIM. Atualizadas:", ok, "| sem resposta Terasoft:", semTera,
    "| tempo:", Math.round((Date.now() - t0) / 1000) + "s");
})();
