// Robô de estoque: Terasoft -> Supabase (catálogo Carina Melo)
//
// MUDANÇA DE 25/08/2026: a Terasoft liberou o endpoint `produto_periodo`, que devolve
// tudo que mudou num intervalo de datas. Antes a gente consultava 1 SKU por vez e
// precisava de ~7.000 chamadas por rodada, o que estourava o limite de 12 acessos/hora
// e deixava o catálogo congelado sem ninguém perceber.
//
// Agora:
//   incremental (padrão) -> 1 chamada por rodada, janela de 60 min, roda de 15 em 15
//   completo (MODO=full) -> 1 chamada, traz a base inteira (~10.000 produtos, ~36s)
//
// NÃO mexe em foto. Foto é do outro robô (fotos.js).

const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/produtos";
const SVC = process.env.SUPABASE_SERVICE_KEY;
const TERA = process.env.TERASOFT_AUTH;              // "usuario:senha"
const MODO = (process.env.MODO || "incremental").toLowerCase();
const JANELA_MIN = parseInt(process.env.JANELA_MIN || "60");

if (!SVC) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }
if (!TERA) { console.error("Faltou TERASOFT_AUTH"); process.exit(1); }

const AUTH = "Basic " + Buffer.from(TERA).toString("base64");

// A Terasoft espera dd/MM/yyyy HH:mm:ss no horário de Brasília.
function fmt(d) {
  const br = new Date(d.getTime() - 3 * 3600 * 1000); // UTC -> Brasília
  const p = (n) => String(n).padStart(2, "0");
  return `${p(br.getUTCDate())}/${p(br.getUTCMonth() + 1)}/${br.getUTCFullYear()} ` +
         `${p(br.getUTCHours())}:${p(br.getUTCMinutes())}:${p(br.getUTCSeconds())}`;
}

async function terasoft(ini, fim) {
  const u = "https://apiserver.ip.inf.br:12067/consulta?ep=produto_periodo" +
            "&data_inicial=" + encodeURIComponent(ini) +
            "&data_final=" + encodeURIComponent(fim);
  const r = await fetch(u, { headers: { Authorization: AUTH } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); }
  catch (e) { throw new Error("Terasoft devolveu algo que não é JSON: " + txt.slice(0, 200)); }

  // O bloqueio por limite vem como objeto com sucesso:false. Antes isso passava
  // despercebido e o robô terminava "com sucesso" sem atualizar nada. Agora falha alto.
  if (!Array.isArray(j)) {
    const msg = (j && j.mensagem) ? String(j.mensagem).replace(/\n/g, " ") : JSON.stringify(j).slice(0, 200);
    throw new Error("Terasoft recusou a consulta: " + msg);
  }
  return j;
}

// Produtos novos chegam sem tipo/material. Regras dadas pela Carina.
function derivaMaterial(desc) {
  const u = (desc || "").toUpperCase();
  if (u.startsWith("OURO BRANCO")) return "Ouro Branco";
  if (u.startsWith("PALADIUM") || u.startsWith("PALADIO")) return "Paladio";
  return "Ouro";
}
function derivaTipo(desc) {
  const u = (desc || "").toUpperCase();
  if (/\bTRIO\b/.test(u) || /BRINCO|ARGOLA/.test(u)) return "Brinco";
  if (/ANEL|ALIAN[CÇ]A/.test(u)) return "Anel";
  if (/TORNOZELEIRA/.test(u)) return "Tornozeleira";
  if (/PULSEIRA|BRACELETE|\b14CM\b|\b16CM\b|\b18CM\b/.test(u)) return "Pulseira";
  if (/COLAR|GARGANTILHA|CORRENTE|\b40CM\b|\b45CM\b|\b50CM\b|\b60CM\b|\b70CM\b/.test(u)) return "Colar";
  if (/PINGENTE|BERLOQUE|PINGENTES/.test(u)) return "Pingente";
  return "Outros";
}

async function lerCodigosExistentes() {
  const set = new Set();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(SB + "?select=codigo&limit=1000&offset=" + off, {
      headers: { apikey: SVC, Authorization: "Bearer " + SVC },
    });
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    d.forEach((x) => set.add(String(x.codigo)));
    if (d.length < 1000) break;
  }
  return set;
}

async function gravar(linhas) {
  // merge-duplicates atualiza só as colunas enviadas. Como "foto" não vai no corpo,
  // a foto existente nunca é apagada.
  let ok = 0;
  for (let i = 0; i < linhas.length; i += 500) {
    const lote = linhas.slice(i, i + 500);
    const r = await fetch(SB + "?on_conflict=codigo", {
      method: "POST",
      headers: {
        apikey: SVC, Authorization: "Bearer " + SVC,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(lote),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("Supabase recusou o lote " + (i / 500 + 1) + ": " + t.slice(0, 200));
    }
    ok += lote.length;
    process.stdout.write(`   gravados ${ok}/${linhas.length}\r`);
  }
  return ok;
}

(async () => {
  const t0 = Date.now();
  const agora = new Date();
  let ini, fim = fmt(agora);

  if (MODO === "full") {
    ini = "01/01/2020 00:00:00";
    console.log("MODO COMPLETO: puxando a base inteira desde 2020");
  } else {
    ini = fmt(new Date(agora.getTime() - JANELA_MIN * 60 * 1000));
    console.log(`MODO INCREMENTAL: alterações entre ${ini} e ${fim}`);
  }

  const prods = await terasoft(ini, fim);
  console.log(`Terasoft devolveu ${prods.length} produtos`);
  if (!prods.length) { console.log("Nada mudou na janela. Encerrando."); return; }

  const existentes = await lerCodigosExistentes();
  const linhas = [];
  let novos = 0;

  for (const p of prods) {
    const cod = parseInt(p.CODIGO, 10);
    if (!Number.isFinite(cod)) continue;
    const linha = {
      codigo: cod,
      descricao: p.DESCRICAO || "",
      estoque: Number(p.ESTOQUE) || 0,
      preco: p.VENDA === null || p.VENDA === undefined ? null : String(p.VENDA),
      marca: p.MARCA || "",
    };
    if (!existentes.has(String(cod))) {
      novos++;
      linha.tipo = derivaTipo(p.DESCRICAO);
      linha.material = derivaMaterial(p.DESCRICAO);
    }
    linhas.push(linha);
  }

  const comEstoque = linhas.filter((l) => l.estoque > 0).length;
  const aurora = linhas.filter((l) => /aurora/i.test(l.marca)).length;
  console.log(`A gravar: ${linhas.length} | novos: ${novos} | com estoque: ${comEstoque} | Aurora Muniz: ${aurora}`);

  const gravados = await gravar(linhas);
  console.log(`\nOK. ${gravados} produtos gravados em ${Math.round((Date.now() - t0) / 1000)}s`);
})().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
