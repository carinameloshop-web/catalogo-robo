// Robô das FOTOS: lê as pastas do Drive e liga cada foto ao produto no catálogo (Supabase).
// Padrões de nome:
//   "5010"            -> foto principal do código 5010
//   "5010-5011-5012"  -> mesma foto principal p/ vários códigos
//   "5010 modelo"     -> 2ª foto (na modelo) do código 5010 (nome com letra = 2ª foto)
// Grava foto = "idPrincipal[,idModelo]" (separado por vírgula). Senhas via env (secrets).
const { classificar } = require("./categorias-personalizados");

const GKEY = process.env.GOOGLE_API_KEY;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.env.DRY === "1";
const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/produtos";
const SBM = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1/modelo_banhos";
const FOLDERS = [
  "11ibI_41F9-S6d4gjVIN_bXGsOtLou7AV",
  "1mOffDv1VkstcmSm1VAMbntevLKQ6lFnL",
  "1DIHkbdJG8ouPWrBHimCxPhNddDvXrjBm",  // PERSONALIZADOS - 2026 (04/09/2026)
  // FOTOS COM CODIGOS AURORA MUNIZ (07/09/2026) — abastece o catálogo da
  // Aurora (catalogo-aurora.vercel.app). São 136 arquivos / 130 códigos, todos
  // de marca AURORA, então nenhuma foto daqui cai no catálogo da Carina Melo.
  "1X1i-x19M-H6cEoWmwNAByaLMOtbiVCPQ",
];
// Esta pasta é especial: a foto dentro dela É a aprovação do modelo de
// personalizado. Só aparece pra afiliada o código que estiver aqui.
const PASTA_PERSONALIZADOS = "1DIHkbdJG8ouPWrBHimCxPhNddDvXrjBm";

if (!GKEY) { console.error("Faltou GOOGLE_API_KEY"); process.exit(1); }
if (!SVC) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }

// Aceita tambem ATALHO do Drive: a pasta da Aurora Muniz veio com 31 fotos
// postas como atalho, e atalho nao e "image/" — o filtro antigo largava todas
// pra tras em silencio. Aqui o atalho e trocado pelo arquivo que ele aponta,
// mantendo o NOME do atalho (e o nome que carrega o codigo da peca).
const MIME_ATALHO = "application/vnd.google-apps.shortcut";
async function listFolder(folder) {
  let files = [], token = "";
  do {
    const q = "'" + folder + "' in parents and (mimeType contains 'image/'"
      + " or mimeType = '" + MIME_ATALHO + "') and trashed=false";
    const url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&key=" + GKEY + "&fields=nextPageToken,files(id,name,modifiedTime,mimeType,"
      + "shortcutDetails(targetId,targetMimeType))" +
      "&orderBy=modifiedTime desc&pageSize=1000" + (token ? "&pageToken=" + token : "");
    const j = await (await fetch(url)).json();
    if (j.error) throw new Error("Drive: " + j.error.message);
    for (const f of (j.files || [])) {
      if (f.mimeType !== MIME_ATALHO) { files.push(f); continue; }
      const alvo = f.shortcutDetails || {};
      // atalho pra coisa que nao e imagem (pasta, documento) nao interessa
      if (!alvo.targetId || !String(alvo.targetMimeType || "").startsWith("image/")) continue;
      files.push({ id: alvo.targetId, name: f.name, modifiedTime: f.modifiedTime });
    }
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
  const modelos = new Set();   // códigos que estão na pasta dos personalizados
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
          if (f === PASTA_PERSONALIZADOS) modelos.add(Number(c));
        }
      } else {
        const mm = base.match(/^(\d+)\s+[a-zA-Z]/); // "5010 modelo" -> 2ª foto do 5010
        if (mm) {
          const c = String(Number(mm[1]));
          if (!modelo.has(c)) modelo.set(c, file.id);
          if (!dono.has(file.id)) dono.set(file.id, new Set());
          dono.get(file.id).add(c);
          if (f === PASTA_PERSONALIZADOS) modelos.add(Number(c));
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

  // ---- os modelos de personalizado
  // Pôr a foto na pasta é o que aprova o modelo; tirar é o que despublica.
  // Não é preciso lista nenhuma, nem revisão de 1.237 códigos.
  // Aqui só se liga e desliga: os banhos que cada modelo aceita quem decide
  // é a Carina, na tela de gestão, e este robô nunca mexe neles.
  let mNovos = 0, mLigados = 0, mDesligados = 0, mRecusados = 0, mLimpos = 0;
  try {
    const cab2 = { apikey: SVC, Authorization: "Bearer " + SVC };
    const cab3 = { ...cab2, "Content-Type": "application/json", Prefer: "return=minimal" };

    // ---- a trava do código descontinuado
    // Descontinuado quer dizer que o código mudou. A foto colada no código
    // velho traz o PREÇO velho junto, e a afiliada mostra menos do que a peça
    // custa hoje. Aconteceu em 07/09/2026 com 13 modelos, R$ 177 no lugar de
    // R$ 219. Aqui o modelo é recusado e a nota já diz pra qual código
    // renomear a foto, achando o substituto pela descrição idêntica.
    const cods = [...modelos];
    const marcas = new Map();
    for (let i = 0; i < cods.length; i += 200) {
      const p = await (await fetch(SB + "?codigo=in.(" + cods.slice(i, i + 200).join(",")
        + ")&select=codigo,descricao,marca", { headers: cab2 })).json();
      for (const x of p) marcas.set(Number(x.codigo), x);
    }
    const normal = (d) => String(d || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const ruins = [...modelos].filter((c) => /DESCONTINUADO|INSUMO/i.test((marcas.get(c) || {}).marca || ""));
    const bons = new Set([...modelos].filter((c) => !ruins.includes(c)));

    // pra cada recusado, procura o código novo com a mesma descrição
    const nota = new Map();
    for (const c of ruins) {
      const d = normal((marcas.get(c) || {}).descricao);
      let sub = "";
      if (d) {
        const iguais = await (await fetch(SB + "?select=codigo,descricao,marca&descricao=ilike."
          + encodeURIComponent("*" + String((marcas.get(c) || {}).descricao || "").slice(0, 40) + "*"),
          { headers: cab2 })).json();
        const achou = (iguais || []).find((x) => Number(x.codigo) !== c
          && normal(x.descricao) === d && !/DESCONTINUADO|INSUMO/i.test(x.marca || ""));
        if (achou) sub = String(achou.codigo).padStart(6, "0");
      }
      nota.set(c, sub ? "código descontinuado. Renomear a foto para " + sub
                     : "código descontinuado. Procurar o código novo desta peça.");
      console.log("  RECUSADO:", String(c).padStart(6, "0"), "->", nota.get(c));
    }
    mRecusados = ruins.length;

    const atuaisM = await (await fetch(SBM + "?select=codigo,ativo,nota", { headers: cab2 })).json();
    const jaTem = new Map(atuaisM.map((m) => [Number(m.codigo), m.ativo]));
    const faltando = [...modelos].filter((c) => !jaTem.has(c));
    if (faltando.length && !DRY) {
      // ouro e paládio ligados, steel desligado: steel é a exceção.
      // ouro branco não existe em personalizado, então nem é campo.
      await fetch(SBM, {
        method: "POST", headers: cab3,
        body: JSON.stringify(faltando.map((c) => ({
          codigo: c, ativo: bons.has(c), nota: nota.get(c) || null,
          // Modelo novo ja nasce classificado. A Carina corrige na tela de
          // gestao o que a regra errar, e o robo nunca desfaz a correcao dela:
          // so classifica quem ainda nao tem categoria nenhuma.
          categorias: classificar((marcas.get(c) || {}).descricao || ""),
        }))),
      });
    }
    mNovos = faltando.length;
    // A nota só faz sentido enquanto o arquivo ruim ainda está na pasta. Quando
    // ele sai (renomeado ou apagado), a nota tem que sair junto, senão o aviso
    // vermelho fica pra sempre e ninguém acredita nele depois.
    const notaAtual = new Map(atuaisM.map((m) => [Number(m.codigo), m.nota || null]));
    for (const [c, ativo] of jaTem) {
      const deveria = bons.has(c);
      const notaNova = modelos.has(c) ? (nota.get(c) || null) : null;
      if (deveria === ativo && notaNova === notaAtual.get(c)) continue;
      if (deveria !== ativo) { if (deveria) mLigados++; else mDesligados++; }
      if (notaNova === null && notaAtual.get(c)) mLimpos++;
      if (DRY) continue;
      await fetch(SBM + "?codigo=eq." + c, {
        method: "PATCH", headers: cab3,
        body: JSON.stringify({ ativo: deveria, nota: notaNova }),
      });
    }
  } catch (e) {
    console.error("  modelos de personalizado: falhou,", e.message);
  }
  console.log("Modelos de personalizado:", modelos.size, "na pasta | novos:", mNovos,
              "| religados:", mLigados, "| desligados:", mDesligados,
              "| RECUSADOS por código descontinuado:", mRecusados,
              "| avisos resolvidos:", mLimpos);

  console.log((DRY ? "A ATUALIZAR: " : "ATUALIZADAS: ") + novas, "| já certas:", iguais, "| fotos erradas limpas:", limpas, "| código sem produto:", semProduto,
    "| tempo:", Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("erro:", e.message); process.exit(1); });
