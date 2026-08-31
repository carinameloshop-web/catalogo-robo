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

// TIPO e BANHO. Mudou em 31/08/2026, quando a Terasoft passou a mandar GRUPO
// no produto_periodo. Antes eu adivinhava os dois pela descrição, e errava:
// deu 392 correções na mão num único dia.
//
// A divisão de trabalho entre as duas fontes não é simétrica, e isso foi medido:
//   TIPO  -> o GRUPO manda. Ele diz colar/brinco/anel sem chance de erro.
//   BANHO -> a DESCRIÇÃO manda. Descrição e grupo se contradizem em 253 produtos,
//            e o grupo só resolve sozinho 115. Como a descrição é o título que a
//            afiliada lê no card, o rótulo tem que combinar com ela.
// Em ambos, a outra fonte entra só quando a primeira não sabe.

function derivaTipo(grupo, desc) {
  // 1. O grupo da Terasoft manda. Ele acerta 8 em cada 10.
  const g = (grupo || "").toUpperCase();
  // o grupo inteiro, não só o que vem depois do traço: existe "PIERCING - FOLHEADO",
  // onde a palavra que importa está na frente.
  const corpo = g;
  for (const [chave, t] of [["BRINCO", "Brinco"], ["PIERCING", "Brinco"], ["ARGOLA", "Brinco"],
                            ["ESCAPULARIO", "Colar"], ["COLAR", "Colar"], ["CORRENTE", "Colar"],
                            ["ANEL", "Anel"], ["BRACELETE", "Pulseira"], ["PULSEIRA", "Pulseira"],
                            ["BERLOQUE", "Pingente"], ["TORNOZELEIRA", "Tornozeleira"],
                            ["PRESILHA", "Outros"], ["LEN", "Outros"]]) {
    if (corpo.includes(chave)) return t;
  }

  // 2. Grupo de coleção (PERSONALIZADOS, HOMEM, FAST FASHION, GLAM, INFANTIL) não
  // diz o tipo. Aí lê a descrição. A ORDEM abaixo é o que importa, e ela foi tirada
  // de casos reais que a Carina apontou em 28 e 31/08/2026:
  const u = (desc || "").toUpperCase();

  // aparador é acessório de anel, e o número dele é aro, não centímetro
  if (/APARADOR/.test(u)) return "Anel";

  // o substantivo escrito ganha de tudo: "COLAR MONOGRAMA" é colar, não pingente
  if (/\bTRIO\b/.test(u) || /BRINCO|ARGOLA/.test(u)) return "Brinco";
  if (/ANEL|ALIAN[CÇ]A/.test(u)) return "Anel";
  if (/TORNOZELEIRA/.test(u)) return "Tornozeleira";
  if (/PULSEIRA|BRACELETE/.test(u)) return "Pulseira";
  if (/COLAR|GARGANTILHA|CORRENTE|ESCAPULARIO/.test(u)) return "Colar";

  // a medida vem ANTES de "pingente": "45CM VENEZIANA COM PINGENTE" é colar,
  // o pingente ali é o enfeite, não a peça
  const med = [...u.matchAll(/(?:^|[^\d,])(\d{2,3})\s?CM/g)].map((m) => parseInt(m[1], 10));
  if (med.length) {
    const m = Math.max(...med);
    if (m >= 33 && m <= 90) return "Colar";
    if (m >= 12 && m <= 21) return "Pulseira";
  }

  // corrente sem medida na descrição: veneziana, cordão e afins são colar
  if (/VENEZIANA|CORDAO|CORDÃO|CINGAPURA|CADEADO|CARTIER|RIVIERA|RIVIEIRA/.test(u)) return "Colar";
  if (/PINGENTE|BERLOQUE/.test(u)) return "Pingente";
  if (/DUPLINHA/.test(u)) return "Brinco";
  if (/MONOGRAMA/.test(u)) return "Pingente";

  // peça que COMEÇA com ARO é colar. "BRINCO ARO" não cai aqui: já saiu acima.
  const semBanho = u.replace(/^\s*#*\s*(OURO BRANCO|RODIO BRANCO|PALADIUM|PALADIO|STEEL|ACO|AÇO|PRATA|GRAFITE|OURO|RODIO)\s*-\s*/, "").trim();
  if (semBanho.startsWith("ARO ")) return "Colar";

  return "Outros";
}

function derivaBanho(desc, grupo) {
  const u = (desc || "").trim().toUpperCase();
  for (const [pre, v] of [["OURO BRANCO", "Ouro Branco"], ["RODIO BRANCO", "Ouro Branco"],
                          ["PALADIUM", "Paladio"], ["PALADIO", "Paladio"],
                          ["STEEL", "Steel"], ["ACO ", "Steel"], ["AÇO ", "Steel"], ["PRATA", "Prata"],
                          ["GRAFITE", "Grafite"], ["OURO", "Ouro"]]) {
    if (u.startsWith(pre)) return v;
  }
  const g = (grupo || "").toUpperCase();
  if (g.startsWith("OURO BRANCO") || g.startsWith("RODIO BRANCO")) return "Ouro Branco";
  if (g.startsWith("PALADIUM") || g.startsWith("PALADIO")) return "Paladio";
  if (g.startsWith("OURO")) return "Ouro";
  if (g.includes("STEEL")) return "Steel";
  if (g.startsWith("GRAFITE")) return "Grafite";
  return "Ouro";
}

// Lê o que já está no catálogo hoje: código, estoque e preço.
// Serve pra duas coisas: saber quem é novo, e evitar regravar quem não mudou.
async function lerAtual() {
  const mapa = new Map();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(SB + "?select=codigo,estoque,preco,tipo,material,grupo&limit=1000&offset=" + off, {
      headers: { apikey: SVC, Authorization: "Bearer " + SVC },
    });
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    d.forEach((x) => mapa.set(String(x.codigo), {
      estoque: Number(x.estoque) || 0,
      preco: x.preco === null ? null : String(x.preco),
      tipo: x.tipo || null, material: x.material || null, grupo: x.grupo || null,
    }));
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
    body: JSON.stringify({
      estoque: l.estoque, preco: l.preco, descricao: l.descricao, marca: l.marca,
      grupo: l.grupo, tipo: l.tipo, material: l.material,
    }),
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
  let ini;
  const fim = fmt(agora);

  let prods;

  if (MODO === "full") {
    // ATENÇÃO: janela muito longa faz a Terasoft CORTAR o resultado sem avisar.
    // Medido em 25/08/2026: "2020 até hoje" devolveu 9.997 produtos e "2023 até hoje"
    // devolveu 10.087, sendo o primeiro subconjunto exato do segundo. Nada falha,
    // só faltam registros. Por isso a carga completa vai ano a ano.
    console.log("MODO COMPLETO: puxando ano a ano, pra não perder registro");
    const mapa = new Map();
    const anoFinal = agora.getFullYear();
    for (let ano = 2023; ano <= anoFinal; ano++) {
      const de = `01/01/${ano} 00:00:00`;
      const ate = ano === anoFinal ? fim : `31/12/${ano} 23:59:59`;
      const parte = await terasoft(de, ate);
      parte.forEach((x) => mapa.set(String(x.CODIGO), x));
      console.log(`   ${ano}: ${parte.length} produtos (acumulado ${mapa.size})`);
    }
    prods = [...mapa.values()];
    console.log(`Total consolidado: ${prods.length} produtos`);
  } else {
    ini = fmt(new Date(agora.getTime() - JANELA_MIN * 60 * 1000));
    console.log(`MODO INCREMENTAL: alterações entre ${ini} e ${fim}`);
    prods = await terasoft(ini, fim);
    console.log(`Terasoft devolveu ${prods.length} produtos`);
  }
  if (!prods.length) { console.log("Nada mudou na janela. Encerrando."); return; }

  const atual = await lerAtual();
  console.log(`Catálogo tem hoje ${atual.size} produtos`);
  const atualizar = [];
  const inserir = [];

  for (const p of prods) {
    const cod = parseInt(p.CODIGO, 10);
    if (!Number.isFinite(cod)) continue;
    const linha = {
      codigo: cod,
      descricao: p.DESCRICAO || "",
      estoque: Number(p.ESTOQUE) || 0,
      preco: p.VENDA === null || p.VENDA === undefined ? null : String(p.VENDA),
      marca: p.MARCA || "",
      grupo: p.GRUPO || null,
    };
    // Tipo e banho são recalculados SEMPRE, não só no cadastro. Era esse o
    // buraco antigo: o produto nascia com um rótulo e nunca mais era revisto,
    // então corrigir a regra não consertava nada do que já estava lá.
    linha.tipo = derivaTipo(linha.grupo, linha.descricao);
    linha.material = derivaBanho(linha.descricao, linha.grupo);

    const antes = atual.get(String(cod));
    if (antes) {
      const mudou = antes.estoque !== linha.estoque || antes.preco !== linha.preco
                 || antes.grupo !== linha.grupo || antes.tipo !== linha.tipo
                 || antes.material !== linha.material;
      if (mudou) atualizar.push(linha);
    } else {
      inserir.push(linha);
    }
  }

  console.log(`Mudaram de verdade: ${atualizar.length} | produtos novos a cadastrar: ${inserir.length}`);

  const a = await atualizarTodos(atualizar);
  const b = await inserirTodos(inserir);
  console.log(`OK. ${a + b} produtos gravados em ${Math.round((Date.now() - t0) / 1000)}s`);
})().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
