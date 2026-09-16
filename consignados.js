// ROBÔ DOS CONSIGNADOS · Terasoft -> Supabase, toda madrugada
//
// Pedido da Carina em 14/09/2026: um painel pra ela e a Iza abrirem de manhã
// e saber quem abordar, com a inadimplência escancarada; e a Minha Maleta
// aberta pra toda afiliada que tem peça na mão. Fontes: só Terasoft e
// WhatsApp. A planilha financeira NÃO entra (confunde).
//
// O que faz:
//  1. Traz os consignados dos últimos 400 dias (1 consulta; o aberto mais
//     antigo em 14/09 era de 25/03/2026).
//  2. Grava o espelho em `consignados` e as peças dos abertos em
//     `consignado_itens`. NUNCA mexe nos campos que as pessoas preenchem:
//     data_recebimento, cobranca, cobranca_nota, cobranca_por, cobranca_em.
//  3. Quem tem consignado aberto e não está no cadastro ganha cadastro
//     (nome e cidade da Terasoft, PIN sorteado, sem WhatsApp).
//  4. Toda afiliada com consignado aberto ganha maleta, com as peças dos
//     consignados abertos dela. Peça nova entra; nada é apagado.
//
// Fica de fora: AURORA (outra empresa, marca da Iza). CARINA DIRETO (000000)
// é gravado sem afiliada: é o estoque cíclico, pré-maleta montada pela Cássia,
// e aparece no painel numa linha própria, nunca em cobrança.
//
// O REPOSITÓRIO É PÚBLICO e o log das Actions também: aqui só se imprime
// contagem. Nunca nome de afiliada, valor ou número de consignado.

const https = require("https");
const crypto = require("crypto");

const SB = "https://dqljtdznecqzninwvtsj.supabase.co/rest/v1";
const SVC = process.env.SUPABASE_SERVICE_KEY;
const TERA = process.env.TERASOFT_AUTH;
const DRY = process.env.DRY === "1";
const DIAS = parseInt(process.env.DIAS || "400", 10);

if (!SVC) { console.error("Faltou SUPABASE_SERVICE_KEY"); process.exit(1); }
if (!TERA) { console.error("Faltou TERASOFT_AUTH"); process.exit(1); }

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
    method: metodo,
    headers: { ...cab, Prefer: prefer || "return=minimal" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error("Supabase " + metodo + " " + caminho.split("?")[0] + ": " + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
async function emLotes(lista, tam, fn) {
  for (let i = 0; i < lista.length; i += tam) await fn(lista.slice(i, i + tam));
}

// Certificado próprio da Terasoft: precisa do https com rejectUnauthorized:false.
function terasoft(ini, fim, ep) {
  const caminho = "/consulta?ep=" + (ep || "consignado") + "&data_inicial=" + encodeURIComponent(ini)
    + "&data_final=" + encodeURIComponent(fim);
  return new Promise((ok, falha) => {
    const req = https.request({
      hostname: "apiserver.ip.inf.br", port: 12067, path: caminho, method: "GET",
      headers: { Authorization: "Basic " + Buffer.from(TERA).toString("base64") },
      rejectUnauthorized: false, timeout: 300000,
    }, (res) => {
      let txt = "";
      res.on("data", (d) => (txt += d));
      res.on("end", () => {
        let j;
        try { j = JSON.parse(txt); } catch (e) { return falha(new Error("resposta ilegível da Terasoft")); }
        // Limite de consultas estourado vem como objeto, não lista. Sem este
        // grito o robô "funcionaria" sem trazer nada.
        if (!Array.isArray(j)) return falha(new Error("Terasoft recusou: " + JSON.stringify(j).slice(0, 200)));
        ok(j);
      });
    });
    req.on("timeout", () => { req.destroy(); falha(new Error("Terasoft demorou demais")); });
    req.on("error", falha);
    req.end();
  });
}

const p2 = (n) => String(n).padStart(2, "0");
const ddmmaaaa = (d) => p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + "/" + d.getFullYear();
const limpar = (s) => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const titulo = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim()
  .replace(/(^|\s)(\S)/g, (m, e, c) => e + c.toUpperCase())
  .replace(/\s(De|Da|Do|Dos|Das|E)\s/g, (m) => m.toLowerCase());

// A Terasoft grava cidade sem acento ("MARINGA", "MGA", "SP"). Na vitrine e na
// arte da afiliada aparece "Afiliada em Maringá", então corrige aqui.
// Lista feita com as cidades do cadastro em 15/09/2026; cidade nova sem acento
// entra como veio e é só acrescentar.
const CIDADES = {
  "Angulo": "Ângulo", "Campo Mourao": "Campo Mourão", "Corbelia": "Corbélia", "Ivaipora": "Ivaiporã",
  "Jaguapita": "Jaguapitã", "Kalore": "Kaloré", "Lidianopolis": "Lidianópolis", "Lilian Jd Alegre": "Jardim Alegre",
  "Mandaguacu": "Mandaguaçu", "Maringa": "Maringá", "Mga": "Maringá", "Ribeirao Preto": "Ribeirão Preto",
  "Sao Paulo": "São Paulo", "Sp": "São Paulo", "Paicandu": "Paiçandu", "Iguaracu": "Iguaraçu",
  "Engenheiro Beltrao": "Engenheiro Beltrão", "Jd Alegre": "Jardim Alegre",
};
const cidadeCerta = (c) => (c ? (CIDADES[c] || c) : null);

const ESTOQUE_CICLICO = "000000";   // CARINA DIRETO
// Vendedoras de Aurora Muniz, Mimece e Altezza (outras empresas na mesma
// Terasoft) não são afiliadas. As PEÇAS da Mimece são coleção da Carina Melo
// desde 15/09/2026 e entram normalmente nas maletas.
const FORA = /AURORA|MIMECE|ALTEZZA/i;

(async () => {
  const t0 = Date.now();
  const hoje = new Date();
  const bruto = await terasoft(ddmmaaaa(new Date(hoje.getTime() - DIAS * 86400000)), ddmmaaaa(hoje));
  console.log("Linhas da Terasoft: " + bruto.length);

  const outraEmpresa = new Set();

  // ---- 1. agrupa por consignado
  const cons = new Map();
  for (const x of bruto) {
    if (!x.NOME_VENDEDOR || !x.NUMERO_CONSIGNADO) continue;
    // Consignado de outra empresa: não entra, mas fica anotado. Se ele já estava
    // no espelho no nome de uma afiliada (vendedora corrigida depois na
    // Terasoft), sai do painel e da maleta dela logo abaixo.
    if (FORA.test(x.NOME_VENDEDOR)) { outraEmpresa.add(x.NUMERO_CONSIGNADO); continue; }
    let c = cons.get(x.NUMERO_CONSIGNADO);
    if (!c) {
      c = {
        numero: x.NUMERO_CONSIGNADO, codigo_vendedor: x.CODIGO_VENDEDOR, vendedor: x.NOME_VENDEDOR,
        clientes: new Map(), data_saida: x.DATA_SAIDA, situacao: x.SITUACAO,
        valor_total: x.VALOR_TOTAL, pendente: 0, pendenteNulo: true, pecas: 0, itens: new Map(),
      };
      cons.set(x.NUMERO_CONSIGNADO, c);
    }
    if (x.SITUACAO !== "ABERTO") c.situacao = x.SITUACAO;
    c.clientes.set(x.NOME_CLIENTE, (c.clientes.get(x.NOME_CLIENTE) || 0) + 1);
    c.pecas += x.QUANTIDADE || 0;
    if (x.VALOR_PENDENTE !== null && x.VALOR_PENDENTE !== undefined) { c.pendente += x.VALOR_PENDENTE; c.pendenteNulo = false; }
    const cod = parseInt(x.CODIGO_PRODUTO, 10);
    if (Number.isFinite(cod)) {
      const it = c.itens.get(cod) || { codigo: cod, quantidade: 0, valor_item: x.VALOR_ITEM, pendente: null };
      it.quantidade += x.QUANTIDADE || 0;
      if (x.VALOR_PENDENTE !== null && x.VALOR_PENDENTE !== undefined) it.pendente = (it.pendente || 0) + x.VALOR_PENDENTE;
      c.itens.set(cod, it);
    }
  }
  // REDE DE SEGURANÇA PELA MARCA DAS PEÇAS (15/09/2026). O 004676 saiu no
  // nome da Isabela Sartori Parro com 50 peças da AURORA e o robô deixou
  // passar, porque só olhava o nome da vendedora. Consignado de afiliada com
  // metade ou mais das peças de Aurora ou Altezza é tratado como de outra
  // empresa. A Mimece NÃO entra nessa conta: desde 15/09/2026 é coleção da
  // Carina Melo e pode encher uma maleta.
  try {
    const codsAbertos = [...new Set([...cons.values()].filter((c) => c.situacao === "ABERTO" && c.codigo_vendedor !== ESTOQUE_CICLICO)
      .flatMap((c) => [...c.itens.keys()]))];
    const marcaDe = new Map();
    await emLotes(codsAbertos, 300, async (l) => {
      (await ler("/produtos?codigo=in.(" + l.join(",") + ")&select=codigo,marca")).forEach((p) => marcaDe.set(Number(p.codigo), p.marca || ""));
    });
    for (const c of cons.values()) {
      if (c.situacao !== "ABERTO" || c.codigo_vendedor === ESTOQUE_CICLICO) continue;
      let fora = 0, total = 0;
      c.itens.forEach((it, cod) => { total += it.quantidade; if (/AURORA|ALTEZZA/i.test(marcaDe.get(cod) || "")) fora += it.quantidade; });
      if (total && fora / total >= 0.5) { outraEmpresa.add(c.numero); cons.delete(c.numero); }
    }
  } catch (e) { console.log("Aviso marca: " + String(e.message).slice(0, 80)); }

  const todos = [...cons.values()];
  const abertos = todos.filter((c) => c.situacao === "ABERTO");
  console.log("Consignados: " + todos.length + " | abertos: " + abertos.length
    + " | estoque cíclico aberto: " + abertos.filter((c) => c.codigo_vendedor === ESTOQUE_CICLICO).length);

  // ---- 2. cadastro: quem tem peça na mão e ainda não está nele
  const afs = await ler("/afiliadas?select=id,slug,nome,cidade,whatsapp,pin,codigo_terasoft,tipo,ativa");
  const porCodigo = new Map(afs.filter((a) => a.codigo_terasoft).map((a) => [a.codigo_terasoft, a]));
  const slugs = new Set(afs.map((a) => a.slug));
  const novas = new Map();
  for (const c of abertos) {
    if (c.codigo_vendedor === ESTOQUE_CICLICO || porCodigo.has(c.codigo_vendedor) || novas.has(c.codigo_vendedor)) continue;
    const [nomeV, ...resto] = c.vendedor.split(" - ");
    // "ANDRESSA - SARANDI" não diz o nome inteiro; aí vale o cliente mais frequente.
    const cliente = [...c.clientes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const nome = limpar(nomeV).split(" ").length >= 2 ? nomeV : cliente;
    const partes = limpar(nome).toLowerCase().split(" ").filter((w) => w.length > 2);
    let slug = partes.slice(0, 1).join("-"), i = 1;
    while (slugs.has(slug)) slug = partes.slice(0, ++i).join("-") || slug + "-" + i;
    slugs.add(slug);
    novas.set(c.codigo_vendedor, {
      slug, nome: titulo(nome), cidade: cidadeCerta(titulo(resto.join(" - "))),
      pin: String(crypto.randomInt(1000, 10000)), codigo_terasoft: c.codigo_vendedor, tipo: "afiliada", ativa: true,
    });
  }
  if (novas.size) {
    const criadas = await gravar("POST", "/afiliadas", [...novas.values()], "return=representation");
    (DRY ? [...novas.values()].map((a, k) => ({ ...a, id: -1 - k })) : criadas).forEach((a) => porCodigo.set(a.codigo_terasoft, a));
  }
  console.log("Cadastro: " + porCodigo.size + " ligadas à Terasoft | novas agora: " + novas.size);

  // ---- 3. espelho dos consignados (só colunas do robô: merge não apaga o que a Iza preencheu)
  // O espelho guarda os abertos e os últimos 120 dias. MAS o que o espelho ainda
  // tem como aberto entra sempre, mesmo antigo: senão, quando a Iza finaliza um
  // consignado velho (003696 da Adrielly, de 25/03, finalizado em 15/09), a
  // conclusão nunca chega e ele fica "aberto" no painel pra sempre.
  const abertosNoEspelho = new Set((await ler("/consignados?situacao=eq.ABERTO&select=numero")).map((x) => x.numero));
  const guardar = todos.filter((c) => c.situacao === "ABERTO" || abertosNoEspelho.has(c.numero)
    || c.data_saida >= new Date(hoje.getTime() - 120 * 86400000).toISOString().slice(0, 10));
  // TRANSFERÊNCIA, PEÇA POR PEÇA (refeito em 15/09/2026).
  // Peça que a afiliada segura pro mês seguinte sai de novo num consignado com
  // data nova, e a data faz a peça parecer nova. Foi assim que a Amabile
  // acumulou R$ 12 mil em 8 meses. Regra dura da Carina: 60 dias do
  // recebimento da PEÇA, e transferência nunca zera o relógio.
  // A primeira versão só via transferência pequena (até 8 peças, todas da
  // maleta anterior). A Iza mostrou que tem afiliada que transfere 20 a 30
  // peças (Flaviana) e consignado que mistura transferidas e novas (Lucilene,
  // 004624: 9 de 12 vieram da maleta de 23/07). Agora cada semijoia aberta é
  // seguida pra trás: se ela estava num consignado anterior da MESMA afiliada,
  // já baixado, até 60 dias antes, é a mesma peça continuando. A origem é o
  // começo dessa corrente.
  // A Terasoft só guarda uma data por consignado, por isso a Iza deve criar
  // consignado separado a cada entrega (peça somada num consignado antigo
  // herdaria a data antiga).
  const porVendedor = new Map();
  for (const c of todos) {
    if (!porVendedor.has(c.codigo_vendedor)) porVendedor.set(c.codigo_vendedor, []);
    porVendedor.get(c.codigo_vendedor).push(c);
  }
  porVendedor.forEach((l) => l.sort((x, y) => y.data_saida.localeCompare(x.data_saida) || y.numero.localeCompare(x.numero)));
  const dif = (a, b) => (new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 86400000;
  let pecasTransf = 0;
  for (const c of abertos) {
    if (c.codigo_vendedor === ESTOQUE_CICLICO) continue;
    const lista = porVendedor.get(c.codigo_vendedor);
    const origens = new Set();
    c.itens.forEach((it, cod) => {
      let atual = c, origem = null;
      for (let passo = 0; passo < 12; passo++) {
        const prev = lista.find((p) => p.numero !== atual.numero && p.data_saida <= atual.data_saida
          && p.numero < atual.numero && p.itens.has(cod)
          && (p.situacao !== "ABERTO" || Number(p.itens.get(cod).pendente || 0) === 0));
        if (!prev || dif(atual.data_saida, prev.data_saida) > 60) break;
        origem = prev; atual = prev;
      }
      if (origem) { it.origem_numero = origem.numero; it.origem_saida = origem.data_saida; pecasTransf += it.quantidade; origens.add(origem.numero); }
      else { it.origem_numero = null; it.origem_saida = null; }
    });
    // No consignado fica a origem só quando TODAS as peças vieram da mesma maleta.
    if (origens.size === 1 && [...c.itens.values()].every((it) => it.origem_numero)) c.origem = todos.find((x) => x.numero === [...origens][0]);
  }
  console.log("Semijoias abertas que vieram de maleta anterior: " + pecasTransf);

  const linhas = guardar.map((c) => ({
    numero: c.numero, codigo_vendedor: c.codigo_vendedor,
    afiliada_id: (porCodigo.get(c.codigo_vendedor) || {}).id || null,
    data_saida: c.data_saida, situacao: c.situacao,
    valor_total: c.valor_total, valor_pendente: c.pendenteNulo ? null : c.pendente,
    pecas: c.pecas, atualizado_em: new Date().toISOString(),
    origem_numero: c.origem ? c.origem.numero : null,
    origem_saida: c.origem ? c.origem.data_saida : null,
  }));
  console.log("Transferências abertas (peça segurada pro mês seguinte): " + abertos.filter((c) => c.origem).length);
  await emLotes(linhas, 500, (l) => gravar("POST", "/consignados?on_conflict=numero", l, "resolution=merge-duplicates,return=minimal"));

  // Aberto no espelho que a Terasoft já não devolve como aberto: atualiza a situação.
  const noEspelho = await ler("/consignados?situacao=eq.ABERTO&select=numero");
  const aindaAbertos = new Set(abertos.map((c) => c.numero));
  const fecharam = noEspelho.map((x) => x.numero).filter((n) => !aindaAbertos.has(n) && !cons.has(n));
  if (fecharam.length) console.log("Aberto no espelho e sumido da Terasoft (não mexi): " + fecharam.length);

  // Peças: só dos abertos. Reescreve as peças de cada aberto; as dos fechados saem.
  const itens = abertos.flatMap((c) => [...c.itens.values()].map((it) => ({ numero: c.numero, ...it,
    origem_numero: it.origem_numero || null, origem_saida: it.origem_saida || null })));
  if (!DRY) {
    await emLotes(guardar.map((c) => c.numero), 150, (l) =>
      gravar("DELETE", "/consignado_itens?numero=in.(" + l.map((n) => '"' + n + '"').join(",") + ")"));
    await emLotes(itens, 1000, (l) => gravar("POST", "/consignado_itens", l));
  }
  console.log("Espelho: " + linhas.length + " consignados | " + itens.length + " peças dos abertos");

  // ---- 3b. o que virou outra empresa sai do painel e da maleta da afiliada
  let limpos = 0;
  if (outraEmpresa.size && !DRY) {
    const noEspelho = await ler("/consignados?situacao=eq.ABERTO&afiliada_id=not.is.null&numero=in.("
      + [...outraEmpresa].map((n) => '"' + n + '"').join(",") + ")&select=numero,afiliada_id");
    for (const c of noEspelho) {
      const cods = (await ler("/consignado_itens?numero=eq." + encodeURIComponent(c.numero) + "&select=codigo")).map((i) => Number(i.codigo));
      const m = (await ler("/maletas?afiliada_id=eq." + c.afiliada_id + "&ativa=eq.true&select=id"))[0];
      if (m && cods.length) {
        const outros = abertos.filter((o) => (porCodigo.get(o.codigo_vendedor) || {}).id === c.afiliada_id && o.numero !== c.numero);
        const ficam = new Set(outros.flatMap((o) => [...o.itens.keys()]));
        const vendidas = new Set((await ler("/vendas?maleta_id=eq." + m.id + "&cancelada=eq.false&select=codigo")).map((v) => Number(v.codigo)));
        const tirar = cods.filter((k) => !ficam.has(k) && !vendidas.has(k));
        if (tirar.length) await gravar("DELETE", "/maleta_pecas?maleta_id=eq." + m.id + "&codigo=in.(" + tirar.join(",") + ")");
      }
      await gravar("DELETE", "/consignado_itens?numero=eq." + encodeURIComponent(c.numero));
      await gravar("PATCH", "/consignados?numero=eq." + encodeURIComponent(c.numero), { situacao: "OUTRA_EMPRESA", afiliada_id: null });
      limpos++;
    }
  }
  console.log("Outra empresa: " + outraEmpresa.size + " consignados ignorados | tirados do painel agora: " + limpos);

  // ---- 4. maletas: toda afiliada com peça na mão
  const maletas = await ler("/maletas?ativa=eq.true&select=id,slug,afiliada_id,consignado,data_recebimento");
  const maletaDa = new Map(maletas.filter((m) => m.afiliada_id).map((m) => [m.afiliada_id, m]));
  const slugsMaleta = new Set((await ler("/maletas?select=slug")).map((m) => m.slug));
  const recebimentos = await ler("/consignados?situacao=eq.ABERTO&data_recebimento=not.is.null&select=numero,data_recebimento");
  const recebidoEm = new Map(recebimentos.map((r) => [r.numero, r.data_recebimento]));

  const porAfiliada = new Map();
  for (const c of abertos) {
    const a = porCodigo.get(c.codigo_vendedor);
    if (!a || a.tipo === "interna") continue;
    if (!porAfiliada.has(a.id)) porAfiliada.set(a.id, { a, cons: [] });
    porAfiliada.get(a.id).cons.push(c);
  }

  let abertas = 0, pecasNovas = 0, atualizadas = 0;
  for (const { a, cons: dela } of porAfiliada.values()) {
    dela.sort((x, y) => y.data_saida.localeCompare(x.data_saida));
    const ultimo = dela[0];
    // O prazo da maleta conta do recebimento mais recente que a Iza já preencheu.
    const receb = dela.map((c) => recebidoEm.get(c.numero)).filter(Boolean).sort().pop() || null;
    let m = maletaDa.get(a.id);
    const dados = {
      afiliada: a.nome, cidade: a.cidade, whatsapp: a.whatsapp || null,
      consignado: ultimo.numero, data_consignado: dela[dela.length - 1].data_saida,
      data_recebimento: receb,
    };
    if (!m) {
      let slug = a.slug;
      if (slugsMaleta.has(slug)) slug = a.slug + "-" + a.id;
      slugsMaleta.add(slug);
      const nova = await gravar("POST", "/maletas", [{ ...dados, slug, pin: a.pin, afiliada_id: a.id, ativa: true }], "return=representation");
      m = DRY ? { id: null } : nova[0];
      abertas++;
    } else {
      // Não apaga data que já existe na maleta antiga (Maisa e Dayane foram montadas à mão).
      if (!receb) delete dados.data_recebimento;
      await gravar("PATCH", "/maletas?id=eq." + m.id, dados);
      atualizadas++;
    }
    const cods = new Set(dela.flatMap((c) => [...c.itens.keys()]));
    const jaTem = m.id ? new Set((await ler("/maleta_pecas?maleta_id=eq." + m.id + "&select=codigo")).map((p) => Number(p.codigo))) : new Set();
    const conferida = jaTem.size > 0;
    const entrar = [...cods].filter((k) => !jaTem.has(k));
    pecasNovas += entrar.length;
    // Peça que chega numa maleta já conferida entra como recebida (mesma regra
    // do sincronizar de 31/08). Maleta nova: ela confere quando abrir.
    if (entrar.length && m.id) {
      await emLotes(entrar, 500, (l) => gravar("POST", "/maleta_pecas", l.map((k) => ({
        maleta_id: m.id, codigo: k,
        recebida: conferida ? true : null, conferida_em: conferida ? new Date().toISOString() : null,
      }))));
    }
  }
  console.log("Maletas: " + abertas + " abertas agora | " + atualizadas + " atualizadas | " + pecasNovas + " peças entraram");

  // ---- 5. vendas (acertos) por afiliada por mês, pro "game" da Minha Maleta
  // Pedido da Carina em 15/09/2026: a afiliada vê quanto já ganhou desde que
  // entrou e sobe de nível pelas vendas PAGAS (7 semijoias no ciclo dobra a
  // chance de ela ficar). Na Terasoft, acerto = venda registrada (ep=venda).
  // Ganho = soma dos itens (preço de tabela) x comissão dela; o valor do pedido
  // pode vir com desconto e, pra Marta Gomes e Elisângela, já é o valor delas.
  // Consulta separada da de consignado (limite de 12 por hora é por consulta).
  try {
    const vendas = await terasoft(ddmmaaaa(new Date(hoje.getTime() - 1100 * 86400000)), ddmmaaaa(hoje), "venda");
    const mes = new Map();
    for (const v of vendas) {
      if (!v.NOME_VENDEDOR || FORA.test(v.NOME_VENDEDOR) || v.CODIGO_VENDEDOR === ESTOQUE_CICLICO) continue;
      if (v.SITUACAO && !/REALIZADO/i.test(v.SITUACAO)) continue;
      const k = v.CODIGO_VENDEDOR + "|" + String(v.DATA_VENDA).slice(0, 7);
      const o = mes.get(k) || { codigo_vendedor: v.CODIGO_VENDEDOR, mes: String(v.DATA_VENDA).slice(0, 7), pecas: 0, valor_itens: 0, docs: new Map() };
      o.pecas += v.QUANTIDADE || 0;
      o.valor_itens += Number(v.VALOR_TOTAL_ITEM || 0);
      o.docs.set(v.NUMERO_DOCUMENTO, Number(v.VALOR_TOTAL_PEDIDO || 0));
      mes.set(k, o);
    }
    const linhasMes = [...mes.values()].map((o) => ({
      codigo_vendedor: o.codigo_vendedor, mes: o.mes, pecas: o.pecas,
      valor_itens: Math.round(o.valor_itens * 100) / 100,
      valor_pedidos: Math.round([...o.docs.values()].reduce((a, b) => a + b, 0) * 100) / 100,
    }));
    await emLotes(linhasMes, 500, (l) => gravar("POST", "/vendas_terasoft_mes?on_conflict=codigo_vendedor,mes", l, "resolution=merge-duplicates,return=minimal"));
    console.log("Vendas da Terasoft: " + vendas.length + " linhas | " + linhasMes.length + " meses de afiliada");
  } catch (e) {
    console.log("Aviso vendas: " + String(e.message).slice(0, 120));
  }

  if (!DRY) {
    try {
      await gravar("POST", "/robo_estado?on_conflict=robo", [{
        robo: "consignados", quando: new Date().toISOString(),
        resumo: abertos.length + " consignados abertos, " + porAfiliada.size + " maletas",
      }], "resolution=merge-duplicates,return=minimal");
    } catch (e) { /* não derruba a rodada */ }
  }
  console.log((DRY ? "SIMULAÇÃO, nada gravado. " : "OK. ") + Math.round((Date.now() - t0) / 1000) + "s");
})().catch((e) => { console.error("ERRO: " + e.message); process.exit(1); });
