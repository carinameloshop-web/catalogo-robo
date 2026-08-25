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

const https = require("node:https");

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

function terasoft(ini, fim) {
  // O servidor da Terasoft usa certificado próprio, que o Node recusa por padrão.
  // Por isso NÃO dá pra usar fetch() aqui: é preciso o módulo https com
  // rejectUnauthorized:false, do mesmo jeito que o robô antigo fazia.
  const caminho = "/consulta?ep=produto_periodo" +
    "&data_inicial=" + encodeURIComponent(ini) +
    "&data_final=" + encodeURIComponent(fim);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "apiserver.ip.inf.br", port: 12067, path: caminho, method: "GET",
      headers: { Authorization: AUTH },
      rejectUnauthorized: false,
      timeout: 300000,
    }, (r) => {
      const partes = [];
      r.on("data", (c) => partes.push(c));
      r.on("end", () => {
        const txt = Buffer.concat(partes).toString("utf8");
        let j;
        try { j = JSON.parse(txt); }
        catch (e) { return reject(new Error("Terasoft devolveu algo que não é JSON: " + txt.slice(0, 200))); }
        // O bloqueio por limite vem como objeto com sucesso:false. Antes isso passava
        // despercebido e o robô terminava "com sucesso" sem atualizar nada.
        if (!Array.isArray(j)) {
          const msg = (j && j.mensagem) ? String(j.mensagem).replace(/\n/g, " ") : JSON.stringify(j).slice(0, 200);
          return reject(new Error("Terasoft recusou a consulta: " + msg));
        }
        resolve(j);
      });
    });
    req.on("error", (e) => reject(new Error("Falha de conexão com a Terasoft: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Terasoft não respondeu em 5 minutos")); });
    req.end();
  });
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

// Lê o que já está no catálogo hoje: código, estoque e preço.
// Serve pra duas coisas: saber quem é novo, e evitar regravar quem não mudou.
async function lerAtual() {
  const mapa = new Map();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(SB + "?select=codigo,estoque,preco&limit=1000&offset=" + off, {
      headers: { apikey: SVC, Authorization: "Bearer " + SVC },
    });
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    d.forEach((x) => mapa.set(String(x.codigo), { estoque: Number(x.estoque) || 0, preco: x.preco === null ? null : String(x.preco) }));
    if (d.length < 1000) break;
  }
  return mapa;
}

// ATUALIZAR: uma chamada por produto, em paralelo. Não usa upsert de propósito,
// porque a tabela não tem restrição de unicidade no código e o Supabase recusaria.
// Como só atualizamos o que realmente mudou, o volume costuma ser pequeno.
const CONC = 15;
async function atualizarUm(l) {
  const r = await fetch(SB + "?codigo=eq." + l.codigo, {
    method: "PATCH",
    headers: {
      apikey: SVC, Authorization: "Bearer " + SVC,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify({ estoque: l.estoque, preco: l.preco, descricao: l.descricao, marca: l.marca }),
  });
  if (!r.ok) throw new Error("Supabase recusou atualizar o código " + l.codigo + ": " + (await r.text()).slice(0, 160));
}
async function atualizarTodos(linhas) {
  let feitos = 0;
  for (let i = 0; i < linhas.length; i += CONC) {
    await Promise.all(linhas.slice(i, i + CONC).map(atualizarUm));
    feitos += Math.min(CONC, linhas.length - i);
    if (feitos % 300 === 0 || feitos === linhas.length) console.log(`   atualizados ${feitos}/${linhas.length}`);
  }
  return feitos;
}

// CADASTRAR: inserção simples em lote, que não depende de restrição nenhuma.
async function inserirTodos(linhas) {
  let ok = 0;
  for (let i = 0; i < linhas.length; i += 500) {
    const lote = linhas.slice(i, i + 500);
    const r = await fetch(SB, {
      method: "POST",
      headers: {
        apikey: SVC, Authorization: "Bearer " + SVC,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(lote),
    });
    if (!r.ok) throw new Error("Supabase recusou cadastrar o lote " + (i / 500 + 1) + ": " + (await r.text()).slice(0, 160));
    ok += lote.length;
    console.log(`   cadastrados ${ok}/${linhas.length}`);
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

  const atual = await lerAtual();
  console.log(`Catálogo tem hoje ${atual.size} produtos`);
  const atualizar = [];   // já existem: só estoque, preço, descrição e marca
  const inserir = [];     // novos: levam também tipo e material

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
    const antes = atual.get(String(cod));
    if (antes) {
      // só entra na fila de atualização quem realmente mudou
      if (antes.estoque !== linha.estoque || antes.preco !== linha.preco) atualizar.push(linha);
    } else {
      linha.tipo = derivaTipo(p.DESCRICAO);
      linha.material = derivaMaterial(p.DESCRICAO);
      inserir.push(linha);
    }
  }

  console.log(`Mudaram de verdade: ${atualizar.length} | produtos novos a cadastrar: ${inserir.length}`);

  const a = await atualizarTodos(atualizar);
  const b = await inserirTodos(inserir);
  console.log(`OK. ${a + b} produtos gravados em ${Math.round((Date.now() - t0) / 1000)}s`);
})().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
