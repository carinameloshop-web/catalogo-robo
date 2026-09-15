// ROBÔ DO WHATSAPP · grupos de pedido -> Supabase, toda madrugada
//
// Pedido da Carina em 14/09/2026: a Terasoft só fica sabendo da afiliada no
// acerto, uns 35 dias depois. O dia a dia está no grupo de WhatsApp. Este robô
// lê o grupo "Pedidos ..." de cada afiliada e deixa pro painel da manhã:
// quando ela falou por último, se mandou comprovante, se pediu peça, se contou
// venda. Lê áudio também (transcrição da uazapi, já ligada desde 28/07/2026).
//
// O que faz:
//  1. Liga cada afiliada ao grupo dela pelo TELEFONE entre os participantes
//     (com e sem o 9 depois do DDD). Afiliada sem WhatsApp no cadastro: tenta
//     pelo nome no grupo e, se só um participante sobra fora da equipe, grava
//     o número dela. Várias com o mesmo grupo ou vários grupos: vale o mais
//     recente. Grava em afiliadas.grupo_whatsapp.
//  2. Lê as mensagens de ontem e de hoje do grupo de cada afiliada e grava um
//     resumo por dia em contato_whatsapp (recalcula o dia inteiro, então rodar
//     duas vezes não duplica).
//  3. Áudio DELA é transcrito uma vez só e guardado em whatsapp_audios (o
//     WhatsApp apaga a mídia em 2 dias; a transcrição custa, então não repete).
//
// Só LÊ. Nunca envia mensagem: o número principal carrega a operação inteira.
//
// O REPOSITÓRIO É PÚBLICO e o log das Actions também: só contagens aqui.

const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1";
const SVC = process.env.SUPABASE_SERVICE_KEY;
const ZAP = process.env.UAZAPI_URL || "https://carinamelo.uazapi.com";
const ZTOKEN = process.env.UAZAPI_TOKEN;
const DRY = process.env.DRY === "1";
const DIAS = parseInt(process.env.DIAS || "2", 10);   // ontem e hoje
const TRANSCREVER = process.env.TRANSCREVER !== "0";
const DEBUG = process.env.DEBUG === "1";   // só pra rodar no computador: imprime nomes

if (!SVC) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }
if (!ZTOKEN) { console.error("Faltou UAZAPI_TOKEN"); process.exit(1); }

// A equipe. Tudo que sai daqui é "escritório". O 554499981150 NÃO entra: é o
// celular pessoal da Andressa Caroline, que hoje é afiliada.
const EQUIPE = new Set([
  "554491182616",   // Carina (número conectado)
  "554491584157",   // Iza
  "554491728014",   // escritório, Cássia
  "554491445048",   // corporativo, ex-Andressa
]);

const cab = { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json" };
async function ler(c) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(SB + c + (c.includes("?") ? "&" : "?") + "limit=1000&offset=" + off, { headers: cab });
    if (!r.ok) throw new Error("Supabase leitura: " + (await r.text()).slice(0, 200));
    const j = await r.json();
    out.push(...j);
    if (j.length < 1000) return out;
  }
}
async function gravar(metodo, caminho, corpo, prefer) {
  if (DRY) return [];
  const r = await fetch(SB + caminho, {
    method: metodo, headers: { ...cab, Prefer: prefer || "return=minimal" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error("Supabase " + metodo + " " + caminho.split("?")[0] + ": " + (await r.text()).slice(0, 200));
}
async function zap(caminho, corpo) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const r = await fetch(ZAP + caminho, {
        method: "POST", headers: { "Content-Type": "application/json", token: ZTOKEN }, body: JSON.stringify(corpo),
      });
      if (!r.ok) throw new Error("uazapi " + caminho + " " + r.status);
      return await r.json();
    } catch (e) {
      if (tentativa >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * tentativa));
    }
  }
}

// Telefone comparável: só dígitos, sem 55, sem o 9 depois do DDD.
function tel(s) {
  let d = String(s || "").split("@")[0].replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d;
}
const EQUIPE_T = new Set([...EQUIPE].map(tel));
const lid = (s) => String(s || "").split("@")[0].split(":")[0];
const limpar = (s) => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ms = (t) => { const v = Number(t); return v > 1e11 ? v : v * 1000; };
const diaBR = (t) => new Date(ms(t) - 3 * 3600000).toISOString().slice(0, 10);

// ---- o que a mensagem diz. Regras simples, de propósito: dá pra conferir.
const R_COMPROVANTE = /comprovante|\bpix\b|transfer[eêi]|paguei|pagamento|dep[oó]sit|boleto|\bpago\b|\bpaga\b/i;
// Pedido de peça: ela quer peça que não está na mão. Ficou de fora de propósito
// "falta", "pedido" e "acabou": marcavam "passo lá sem falta" e "é do pedido".
const R_PEDIDO = /\btem (ess[ae]s?|aquel[ae]s?|mais|dispon|no (estoque|escrit)|de volta)|voc[eê]s? t[eê]m|\bainda tem\b|\bpreciso d[aeo]s? (pe[cç]|brinc|colar|anel|an[eé]is|pulseir|escapul|berlo|argol)|\bmanda(r)? (mais|outr)|\brepor\b|reposi[cç][aã]o|consegue(m)? (me )?(mandar|enviar|separar)|\bseparar? pra mim\b/i;
const R_VENDA = /\bvendi\b|\bvendeu\b|\bcomprou\b|\blevou\b|\bvendid[ao]\b|\bfiado\b|cliente (quer|pagou|comprou|levou|gostou)/i;

(async () => {
  const t0 = Date.now();
  const desdeDia = new Date(Date.now() - 3 * 3600000 - (DIAS - 1) * 86400000).toISOString().slice(0, 10);
  const desdeMs = new Date(desdeDia + "T03:00:00Z").getTime();

  const afs = (await ler("/afiliadas?ativa=eq.true&select=id,nome,cidade,whatsapp,grupo_whatsapp,tipo"))
    .filter((a) => a.tipo !== "interna");
  const comMaleta = new Set((await ler("/maletas?ativa=eq.true&select=afiliada_id")).map((m) => m.afiliada_id));

  // ---- 1. os grupos e quem está em cada um
  const resp = await zap("/chat/find", { operator: "AND", sort: "-wa_lastMsgTimestamp", limit: 2000 });
  const grupos = (resp.chats || []).filter((c) => String(c.wa_chatid || "").endsWith("@g.us")
    && /PEDIDO/.test(limpar(c.wa_name)));
  const info = new Map();
  for (const g of grupos) {
    try {
      const d = await zap("/group/info", { groupjid: g.wa_chatid });
      info.set(g.wa_chatid, {
        nome: g.wa_name, ultima: ms(g.wa_lastMsgTimestamp || 0),
        participantes: (d.Participants || []).map((p) => ({ lid: lid(p.JID), tel: tel(p.PhoneNumber), bruto: String(p.PhoneNumber || "").split("@")[0] })),
      });
    } catch (e) { /* grupo que falhou fica pra amanhã */ }
  }

  let ligadasTel = 0, ligadasNome = 0, zapNovo = 0, semGrupo = 0;
  for (const a of afs) {
    const t = tel(a.whatsapp);
    let cands = t ? [...info.entries()].filter(([, g]) => g.participantes.some((p) => p.tel === t)) : [];
    let peloNome = false;
    if (!cands.length) {
      // Sem telefone (ou telefone que não está em grupo nenhum): primeiro nome
      // mais um sobrenome ou a cidade no nome do grupo, e só se for um grupo só.
      const nomes = limpar(a.nome).split(" ").filter((w) => w.length > 2 && !["DOS", "DAS"].includes(w));
      const cid = limpar(a.cidade);
      cands = [...info.entries()].filter(([, g]) => {
        const gn = limpar(g.nome).split(" ");
        return nomes.length && gn.includes(nomes[0])
          && (nomes.slice(1).some((w) => gn.includes(w)) || (cid && limpar(g.nome).includes(cid)));
      });
      if (cands.length > 1) cands = [];
      peloNome = cands.length === 1;
    }
    if (!cands.length) { semGrupo++; a._grupo = null; if (DEBUG) console.log("  sem grupo:", a.nome); continue; }
    // Líder e ex-equipe estão no grupo de outras afiliadas (a Andressa Caroline
    // está em 15). O grupo DELA é o que tem o primeiro nome dela no nome do
    // grupo; só sem nenhum assim vale o mais movimentado.
    const primeiro = limpar(a.nome).split(" ")[0];
    const comNome = cands.filter(([, g]) => limpar(g.nome).split(" ").includes(primeiro));
    if (comNome.length) cands = comNome;
    cands.sort((x, y) => y[1].ultima - x[1].ultima);
    const [jid, g] = cands[0];
    a._grupo = jid;
    peloNome ? ligadasNome++ : ligadasTel++;
    if (DEBUG && (peloNome || cands.length > 1)) console.log("  " + (peloNome ? "pelo nome" : cands.length + " grupos") + ": " + a.nome + " -> " + g.nome);
    const mudou = {};
    if (a.grupo_whatsapp !== jid) mudou.grupo_whatsapp = jid;
    if (!a.whatsapp && peloNome) {
      const fora = g.participantes.filter((p) => p.tel && !EQUIPE_T.has(p.tel));
      if (fora.length === 1) { mudou.whatsapp = fora[0].bruto; zapNovo++; }
    }
    if (Object.keys(mudou).length) await gravar("PATCH", "/afiliadas?id=eq." + a.id, mudou);
  }
  console.log("Grupos de pedido: " + grupos.length + " | ligadas pelo telefone: " + ligadasTel
    + " | pelo nome: " + ligadasNome + " | WhatsApp descoberto: " + zapNovo + " | sem grupo: " + semGrupo);

  // ---- 2. as mensagens de ontem e hoje
  const jaTranscritos = new Set((await ler("/whatsapp_audios?quando=gte." + new Date(desdeMs - 86400000).toISOString() + "&select=id")
    .catch(() => [])).map((x) => x.id));
  const resumos = [], audiosNovos = [];
  let lidas = 0, transcritos = 0, falhasAudio = 0;

  for (const a of afs) {
    if (!a._grupo) continue;
    const g = info.get(a._grupo);
    const t = tel(a.whatsapp) || null;
    const lidsDela = new Set(g.participantes.filter((p) => t && p.tel === t).map((p) => p.lid));
    const lidsEquipe = new Set(g.participantes.filter((p) => EQUIPE_T.has(p.tel)).map((p) => p.lid));
    const m = await zap("/message/find", { chatid: a._grupo, limit: 400 });
    const todas = m.messages || [];
    // Grupo muito movimentado pode ter mais de 400 mensagens na janela. Aí o
    // dia mais antigo veio pela metade: começa no primeiro dia completo, pra
    // não gravar contagem cortada nem silêncio que não existiu.
    let inicioGrupo = desdeMs;
    if (todas.length >= 400) {
      const maisAntiga = Math.min(...todas.map((x) => ms(x.messageTimestamp)));
      if (maisAntiga > desdeMs) inicioGrupo = new Date(diaBR(maisAntiga + 86400000) + "T03:00:00Z").getTime();
    }
    const msgs = todas.filter((x) => ms(x.messageTimestamp) >= inicioGrupo)
      .sort((x, y) => ms(x.messageTimestamp) - ms(y.messageTimestamp));
    lidas += msgs.length;

    const dias = new Map();
    const dia = (d) => {
      if (!dias.has(d)) dias.set(d, { afiliada_id: a.id, dia: d, msgs_dela: 0, msgs_escritorio: 0, ultima_dela: null,
        comprovantes: 0, audios: 0, pedidos_peca: 0, vendas_citadas: 0, trechos: [] });
      return dias.get(d);
    };
    msgs.forEach((x, i) => {
      const quem = x.fromMe || lidsEquipe.has(lid(x.sender)) ? "escritorio"
        : lidsDela.has(lid(x.sender)) ? "dela" : "outro";
      const r = dia(diaBR(x.messageTimestamp));
      if (quem === "escritorio") { r.msgs_escritorio++; return; }
      if (quem !== "dela") return;
      r.msgs_dela++;
      r.ultima_dela = new Date(ms(x.messageTimestamp)).toISOString();
      x._quem = "dela";
    });

    for (const x of msgs.filter((y) => y._quem === "dela")) {
      const r = dia(diaBR(x.messageTimestamp));
      const tipo = x.messageType || "";
      let texto = String(x.text || x.content && x.content.caption || "").trim();
      if (/Audio/i.test(tipo)) {
        r.audios++;
        const id = x.messageid || x.id;
        if (TRANSCREVER && id && !jaTranscritos.has(id)) {
          try {
            const d = await zap("/message/download", { id, transcribe: true });
            texto = String(d.transcription || "").trim();
            if (texto) { audiosNovos.push({ id, afiliada_id: a.id, quando: new Date(ms(x.messageTimestamp)).toISOString(), texto }); transcritos++; }
          } catch (e) { falhasAudio++; }
          jaTranscritos.add(id);
        }
      }
      const perto = msgs.filter((y) => y._quem === "dela" && Math.abs(ms(y.messageTimestamp) - ms(x.messageTimestamp)) < 10 * 60000)
        .map((y) => String(y.text || "")).join(" ");
      const marcas = [];
      if (/Image|Document/i.test(tipo) && (R_COMPROVANTE.test(texto) || R_COMPROVANTE.test(perto))) { r.comprovantes++; marcas.push("comprovante"); }
      else if (/Document/i.test(tipo) && /pdf/i.test(String(x.content && x.content.mimetype || ""))) { r.comprovantes++; marcas.push("comprovante"); }
      if (texto && R_PEDIDO.test(texto)) { r.pedidos_peca++; marcas.push("pedido"); }
      if (texto && R_VENDA.test(texto)) { r.vendas_citadas++; marcas.push("venda"); }
      if (marcas.length && r.trechos.length < 10) {
        r.trechos.push({ quando: new Date(ms(x.messageTimestamp)).toISOString(), tipo: marcas.join(","),
          audio: /Audio/i.test(tipo), texto: (texto || "[imagem]").slice(0, 220) });
      }
    }
    // Dia sem nenhuma mensagem também vira linha: é o silêncio que o painel mede.
    for (let k = 0; k < DIAS; k++) {
      const d = desdeMs + k * 86400000;
      if (d >= inicioGrupo) dia(new Date(d).toISOString().slice(0, 10));
    }
    if (DEBUG) [...dias.values()].forEach((r) => r.trechos.forEach((tr) => console.log("  [" + tr.tipo + "] " + a.nome.split(" ")[0] + ": " + tr.texto.slice(0, 90).replace(/\s+/g, " "))));
    resumos.push(...dias.values());
  }

  // Áudio antigo de ontem já transcrito: repõe o texto nos trechos do dia.
  await gravar("POST", "/whatsapp_audios?on_conflict=id", audiosNovos, "resolution=ignore-duplicates,return=minimal").catch((e) => console.log("Aviso áudios: " + e.message.slice(0, 80)));
  for (let i = 0; i < resumos.length; i += 500) {
    await gravar("POST", "/contato_whatsapp?on_conflict=afiliada_id,dia", resumos.slice(i, i + 500), "resolution=merge-duplicates,return=minimal");
  }
  const soma = (k) => resumos.reduce((s, r) => s + r[k], 0);
  console.log("Mensagens lidas: " + lidas + " | dela: " + soma("msgs_dela") + " | escritório: " + soma("msgs_escritorio")
    + " | áudios dela: " + soma("audios") + " (transcritos agora: " + transcritos + ", falhas: " + falhasAudio + ")");
  console.log("Marcas: comprovantes " + soma("comprovantes") + " | pedidos de peça " + soma("pedidos_peca") + " | vendas citadas " + soma("vendas_citadas"));
  const semGrupoComMaleta = afs.filter((a) => !a._grupo && comMaleta.has(a.id)).length;
  console.log("Com maleta e sem grupo encontrado: " + semGrupoComMaleta);

  if (!DRY) {
    try {
      await gravar("POST", "/robo_estado?on_conflict=robo", [{ robo: "whatsapp", quando: new Date().toISOString(),
        resumo: (ligadasTel + ligadasNome) + " grupos lidos, " + soma("msgs_dela") + " mensagens delas" }],
        "resolution=merge-duplicates,return=minimal");
    } catch (e) { /* não derruba */ }
  }
  console.log((DRY ? "SIMULAÇÃO, nada gravado. " : "OK. ") + Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("ERRO: " + e.message); process.exit(1); });
