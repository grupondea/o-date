/* ============================================================
   O DATE — Worker "o-date-ai"
   Gera as respostas do app "Responda o Stories" direto no site,
   sem precisar sair pra outro lugar. Este Worker é o único lugar
   que conhece a chave da API do Gemini (secret GEMINI_API_KEY)
   — o navegador da pessoa nunca vê essa chave.

   Usa a API do Google Gemini (gemini-3.5-flash, com fallback pra
   gemini-3.1-flash-lite se o principal estiver sobrecarregado) porque
   tem cota gratuita real pra visão (imagem + texto), sem precisar de
   cartão de crédito nem billing ativado.

   Deploy: dash.cloudflare.com → Workers & Pages → o-date-ai →
   conectado ao repositório do GitHub, builda sozinho a cada push.
   Depois: Settings → Variables and secrets → adicionar o secret
   GEMINI_API_KEY com uma chave gerada de graça em
   aistudio.google.com/app/apikey (clique em "Create API key",
   não precisa cartão nem verificação de pagamento).

   A imagem enviada por quem usa o app passa só por aqui, de forma
   temporária, só pra ir pra API do Gemini e voltar com a resposta
   — este Worker não salva nem loga a imagem em lugar nenhum.
============================================================ */

const ALLOWED_ORIGINS = [
  'https://grupondea.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

// tenta o modelo principal primeiro (melhor qualidade) e, só se ele estiver
// mesmo indisponível (sobrecarga do lado do Google), cai pro flash-lite —
// que tem cota diária própria e separada, então continua funcionando mesmo
// quando o principal está em pico de demanda.
const MODELOS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
function geminiUrl(modelo){
  return 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent';
}

const SITUACOES = {
  'conversa-parada': {
    label: 'Conversa parada',
    instrucao: 'A conversa do print travou ou tomou vácuo. Escreva mensagens que reabrem o papo com naturalidade, sem parecer desesperado nem carente, puxando algo real que apareceu no print (última mensagem, assunto, piada em aberto).'
  },
  'story-do-crush': {
    label: 'Story do crush',
    instrucao: 'O print é um story que a pessoa postou. Escreva aberturas de conversa comentando algo específico e observável do story (não invente detalhe que não está visível), nada de "oi sumida" ou coisa genérica que serviria pra qualquer story.'
  },
  'cantada-na-medida': {
    label: 'Cantada na medida',
    instrucao: 'O print é uma foto ou perfil de alguém que a pessoa está afim de puxar assunto pela primeira vez ou paquerar. Escreva cantadas leves e aberturas de conversa que reagem a algo concreto da imagem, com charme, sem ser vulgar nem forçado.'
  }
};

function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function jsonResponse(data, status, origin){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function buildPrompt(situacaoKey, contexto){
  const situacao = SITUACOES[situacaoKey] || SITUACOES['conversa-parada'];

  const lines = [
    'Você está ajudando alguém a responder uma conversa, print ou story, com base numa imagem anexada.',
    '',
    'Situação: ' + situacao.label + '. ' + situacao.instrucao,
    '',
    'Regras de escrita (aplicar em toda mensagem gerada):',
    '1. Escreva como gente escreve pra gente, nunca como manual corporativo ou robô.',
    '2. Reaja a algo específico e observável no print, nunca uma mensagem genérica que serviria pra qualquer conversa.',
    '3. Nunca use hífen nem travessão, nem os caracteres -, –, —, ‑, em lugar nenhum do texto. Separe ideias com vírgula, dois pontos, ponto final ou quebra de linha.',
    '4. Sem clichê de abertura tipo "e aí" sozinho ou "oi, tudo bem?" vazio. Sem frase bonita e vazia, sem exagero.',
    '5. No máximo 1 emoji por mensagem, ou zero.',
    '6. Nunca vulgar, nunca invasivo, sempre respeitando quem vai receber a mensagem.'
  ];

  if (contexto){
    lines.push('', 'Contexto extra que a pessoa passou: ' + contexto);
  }

  lines.push(
    '',
    'Tarefa: olhando pra imagem anexada, escreva no mínimo 7 opções de mensagem diferentes entre si, variando do mais leve/descontraído ao mais direto/confiante, pra pessoa escolher qual mandar. Cada opção deve ter de 1 a 3 frases.',
    '',
    'Responda SOMENTE com um array JSON de strings, sem markdown, sem crases, sem explicação antes ou depois. Formato exato: ["primeira opção", "segunda opção", "terceira opção", ...]'
  );

  return lines.join('\n');
}

function extractJsonArray(text){
  // tira eventuais crases de bloco markdown (```json ... ```) antes de parsear
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  function tentaParsear(str){
    const parsed = JSON.parse(str);
    if (!Array.isArray(parsed)) throw new Error('resposta não é um array');
    return parsed.filter(function(item){ return typeof item === 'string' && item.trim().length > 0; });
  }

  try {
    return tentaParsear(cleaned);
  } catch (e) {
    // a IA às vezes escreve uma frase antes ou depois do array. Acha o
    // primeiro '[' e o último ']' do texto e tenta parsear só esse trecho.
    const inicio = cleaned.indexOf('[');
    const fim = cleaned.lastIndexOf(']');
    if (inicio !== -1 && fim !== -1 && fim > inicio){
      try {
        return tentaParsear(cleaned.slice(inicio, fim + 1));
      } catch (e2){
        // segue pro último fallback abaixo
      }
    }

    // último recurso: a resposta pode ter sido cortada no meio (limite de
    // tokens) antes de fechar o array. Em vez de desistir, recupera todas as
    // strings JSON completas que existirem no texto, mesmo sem o array
    // estar fechado direito.
    if (inicio !== -1){
      const trecho = cleaned.slice(inicio);
      const pedacos = trecho.match(/"(?:[^"\\]|\\.)*"/g) || [];
      const opcoes = [];
      for (const pedaco of pedacos){
        try {
          const valor = JSON.parse(pedaco);
          if (typeof valor === 'string' && valor.trim().length > 0) opcoes.push(valor);
        } catch (e3){ /* ignora trecho malformado e segue */ }
      }
      if (opcoes.length > 0) return opcoes;
    }

    throw e;
  }
}

async function handleGenerate(request, env, origin){
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Corpo da requisição não é um JSON válido.' }, 400, origin);
  }

  const imageBase64 = body.imageBase64;
  const mimeType = body.mimeType || 'image/png';
  const situacao = body.situacao;
  const contexto = (body.contexto || '').toString().slice(0, 600);

  if (!imageBase64 || typeof imageBase64 !== 'string'){
    return jsonResponse({ error: 'Nenhuma imagem recebida.' }, 400, origin);
  }
  if (!SITUACOES[situacao]){
    return jsonResponse({ error: 'Situação inválida.' }, 400, origin);
  }
  // limite generoso pra evitar abuso (base64 de ~6MB de imagem original)
  if (imageBase64.length > 8_000_000){
    return jsonResponse({ error: 'Imagem grande demais. Tenta uma captura de tela menor.' }, 400, origin);
  }

  const apiKey = (env.GEMINI_API_KEY || '').trim();
  if (!apiKey){
    return jsonResponse({ error: 'A chave da IA ainda não foi configurada neste Worker (GEMINI_API_KEY).' }, 500, origin);
  }

  const promptText = buildPrompt(situacao, contexto);

  const geminiPayload = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: promptText }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: 3000,
      temperature: 0.9,
      responseMimeType: 'application/json'
    }
  };

  // o modelo gratuito às vezes devolve 503 (sobrecarga temporária do lado do
  // Google). Tenta de novo sozinho, com espera crescente, e se o modelo
  // principal continuar indisponível depois de todas as tentativas, cai pro
  // próximo modelo da lista antes de desistir de vez.
  const MAX_TENTATIVAS = 3;
  let geminiRes;
  let ultimoErroTexto = '';
  let ultimoErroStatus = 0;

  modelos_loop:
  for (const modelo of MODELOS){
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++){
      try {
        geminiRes = await fetch(geminiUrl(modelo), {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify(geminiPayload)
        });
      } catch (e) {
        console.error('Falha no fetch pro Gemini (' + modelo + ', tentativa ' + tentativa + '):', e && e.stack ? e.stack : (e && e.message ? e.message : String(e)));
        geminiRes = null;
      }

      if (geminiRes && geminiRes.ok){
        break modelos_loop;
      }

      if (geminiRes){
        ultimoErroTexto = await geminiRes.text().catch(function(){ return ''; });
        ultimoErroStatus = geminiRes.status;
        console.error('Gemini recusou (' + modelo + ', tentativa ' + tentativa + ', status ' + geminiRes.status + '):', ultimoErroTexto.slice(0, 300));
        // só vale a pena tentar de novo (ou trocar de modelo) em erro de
        // sobrecarga/instabilidade — erro de verdade (ex: pedido inválido)
        // devolve na hora, sem ficar tentando à toa.
        const vale_retry = geminiRes.status === 503 || geminiRes.status === 429 || geminiRes.status >= 500;
        if (!vale_retry){
          return jsonResponse({ error: 'A API da IA recusou a requisição (status ' + geminiRes.status + ').', detail: ultimoErroTexto.slice(0, 300) }, 502, origin);
        }
      }

      const ultimaTentativaDesteModelo = tentativa === MAX_TENTATIVAS;
      if (!ultimaTentativaDesteModelo){
        // espera crescendo entre tentativas: 800ms, depois 1600ms
        await new Promise(function(resolve){ setTimeout(resolve, 800 * tentativa); });
      }
    }
    // esgotou as tentativas deste modelo — segue pro próximo da lista (se houver)
  }

  if (!geminiRes || !geminiRes.ok){
    const status = ultimoErroStatus || 502;
    return jsonResponse({ error: 'A API da IA está com muita demanda agora (status ' + status + '). Tenta de novo em instantes.', detail: ultimoErroTexto.slice(0, 300) }, 502, origin);
  }

  const geminiJson = await geminiRes.json();
  const candidate = (geminiJson.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts ? candidate.content.parts : [];
  const textPart = parts.find(function(p){ return typeof p.text === 'string' && p.text.trim().length > 0; });

  if (!textPart){
    return jsonResponse({ error: 'A IA não devolveu texto nenhum.' }, 502, origin);
  }

  let replies;
  try {
    replies = extractJsonArray(textPart.text);
  } catch (e) {
    console.error('Não consegui interpretar a resposta da IA. finishReason:', candidate && candidate.finishReason, '| Texto bruto:', textPart.text.slice(0, 1000));
    return jsonResponse({ error: 'Não consegui interpretar a resposta da IA. Tenta de novo.' }, 502, origin);
  }

  if (replies.length < 3){
    return jsonResponse({ error: 'A IA devolveu poucas opções. Tenta de novo.' }, 502, origin);
  }

  return jsonResponse({ replies: replies }, 200, origin);
}

export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/generate-replies'){
      return handleGenerate(request, env, origin);
    }

    return jsonResponse({ error: 'Rota não encontrada.' }, 404, origin);
  }
};
