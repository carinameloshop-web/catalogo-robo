// Robô das FOTOS: lê as pastas do Drive e liga cada foto ao produto no catálogo (Supabase).
// Padrões de nome:
//   "5010"            -> foto principal do código 5010
//   "5010-5011-5012"  -> mesma foto principal p/ vários códigos
//   "5010 modelo"     -> 2ª foto (na modelo) do código 5010 (nome com letra = 2ª foto)
// Grava foto = "idPrincipal[,idModelo]" (separado por vírgula). Senhas via env (secrets).
const GKEY = process.env.GOOGLE_API_KEY;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.env.DRY === "1";
const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/produtos";
const FOLDERS = [
  "11ibI_41F9-S6d4gjVIN_bXGsOtLou7AV",
  "1mOffDv1VkstcmSm1VAMbntevLKQ6lFnL",
  "1DIHkbdJG8ouPWrBHimCxPhNddDvXrjBm",  // PERSONALIZADOS - 2026 (04/09/2026)
];

if (!GKEY) { console.error("Faltou GOOGLE_API_KEY"); process.exit(1); }
if (!SVC) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }

async function listFolder(folder) {
  let files = [], token = "";
  do {
    const q = "'" + folder + "' in parents and mimeType contains 'image/' and trashed=false";
    const url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&key=" + GKEY + "&fields=nextPageToken,files(id,name,modifiedTime)" +
      "&orderBy=modifiedTime desc&pageSize=1000" + (token ? "&pageToken=" + token : "");
    const j = await (await fetch(url)).json();
    if (j.error) throw new Error("Drive: " + j.error.message);
    files = files.concat(j.files || []);
    token = j.nextPageToken || "";
  } while (token);
  return files;
}

async function supaProdutos() {
  const map = new Map(); let off = 0;
  while (true) {
    const r = await fetch(SB + "?select=codigo,foto&limit=1000&offset=" + off, { headers: { apikey: SVC, Authorization: "Bearer " + SVC } });
    const d = await r.json();
    d.forEach((p) => map.set(String(p.codigo), p.foto));
    if (d.length < 1000) break; off += 1000;
  }
  return map;
}

async function sbSet(codigo, foto) {
  const r = await fetch(SB + "?codigo=eq." + codigo, {
    method: "PATCH", headers: { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ foto }),
  });
  return r.ok;
}

(async () => {
  const t0 = Date.now();
  const principal = new Map(); // codigo -> fileId (foto do produto)
  const modelo = new Map();    // codigo -> fileId (foto na modelo)
  const dono = new Map();      // fileId -> códigos que o NOME do arquivo reivindica
  for (const f of FOLDERS) {
    const files = await listFolder(f); // já vem do mais recente p/ o mais antigo
    for (const file of files) {
      const base = file.name.replace(/\.[a-z0-9]+$/i, "").trim();
      if (/^\d+(-\d+)*$/.test(base)) {            // "5010" ou "5010-5011" -> foto principal
        // tira o zero da frente: no Drive vem "005317", no catálogo o código é 5317.
        // Sem isso o robô procura um produto "005317", não acha, e a foto some em silêncio.
        for (const n of base.split("-")) {
          const c = String(Number(n));
          if (!principal.has(c)) principal.set(c, file.id);
          if (!dono.has(file.id)) dono.set(file.id, new Set());
          dono.get(file.id).add(c);
        }
      } else {
        const mm = base.match(/^(\d+)\s+[a-zA-Z]/); // "5010 modelo" -> 2ª foto do 5010
        if (mm) {
          const c = String(Number(mm[1]));
          if (!modelo.has(c)) modelo.set(c, file.id);
          if (!dono.has(file.id)) dono.set(file.id, new Set());
          dono.get(file.id).add(c);
        }
        // qualquer outro nome (logo, lixo, "5550 (2)") é ignorado
      }
    }
  }

  const desejado = new Map();
  const todos = new Set([...principal.keys(), ...modelo.keys()]);
  for (const c of todos) {
    const arr = [principal.get(c), modelo.get(c)].filter(Boolean);
    desejado.set(c, arr.join(","));
  }
  console.log("Fotos no Drive (códigos):", desejado.size, "| com 2ª foto (modelo):", modelo.size);

  const atual = await supaProdutos();
  let novas = 0, semProduto = 0, iguais = 0;
  for (const [cod, val] of desejado) {
    if (!atual.has(cod)) { semProduto++; continue; }
    if (atual.get(cod) === val) { iguais++; continue; }
    if (DRY) { novas++; continue; }
    if (await sbSet(cod, val)) novas++;
  }
  // Quando alguém RENOMEIA um arquivo no Drive porque a foto era de outra peça
  // (o "8050" virou "8058" em 04/09/2026), o robô grava a foto no código novo —
  // mas o código antigo fica apontando pra imagem errada pra sempre. O catálogo
  // mostrava um bracelete no lugar de um berloque. Aqui isso se desfaz sozinho.
  //
  // A regra é estreita de propósito: só apaga quando o arquivo AINDA EXISTE nas
  // pastas e o nome dele é de OUTRO código. Foto cujo arquivo não está nessas
  // pastas fica quieta — há 8 fotos assim, e todas estão certas.
  let limpas = 0;
  for (const [cod, val] of atual) {
    if (!val || desejado.has(cod)) continue;
    const errada = val.split(",").some((id) => dono.has(id) && !dono.get(id).has(cod));
    if (!errada) continue;
    console.log("  foto de outra peça, limpando:", cod, "->", val);
    if (DRY) { limpas++; continue; }
    if (await sbSet(cod, null)) limpas++;
  }

  console.log((DRY ? "A ATUALIZAR: " : "ATUALIZADAS: ") + novas, "| já certas:", iguais, "| fotos erradas limpas:", limpas, "| código sem produto:", semProduto,
    "| tempo:", Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("erro:", e.message); process.exit(1); });
