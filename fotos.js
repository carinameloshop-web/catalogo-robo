// Robô das FOTOS: lê as pastas do Drive e liga cada foto ao produto no catálogo (Supabase).
// Padrões de nome: "5010" (1 código) ou "5010-5011-5012" (mesma foto p/ vários códigos).
// Nomes com letras (ex.: "5010 modelo") são ignorados por ora (reservado p/ 2ª foto).
// Senhas via env (secrets): GOOGLE_API_KEY, SUPABASE_SERVICE_KEY.
const GKEY = process.env.GOOGLE_API_KEY;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.env.DRY === "1";
const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/produtos";
const FOLDERS = ["11ibI_41F9-S6d4gjVIN_bXGsOtLou7AV", "1mOffDv1VkstcmSm1VAMbntevLKQ6lFnL"];

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
  // 1) monta código -> fileId a partir das duas pastas (mais recente vence)
  const desejado = new Map();
  for (const f of FOLDERS) {
    const files = await listFolder(f); // já vem ordenado por mais recente
    for (const file of files) {
      const base = file.name.replace(/\.[a-z0-9]+$/i, "").trim();
      if (!/^[\d\s-]+$/.test(base)) continue; // ignora nomes com letras (ex.: "modelo")
      const codes = base.match(/\d+/g) || [];
      for (const c of codes) if (!desejado.has(c)) desejado.set(c, file.id);
    }
  }
  console.log("Fotos no Drive (códigos):", desejado.size);

  // 2) estado atual do catálogo
  const atual = await supaProdutos();

  // 3) aplica só as diferenças
  let novas = 0, semProduto = 0, iguais = 0;
  for (const [cod, fid] of desejado) {
    if (!atual.has(cod)) { semProduto++; continue; }
    if (atual.get(cod) === fid) { iguais++; continue; }
    if (DRY) { novas++; continue; }
    if (await sbSet(cod, fid)) novas++;
  }
  console.log((DRY ? "A ATUALIZAR: " : "ATUALIZADAS: ") + novas, "| já certas:", iguais, "| código sem produto:", semProduto,
    "| tempo:", Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("erro:", e.message); process.exit(1); });
