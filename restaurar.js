// ABRE A CÓPIA DE SEGURANÇA DA MINHA MALETA (ver backup.js)
//
// Uso, com a pasta do repositório maleta-backup baixada:
//   BACKUP_SENHA=... node restaurar.js pasta-do-backup pasta-de-saida [AAAA-MM-DD]
//
// Gera em pasta-de-saida:
//   tabelas-AAAA-MM-DD.json   todas as tabelas daquele dia (a mais recente se
//                             não informar o dia)
//   arquivos/<balde>/<caminho original>   comprovantes e fotos
// Voltar pro Supabase é um passo à parte, feito com cuidado (upsert por tabela).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const SENHA = process.env.BACKUP_SENHA;
const [, , ORIGEM, SAIDA, DIA] = process.argv;

function abrir(b) {
  if (b.subarray(0, 4).toString() !== "CMB1") throw new Error("arquivo não é da cópia");
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(SENHA, b.subarray(4, 20), 32), b.subarray(20, 32));
  d.setAuthTag(b.subarray(32, 48));
  return Buffer.concat([d.update(b.subarray(48)), d.final()]);
}

if (!SENHA || !ORIGEM || !SAIDA) { console.log("Uso: BACKUP_SENHA=... node restaurar.js pasta-do-backup pasta-de-saida [AAAA-MM-DD]"); process.exit(1); }
fs.mkdirSync(SAIDA, { recursive: true });

const dias = fs.readdirSync(path.join(ORIGEM, "tabelas")).filter((f) => f.endsWith(".cmb")).sort();
const escolhido = DIA ? dias.find((f) => f.startsWith(DIA)) : dias[dias.length - 1];
if (!escolhido) throw new Error("não há cópia de tabelas desse dia");
const tab = zlib.gunzipSync(abrir(fs.readFileSync(path.join(ORIGEM, "tabelas", escolhido))));
fs.writeFileSync(path.join(SAIDA, "tabelas-" + escolhido.slice(0, 10) + ".json"), tab);
console.log("Tabelas de " + escolhido.slice(0, 10) + " abertas.");

const indice = JSON.parse(abrir(fs.readFileSync(path.join(ORIGEM, "arquivos", "indice.json.cmb"))).toString());
let n = 0;
for (const [chave, v] of Object.entries(indice)) {
  const f = path.join(ORIGEM, "arquivos", v.id + ".cmb");
  if (!fs.existsSync(f)) continue;
  const alvo = path.join(SAIDA, "arquivos", ...chave.split("/"));
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, abrir(fs.readFileSync(f)));
  n++;
}
console.log(n + " arquivos abertos.");
