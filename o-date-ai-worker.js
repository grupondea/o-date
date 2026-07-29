/* ============================================================
   O DATE — Worker "o-date-ai"
   Gera as respostas do app "Responda o Stories" direto no site,
   sem precisar sair pra outro lugar. Este Worker é o único lugar
   que conhece a chave da API da Claude (secret ANTHROPIC_API_KEY)
   — o navegador da pessoa nunca vê essa chave.

   Deploy: dash.cloudflare.com → Workers & Pages → criar Worker
   novo chamado "o-date-ai" → colar este código no editor → Deploy.
   Depois: Settings → Variables and secrets → adicionar o secret
   ANTHROPIC_API_KEY com uma chave gerada em console.anthropic.com
   (precisa ter billing ativado na conta da Anthropic).

   A imagem enviada por quem usa o app passa só por aqui, de forma
   temporária, só pra ir pra API da Claude e voltar com a resposta
   — este Worker não salva nem loga a imagem em lugar nenhum.
============================================================ */

const ALLOWED_ORIGINS = [
  'https://grupondea.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1400;

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
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('resposta não é um array');
  return parsed.filter(function(item){ return typeof item === 'string' && item.trim().length > 0; });
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

  if (!env.ANTHROPIC_API_KEY){
    return jsonResponse({ error: 'A chave da IA ainda não foi configurada neste Worker (ANTHROPIC_API_KEY).' }, 500, origin);
  }

  const promptText = buildPrompt(situacao, contexto);

  const anthropicPayload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: imageBase64 }
          },
          { type: 'text', text: promptText }
        ]
      }
    ]
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(anthropicPayload)
    });
  } catch (e) {
    return jsonResponse({ error: 'Não consegui falar com a API da Claude agora. Tenta de novo em instantes.' }, 502, origin);
  }

  if (!anthropicRes.ok){
    const errText = await anthropicRes.text().catch(function(){ return ''; });
    return jsonResponse({ error: 'A API da Claude recusou a requisição (status ' + anthropicRes.status + ').', detail: errText.slice(0, 300) }, 502, origin);
  }

  const anthropicJson = await anthropicRes.json();
  const textBlock = (anthropicJson.content || []).find(function(b){ return b.type === 'text'; });
  if (!textBlock){
    return jsonResponse({ error: 'A IA não devolveu texto nenhum.' }, 502, origin);
  }

  let replies;
  try {
    replies = extractJsonArray(textBlock.text);
  } catch (e) {
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
