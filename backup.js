// CÓPIA DE SEGURANÇA DA MINHA MALETA (16/09/2026)
//
// Toda madrugada copia o banco inteiro (todas as tabelas) e os arquivos dos
// baldes privados (comprovantes, fotos dos personalizados, fotos das
// afiliadas) pro repositório PRIVADO carinameloshop-web/maleta-backup.
// Tudo sai TRANCADO (AES-256-GCM) com a senha BACKUP_SENHA, que só a Carina
// guarda. Sem a senha, a cópia não serve pra nada. Pra abrir: restaurar.js.
//
// Quanto tempo fica (decisão da Carina em 16/09/2026):
//  - tabelas: uma cópia por dia dos últimos 35 dias + a do dia 1 de cada mês
//    por 12 meses;
//  - arquivos: 1 ano, contado de quando a cópia pegou o arquivo. No site o
//    comprovante some em 60 dias; aqui fica mais tempo, pra caso de disputa.
// O repositório é refeito do zero a cada rodada (um commit só), então o que
// passou do prazo some de verdade, sem sobrar no histórico.
//
// Complementa o backup diário do Supabase Pro (7 dias, só tabelas).
//
// REPOSITÓRIO PÚBLICO: o log só mostra contagens.
//
// Uso: SUPABASE_SERVICE_KEY=... BACKUP_SENHA=... DESTINO=pasta node backup.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const SB = "https://dqljtdznecqzninwvtsj.supabase.co";
const SVC = process.env.SUPABASE_SERVICE_KEY;
const SENHA = process.env.BACKUP_SENHA;
const DESTINO = process.env.DESTINO || "backup";
const BALDES = ["comprovantes", "personalizados", "afiliadas"];
const cab = { apikey: SVC, Authorization: "Bearer " + SVC };

const DIAS_TABELAS = 35;
const MESES_TABELAS = 12;
const DIAS_ARQUIVOS = 365;

// formato: "CMB1" + sal(16) + iv(12) + etiqueta(16) + conteúdo trancado
function trancar(buf) {
  const sal = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chave = crypto.scryptSync(SENHA, sal, 32);
  const c = crypto.createCipheriv("aes-256-gcm", chave, iv);
  const corpo = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from("CMB1"), sal, iv, c.getAuthTag(), corpo]);
}

async function pedir(url, opc = {}) {
  for (let t = 1; ; t++) {
    const r = await fetch(url, { ...opc, headers: { ...cab, ...(opc.headers || {}) } });
    if (r.ok) return r;
    if (t >= 3) throw new Error("HTTP " + r.status + " em " + url.replace(SB, "").split("?")[0]);
    await new Promise((ok) => setTimeout(ok, 3000 * t));
  }
}

async function tabelas() {
  const api = await (await pedir(SB + "/rest/v1/", { headers: { Accept: "application/openapi+json" } })).json();
  const nomes = Object.keys(api.definitions || {}).sort();
  const tudo = {};
  let linhas = 0;
  for (const n of nomes) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const r = await pedir(SB + "/rest/v1/" + n + "?select=*&limit=1000&offset=" + off);
      const j = await r.json();
      out.push(...j);
      if (j.length < 1000) break;
    }
    tudo[n] = out;
    linhas += out.length;
  }
  return { tudo, nomes, linhas };
}

async function listar(balde, prefixo = "") {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await pedir(SB + "/storage/v1/object/list/" + balde, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: prefixo, limit: 1000, offset: off, sortBy: { column: "name", order: "asc" } }),
    });
    const j = await r.json();
    for (const e of j) {
      const nome = prefixo ? prefixo + "/" + e.name : e.name;
      if (e.id === null) out.push(...(await listar(balde, nome)));      // pasta
      else if (e.name !== ".emptyFolderPlaceholder") out.push({ nome, versao: e.updated_at || e.created_at || "" });
    }
    if (j.length < 1000) break;
  }
  return out;
}

const hoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const diasEntre = (a, b) => (new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000;

(async () => {
  if (!SVC || !SENHA) throw new Error("Falta SUPABASE_SERVICE_KEY ou BACKUP_SENHA");
  const dia = hoje();
  fs.mkdirSync(path.join(DESTINO, "tabelas"), { recursive: true });
  fs.mkdirSync(path.join(DESTINO, "arquivos"), { recursive: true });

  // ---- 1. tabelas
  const t = await tabelas();
  const json = Buffer.from(JSON.stringify({ dia, tabelas: t.tudo }));
  fs.writeFileSync(path.join(DESTINO, "tabelas", dia + ".json.gz.cmb"), trancar(zlib.gzipSync(json)));
  console.log("Tabelas: " + t.nomes.length + " | linhas: " + t.linhas);

  let apagadasT = 0;
  for (const f of fs.readdirSync(path.join(DESTINO, "tabelas"))) {
    const d = f.slice(0, 10);
    const idade = diasEntre(d, dia);
    const mensal = d.endsWith("-01") && idade <= MESES_TABELAS * 31;
    if (idade > DIAS_TABELAS && !mensal) { fs.unlinkSync(path.join(DESTINO, "tabelas", f)); apagadasT++; }
  }

  // ---- 2. arquivos (só baixa o que é novo ou mudou)
  const idxArq = path.join(DESTINO, "arquivos", "indice.json.cmb");
  let indice = {};
  if (fs.existsSync(idxArq)) {
    const b = fs.readFileSync(idxArq);
    const sal = b.subarray(4, 20), iv = b.subarray(20, 32), tag = b.subarray(32, 48);
    const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(SENHA, sal, 32), iv);
    d.setAuthTag(tag);
    indice = JSON.parse(Buffer.concat([d.update(b.subarray(48)), d.final()]).toString());
  }
  let novos = 0, total = 0, erros = 0;
  for (const balde of BALDES) {
    let lista = [];
    try { lista = await listar(balde); } catch (e) { erros++; continue; }
    for (const a of lista) {
      total++;
      const chave = balde + "/" + a.nome;
      if (indice[chave] && indice[chave].versao === a.versao) continue;
      try {
        const r = await pedir(SB + "/storage/v1/object/" + balde + "/" + a.nome.split("/").map(encodeURIComponent).join("/"));
        const buf = Buffer.from(await r.arrayBuffer());
        // nome do arquivo na cópia não revela nada: é um resumo do caminho
        const id = crypto.createHash("sha256").update(chave).digest("hex").slice(0, 32);
        fs.writeFileSync(path.join(DESTINO, "arquivos", id + ".cmb"), trancar(buf));
        indice[chave] = { id, versao: a.versao, guardado: dia, tipo: r.headers.get("content-type") || "" };
        novos++;
      } catch (e) { erros++; }
    }
  }
  let apagadosA = 0;
  for (const [chave, v] of Object.entries(indice)) {
    if (diasEntre(v.guardado, dia) > DIAS_ARQUIVOS) {
      const f = path.join(DESTINO, "arquivos", v.id + ".cmb");
      if (fs.existsSync(f)) fs.unlinkSync(f);
      delete indice[chave];
      apagadosA++;
    }
  }
  fs.writeFileSync(idxArq, trancar(Buffer.from(JSON.stringify(indice))));
  fs.writeFileSync(path.join(DESTINO, "README.md"),
    "# Cópia de segurança da Minha Maleta\n\nTudo aqui está trancado. Pra abrir, use `restaurar.js` do repositório catalogo-robo com a senha da Carina.\n\nÚltima cópia: " + dia + "\n");

  console.log("Arquivos: " + total + " nos baldes | copiados agora: " + novos + " | guardados: " + Object.keys(indice).length
    + " | erros: " + erros + " | vencidos apagados: " + apagadosA + " | cópias de tabela vencidas: " + apagadasT);
  if (erros) process.exitCode = 1;   // rodada fica vermelha no GitHub e chega e-mail
})().catch((e) => { console.error("Falhou: " + String(e.message).slice(0, 120)); process.exit(1); });
