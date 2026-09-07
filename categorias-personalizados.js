// AS CATEGORIAS DO PERSONALIZADO
//
// Uma lista de 276 modelos não se procura, se desiste. A Ducena, que é a maior
// do Brasil nisso, classifica por PRA QUEM É e não por o que a peça é: Mães,
// Vovó, Papai, Infantil, Mãe de Pet. Ninguém acorda querendo "um colar com
// fotogravação"; acorda querendo um presente pra mãe. A categoria tem que ser
// a frase que a cliente fala.
//
// Este arquivo é a fonte única das regras. Quem usa:
//   - fotos.js, pra classificar modelo novo assim que a foto entra no Drive
//   - classificar-modelos.js, pra passar de uma vez nos que já existem
// A Carina corrige na tela de gestão o que a regra errar, e a correção dela
// NUNCA é desfeita pelo robô: modelo que já tem categoria não é reclassificado.

const CATEGORIAS = [
  { id: "nome",      rotulo: "Nome e inicial" },
  { id: "filhos",    rotulo: "Mães e filhos" },
  { id: "foto",      rotulo: "Com foto" },
  { id: "frase",     rotulo: "Frases" },
  { id: "profissao", rotulo: "Profissão" },
  { id: "fe",        rotulo: "Fé" },
  { id: "pet",       rotulo: "Pet" },
  { id: "paixao",    rotulo: "Paixões" },
  { id: "data",      rotulo: "Datas" },
  { id: "masculino", rotulo: "Masculino" },
  { id: "autismo", rotulo: "Autismo" },
];

// Sem acento e em maiúscula, pra regra não depender de como foi digitado.
function limpo(t) {
  return String(t || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const REGRAS = [
  ["nome",      /\bNOME|LETRA|INICIAL|MONOGRAM|PLAQUINHA|GRAVAD|ALFABET|\bABC\b/],
  ["filhos",    /FILH|CANGA|CRIANC|MENIN[OA]|BEBE|NASCIMENT|ARVORE|\bMAE\b|MAMAE|MATERN|\bVO\b|VOV[OA]|\bNET[OA]|INFANTIL|COLO DE MAE/],
  ["foto",      /FOTOGRAVA|\bFOTO|RELICARIO|RETRATO/],
  ["frase",     /FRASE|MANDALA|SEJA FORTE|CORAJOSA|GRATIDAO|VERSICULO|ORE ESPERE/],
  ["profissao", /ENFERMAG|ODONTO|PSICOLOG|NUTRI|ESTETIC|ADMINISTRA|CABELEIREIR|NAIL|SOBRANCELH|MEDICIN|DIREITO|VETERIN|PEDAGOG|FISIOTERAP|FARMAC|ARQUITET|CONTAB|BIOMED|FONO|JALECO|MANICURE|BOTON|LOGOMARCA|PROFISSAO|DESIGNER|ESTETOSCOPIO|ESMALTE|SECADOR|TESOURA/],
  // ORACAO precisa de borda: sem ela casa dentro de CORACAO, e coração é a
  // palavra mais comum do catálogo inteiro. Custou 37 peças no primeiro teste.
  ["fe",        /NOSSA SENHORA|\bSANT[OA]\b|\bCRUZ|CRISTO|\bANJO|\bTERCO\b|ESCAPULARIO|SAGRAD|JESUS|ESPIRITO SANTO|SAO BENTO|SAO JORGE|MEDALHA|\bORACAO\b|PAI NOSSO|OLHO GREGO|\bFE\b/],
  ["pet",       /\bPET\b|CACHORR|\bGATO|PATINH|MIAU|AUAU/],
  // Paixões: o que a pessoa gosta, e não quem ela ama. A Ducena não tem isso,
  // mas o catálogo da casa tem: time, música, esporte, hobby, bandeira.
  ["paixao",    /\bTIME\b|FUTEBOL|VOLEI|BASQUETE|BICICLET|CORRIDA|\bBTS\b|COREIA|BANDEIRA|MAQUINA COSTURA|CHOPP|CERVEJ|MUSICA|VIOLAO|CAVALO|SURF|\bPRAIA|BORBOLETA|GIRASSOL|\bESTRELA|COROA|FLECHA/],
  ["data",      /\bDATA\b|\bDADOS\b|COORDENAD|\bMAPA\b|ROMANO|ANIVERSARI|CASAMENTO/],
  ["masculino", /MASCULIN|\bPAI\b|PAPAI|CAVALHEIR/],
  ["autismo",   /AUTIS/],
];

// Devolve as categorias de um modelo. Pode ser mais de uma, de propósito.
function classificar(descricao) {
  const t = limpo(descricao);
  const achadas = REGRAS.filter(([, re]) => re.test(t)).map(([id]) => id);
  // Se nada bater, fica sem categoria e aparece na aba "Todos". Melhor sem
  // categoria do que na categoria errada: peca no lugar errado a afiliada
  // nao acha nem procurando, e ainda perde a confianca nas abas.
  return [...new Set(achadas)];
}

module.exports = { CATEGORIAS, REGRAS, classificar, limpo };
