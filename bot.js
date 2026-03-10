const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const https = require('https');

const TOKEN        = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_KEY     = process.env.GROQ_API_KEY;
const ALLOWED_USER = process.env.TELEGRAM_USER_ID;

const bot      = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const userState = {};

// Cache de usuários autenticados (chat_id → usuario)
const _authCache = {};

async function getUsuarioByChatId(chatId) {
  const cid = String(chatId);
  // Cache por 5 minutos
  if(_authCache[cid] && (Date.now() - _authCache[cid]._ts) < 5*60*1000) {
    return _authCache[cid];
  }
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telegram_chat_id', cid)
      .eq('ativo', true)
      .single();
    if(error || !data) return null;
    _authCache[cid] = { ...data, _ts: Date.now() };
    return _authCache[cid];
  } catch(e) { return null; }
}

async function isAllowed(msg) {
  const chatId = String(msg.chat.id);
  // Admin master sempre pode (fallback de segurança)
  if(ALLOWED_USER && chatId === String(ALLOWED_USER)) return true;
  const u = await getUsuarioByChatId(chatId);
  return !!u;
}

async function isAllowedCb(cb) {
  const chatId = String(cb.message.chat.id);
  if(ALLOWED_USER && chatId === String(ALLOWED_USER)) return true;
  const u = await getUsuarioByChatId(chatId);
  return !!u;
}

// Busca do supabase filtrado pelo usuário logado
async function sbForUser(table, chatId, extraQuery='') {
  const cid = String(chatId);
  // Admin master vê tudo
  if(ALLOWED_USER && cid === String(ALLOWED_USER)) {
    const { data } = await supabase.from(table).select('*' + (extraQuery ? ','+extraQuery : '')).order('created_at', {ascending:false}).limit(50);
    return data || [];
  }
  const u = await getUsuarioByChatId(cid);
  if(!u) return [];
  if(u.nivel === 'admin') {
    const { data } = await supabase.from(table).select('*').order('created_at',{ascending:false}).limit(50);
    return data || [];
  }
  // Corretor/Gerente — APENAS os próprios clientes
  const { data } = await supabase.from(table)
    .select('*')
    .eq('corretor_id', u.id)
    .order('created_at',{ascending:false})
    .limit(50);
  return data || [];
}


function gerarId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 7);
}

const STATUS_EMOJI = {
  'Novo Lead': '🔵', 'Em Atendimento': '🟡', 'Ajustes de viabilidade': '🟠',
  'Em Proposta': '🔴', 'Negociação': '🟣', 'Venda Fechada': '🟢', 'Perdido': '⚫'
};
const STATUS_LIST = ['Novo Lead','Em Atendimento','Ajustes de viabilidade','Em Proposta','Negociação','Venda Fechada','Perdido'];

function diasSemContato(c) {
  const ref = c.last_edit || c.created_at;
  if (!ref) return 0;
  return Math.floor((Date.now() - new Date(ref).getTime()) / 86400000);
}

function fmtCliente(c) {
  const emoji = STATUS_EMOJI[c.status] || '⚪';
  const dias  = diasSemContato(c);
  let txt = `👤 *${c.nome || 'Sem nome'}* ${emoji}\n`;
  if (c.telefone)     txt += `📞 ${c.telefone}\n`;
  if (c.email)        txt += `✉️ ${c.email}\n`;
  if (c.local)        txt += `📍 ${c.local}\n`;
  if (c.imovel_atual) txt += `🏠 ${c.imovel_atual}\n`;
  if (c.status)       txt += `📊 ${c.status}\n`;
  if (c.potencial)    txt += `💪 Potencial: ${c.potencial}\n`;
  if (c.momento)      txt += `⏱ Momento: ${c.momento}\n`;
  txt += `🕐 ${dias}d sem atualizar\n`;
  if (c.obs)          txt += `💡 _${c.obs}_\n`;
  return txt;
}

function fmtImovel(im) {
  let txt = `🏠 *${im.nome || 'Sem nome'}*\n`;
  if (im.tipo)        txt += `🏷 ${im.tipo}\n`;
  if (im.bairro)      txt += `📍 ${im.bairro}\n`;
  if (im.valor)       txt += `💰 R$ ${im.valor}\n`;
  if (im.dorms)       txt += `🛏 ${im.dorms} dorms`;
  if (im.suites)      txt += ` · 🛁 ${im.suites} suítes`;
  if (im.vagas)       txt += ` · 🚗 ${im.vagas} vagas`;
  if (im.dorms || im.suites || im.vagas) txt += '\n';
  if (im.mobiliado && im.mobiliado !== 'Não informado') txt += `🪑 ${im.mobiliado}\n`;
  if (im.permuta)     txt += `🔄 Permuta: ${im.permuta}\n`;
  if (im.parcelamento) txt += `💳 Parcela: ${im.parcelamento}\n`;
  if (im.codigo)      txt += `🔑 Cód: ${im.codigo}\n`;
  if (im.obs)         txt += `💡 _${im.obs}_\n`;
  return txt;
}

// =====================
// MENU PRINCIPAL
// =====================
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['👤 Novo Cliente',    '🏠 Novo Imóvel'],
      ['📋 Listar Clientes', '🏘 Ver Imóveis'],
      ['📅 Agendar Visita',  '🗓 Próximas Visitas'],
      ['📊 Resumo do Dia',   '🔔 Lembretes'],
      ['🔍 Buscar Cliente'],
    ],
    resize_keyboard: true,
    persistent: true
  }
};

async function sendMenu(chatId, msg = '✅ Pronto! O que deseja fazer?') {
  userState[chatId] = null;
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...mainMenu });
}

// =====================
// ÁUDIO — GROQ WHISPER
// =====================
async function downloadAudio(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl  = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
  const tmpPath  = `/tmp/audio_${Date.now()}.ogg`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath);
    https.get(fileUrl, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', reject);
  });
}

async function transcribeAudio(audioPath) {
  if (!GROQ_KEY) return null;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), { filename: 'audio.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'pt');
  form.append('response_format', 'text');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) return null;
  return (await res.text()).trim();
}

async function interpretarComando(texto) {
  if (!GROQ_KEY) return null;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: `Assistente CRM imobiliário. Analise o texto e retorne APENAS JSON.
Ações: novo_cliente, novo_imovel, listar, listar_imoveis, agendar_visita, proximas_visitas, resumo, buscar (com "query"), lembretes, desconhecido.
Retorne APENAS JSON sem texto extra. Exemplos:
{"acao":"novo_cliente"}
{"acao":"buscar","query":"Ricardo"}
{"acao":"desconhecido"}`
        },
        { role: 'user', content: texto }
      ],
      max_tokens: 100, temperature: 0,
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  try { return JSON.parse(data.choices[0].message.content.trim()); } catch { return null; }
}

// =====================
// BOTÕES INLINE
// =====================
function botoesCliente(clienteId, telefone) {
  const rows = [
    [
      { text: '✏️ Editar Status',      callback_data: `st:${clienteId}` },
      { text: '📝 Registrar Contato',  callback_data: `reg:${clienteId}` },
    ],
    [
      { text: '🎯 Ver Matches',        callback_data: `match:${clienteId}` },
      { text: '📅 Agendar Visita',     callback_data: `vis:${clienteId}` },
    ],
    [
      { text: '✏️ Editar Dados',       callback_data: `edit:${clienteId}` },
      { text: '🗑 Excluir',            callback_data: `del:${clienteId}` },
    ],
  ];
  if (telefone) {
    const num = telefone.replace(/\D/g, '');
    if (num.length >= 10) rows.unshift([{ text: '💬 WhatsApp', url: `https://wa.me/55${num}` }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function botoesImovel(imovelId) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '✏️ Editar', callback_data: `imedit:${imovelId}` },
        { text: '🗑 Excluir', callback_data: `imdel:${imovelId}` },
      ]]
    }
  };
}

// =====================
// START
// =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  // Verificar se usuário está cadastrado
  const u = await getUsuarioByChatId(chatId);
  const isAdmin = ALLOWED_USER && String(chatId) === String(ALLOWED_USER);
  
  if(!u && !isAdmin) {
    // Não cadastrado — orientar
    return bot.sendMessage(chatId,
      `🏠 *Realtor Pro CRM*\n\n` +
      `⚠️ Seu Telegram ainda não está vinculado ao sistema.\n\n` +
      `*Como ativar:*\n` +
      `1️⃣ Acesse o CRM no navegador\n` +
      `2️⃣ Clique no seu nome (canto superior direito)\n` +
      `3️⃣ Vá em *Minha Conta*\n` +
      `4️⃣ Cole seu *ID do Telegram:* \`${chatId}\`\n` +
      `5️⃣ Salve e volte aqui\n\n` +
      `📋 *Seu ID do Telegram é:*\n\`${chatId}\`\n\n` +
      `_Copie esse número e cole no CRM!_`,
      { parse_mode: 'Markdown' }
    );
  }
  
  userState[chatId] = null;
  const nome = u ? u.nome.split(' ')[0] : 'João Lucas';
  await bot.sendMessage(chatId,
    `🏠 *Olá, ${nome}!*\n\nBem-vindo ao *Realtor Pro CRM*.\n\n` +
    `Use os *botões abaixo* ou 🎤 *mande áudio* — eu entendo e executo!\n\n` +
    `_Exemplos:_\n_"Novo cliente"_\n_"Listar imóveis"_\n_"Buscar Ricardo"_`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// =====================
// LISTAR CLIENTES
// =====================
async function listarClientes(chatId, pagina = 0) {
  const limit   = 8;
  const offset  = pagina * limit;
  const allData = await sbForUser('clientes', chatId);
  const total   = allData.length;
  const data    = allData.slice(offset, offset + limit);

  if (!data?.length) return sendMenu(chatId, '📋 Nenhum cliente cadastrado ainda.');

  const temProx = offset + limit < total;
  const temAnt  = pagina > 0;

  const texto = data.map((c, i) => {
    const e = STATUS_EMOJI[c.status] || '⚪';
    const d = diasSemContato(c);
    return `${offset+i+1}. *${c.nome||'—'}* ${e}\n   📞 ${c.telefone||'—'} · 📍 ${c.local||'—'} · ${d}d`;
  }).join('\n\n');

  const inline = data.map(c => ([{
    text: `👤 ${c.nome||'Sem nome'} ${STATUS_EMOJI[c.status]||''}`,
    callback_data: `ver:${c.id}`
  }]));

  const navBtns = [];
  if (temAnt)  navBtns.push({ text: '◀️ Anterior', callback_data: `pg:${pagina-1}` });
  if (temProx) navBtns.push({ text: 'Próxima ▶️',  callback_data: `pg:${pagina+1}` });
  if (navBtns.length) inline.push(navBtns);

  await bot.sendMessage(chatId,
    `📋 *Clientes* (${offset+1}–${Math.min(offset+limit, total)} de ${total}):\n\n${texto}\n\n_Toque para ver detalhes:_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inline } }
  );
}

bot.onText(/📋 Listar Clientes|\/listar/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await listarClientes(msg.chat.id, 0);
});

// =====================
// LISTAR IMÓVEIS
// =====================
async function listarImoveis(chatId) {
  const { data } = await supabase
    .from('imoveis').select('*').order('created_at', { ascending: false }).limit(12);

  if (!data?.length) return sendMenu(chatId, '🏘 Nenhum imóvel cadastrado ainda.');

  const texto = data.map((im, i) =>
    `${i+1}. *${im.nome||'—'}*\n   💰 ${im.valor||'—'} · 📍 ${im.bairro||'—'} · 🛏 ${im.dorms||'—'}`
  ).join('\n\n');

  const inline = data.map(im => ([{
    text: `🏠 ${im.nome||'Sem nome'} ${im.bairro ? '· '+im.bairro : ''}`,
    callback_data: `verim:${im.id}`
  }]));

  await bot.sendMessage(chatId,
    `🏘 *Portfólio* (${data.length} imóveis):\n\n${texto}\n\n_Toque para ver detalhes:_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inline } }
  );
}

bot.onText(/🏘 Ver Imóveis|\/imoveis/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await listarImoveis(msg.chat.id);
});

// =====================
// BUSCAR CLIENTE
// =====================
async function buscarCliente(chatId, query) {
  const allData = await sbForUser('clientes', chatId);
  const q = query.toLowerCase();
  const data = allData.filter(c => (c.nome||'').toLowerCase().includes(q)).slice(0,8);

  if (!data?.length) return sendMenu(chatId, `🔍 Nenhum cliente encontrado para "*${query}*".`);

  const inline = data.map(c => ([{
    text: `👤 ${c.nome} — ${STATUS_EMOJI[c.status]||'⚪'} ${c.status||''}`,
    callback_data: `ver:${c.id}`
  }]));

  await bot.sendMessage(chatId,
    `🔍 *"${query}"* — ${data.length} resultado(s):\n\n_Toque para ver detalhes:_`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inline } }
  );
}

bot.onText(/🔍 Buscar Cliente|\/buscar/, async (msg) => {
  if (!await isAllowed(msg)) return;
  userState[msg.chat.id] = { acao: 'buscar', step: 'query' };
  await bot.sendMessage(msg.chat.id, '🔍 *Buscar Cliente*\n\nDigite o nome:', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
  });
});

// =====================
// PRÓXIMAS VISITAS
// =====================
async function proximasVisitas(chatId) {
  const hoje = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('visitas').select('*')
    .gte('data', hoje).order('data', { ascending: true }).limit(10);

  if (!data?.length) return sendMenu(chatId, '📅 Nenhuma visita agendada.');

  const texto = data.map(v => {
    const dt  = new Date(v.data + 'T12:00:00');
    const dia = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `📅 *${dia}* — ${v.cliente_nome||'—'}\n   🏠 ${v.imovel||'—'}${v.obs?'\n   📝 '+v.obs:''}`;
  }).join('\n\n');

  await bot.sendMessage(chatId, `🗓 *Próximas Visitas:*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
}

bot.onText(/🗓 Próximas Visitas|\/visitas/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await proximasVisitas(msg.chat.id);
});

// =====================
// RESUMO DO DIA
// =====================
async function resumoDia(chatId) {
  const hoje = new Date().toISOString().split('T')[0];
  const [
    { count: total },
    { count: emProposta },
    { count: fechados },
    { count: atendimento },
    { data: visitasHoje },
    { count: totalIm },
  ] = await Promise.all([
    supabase.from('clientes').select('*', { count: 'exact', head: true }),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Em Proposta'),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Venda Fechada'),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Em Atendimento'),
    supabase.from('visitas').select('*').gte('data', hoje).lte('data', hoje + 'T23:59:59'),
    supabase.from('imoveis').select('*', { count: 'exact', head: true }),
  ]);

  const hora = new Date().getHours();
  const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  const visitasTexto = visitasHoje?.length
    ? visitasHoje.map(v => `   • ${v.cliente_nome} → ${v.imovel||'—'}`).join('\n')
    : '   Nenhuma visita hoje';

  await bot.sendMessage(chatId,
    `📊 *${saud}! Resumo — ${new Date().toLocaleDateString('pt-BR')}*\n\n` +
    `👥 Total leads: *${total||0}*\n` +
    `🟡 Em atendimento: *${atendimento||0}*\n` +
    `🔴 Em proposta: *${emProposta||0}*\n` +
    `🟢 Vendas fechadas: *${fechados||0}*\n` +
    `🏠 Imóveis no portfólio: *${totalIm||0}*\n\n` +
    `🗓 *Visitas hoje:*\n${visitasTexto}`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
}

bot.onText(/📊 Resumo do Dia|\/resumo/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await resumoDia(msg.chat.id);
});

// =====================
// CALLBACKS INLINE
// =====================
bot.on('callback_query', async (cb) => {
  if (!await isAllowedCb(cb)) return;
  const chatId = cb.message.chat.id;
  const msgId  = cb.message.message_id;
  const data   = cb.data;

  await bot.answerCallbackQuery(cb.id);

  // Paginação
  if (data.startsWith('pg:')) {
    const pg = parseInt(data.split(':')[1]);
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return listarClientes(chatId, pg);
  }

  // Ver detalhes cliente
  if (data.startsWith('ver:')) {
    const id = data.split(':')[1];
    const { data: c } = await supabase.from('clientes').select('*').eq('id', id).single();
    if (!c) return bot.sendMessage(chatId, '❌ Cliente não encontrado.');
    return bot.sendMessage(chatId, fmtCliente(c), { parse_mode: 'Markdown', ...botoesCliente(c.id, c.telefone) });
  }

  // Ver detalhes imóvel
  if (data.startsWith('verim:')) {
    const id = data.split(':')[1];
    const { data: im } = await supabase.from('imoveis').select('*').eq('id', id).single();
    if (!im) return bot.sendMessage(chatId, '❌ Imóvel não encontrado.');
    return bot.sendMessage(chatId, fmtImovel(im), { parse_mode: 'Markdown', ...botoesImovel(im.id) });
  }

  // Editar status
  if (data.startsWith('st:')) {
    const id = data.split(':')[1];
    const inline = STATUS_LIST.map(s => ([{
      text: `${STATUS_EMOJI[s]||'⚪'} ${s}`,
      callback_data: `setstatus:${id}:${s}`
    }]));
    inline.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
    return bot.sendMessage(chatId, '📊 *Novo status:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inline } });
  }

  // Confirmar status
  if (data.startsWith('setstatus:')) {
    const parts    = data.split(':');
    const id       = parts[1];
    const novoSt   = parts.slice(2).join(':');
    const { error } = await supabase.from('clientes').update({ status: novoSt, last_edit: new Date().toISOString() }).eq('id', id);
    if (error) return bot.sendMessage(chatId, `❌ Erro: ${error.message}`);
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    const { data: c } = await supabase.from('clientes').select('*').eq('id', id).single();
    return bot.sendMessage(chatId, `✅ Status atualizado!\n\n${fmtCliente(c)}`, { parse_mode: 'Markdown', ...botoesCliente(c.id, c.telefone) });
  }

  // Registrar contato
  if (data.startsWith('reg:')) {
    const id   = data.split(':')[1];
    const tipos = ['📞 Ligação','💬 WhatsApp','✉️ E-mail','🏠 Visita','🤝 Reunião','📌 Outro'];
    const inline = tipos.map(t => ([{ text: t, callback_data: `setreg:${id}:${t}` }]));
    inline.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
    return bot.sendMessage(chatId, '📝 *Tipo de contato:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inline } });
  }

  // Confirmar tipo contato → pedir obs
  if (data.startsWith('setreg:')) {
    const parts = data.split(':');
    const id    = parts[1];
    const tipo  = parts.slice(2).join(':');
    userState[chatId] = { acao: 'registrar_contato', step: 'obs', data: { clienteId: id, tipo } };
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendMessage(chatId,
      `${tipo} registrado!\n\nAlguma *observação*? (opcional)\n_Pode responder por áudio_ 🎤`,
      { parse_mode: 'Markdown', reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true } }
    );
  }

  // Agendar visita pelo botão inline do cliente
  if (data.startsWith('vis:')) {
    const id = data.split(':')[1];
    const { data: c } = await supabase.from('clientes').select('id, nome').eq('id', id).single();
    if (!c) return bot.sendMessage(chatId, '❌ Cliente não encontrado.');
    userState[chatId] = { acao: 'nova_visita', step: 'data', data: { clienteId: c.id, clienteNome: c.nome }, clientes: [] };
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendMessage(chatId,
      `📅 *Agendar Visita para ${c.nome}*\n\nQual a *data*?\nFormato: DD/MM/AAAA\n_Pode responder por áudio_ 🎤`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [new Date().toLocaleDateString('pt-BR')],
            [new Date(Date.now()+86400000).toLocaleDateString('pt-BR')],
            ['❌ Cancelar']
          ],
          resize_keyboard: true
        }
      }
    );
  }

  // Editar campos do cliente
  if (data.startsWith('edit:')) {
    const id = data.split(':')[1];
    return bot.sendMessage(chatId, '✏️ *O que deseja editar?*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '📞 Telefone',   callback_data: `ef:${id}:telefone` },    { text: '✉️ Email',     callback_data: `ef:${id}:email` }],
        [{ text: '📍 Local',      callback_data: `ef:${id}:local` },        { text: '🏠 Imóvel',    callback_data: `ef:${id}:imovel_atual` }],
        [{ text: '💡 Observação', callback_data: `ef:${id}:obs` },          { text: '💪 Potencial', callback_data: `ef:${id}:potencial` }],
        [{ text: '❌ Cancelar',   callback_data: 'cancel' }]
      ]}
    });
  }

  if (data.startsWith('ef:')) {
    const [, id, field] = data.split(':');
    const labels = { telefone:'Telefone', email:'E-mail', local:'Localização', imovel_atual:'Imóvel', obs:'Observação', potencial:'Potencial' };
    userState[chatId] = { acao: 'editar_campo', step: 'valor', data: { clienteId: id, field } };
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    let kb = [['❌ Cancelar']];
    if (field === 'potencial') kb = [['Forte','Médio','Fraco'],['❌ Cancelar']];
    if (field === 'local')     kb = [['Balneário Camboriú','Itajaí'],['Camboriú','Praia Brava'],['❌ Cancelar']];
    return bot.sendMessage(chatId,
      `✏️ *Editar ${labels[field]||field}*\n\nDigite o novo valor:\n_Pode responder por áudio_ 🎤`,
      { parse_mode: 'Markdown', reply_markup: { keyboard: kb, resize_keyboard: true } }
    );
  }

  // Excluir cliente
  if (data.startsWith('del:')) {
    const id = data.split(':')[1];
    const { data: c } = await supabase.from('clientes').select('nome').eq('id', id).single();
    return bot.sendMessage(chatId,
      `⚠️ *Excluir "${c?.nome||'este cliente'}"?*\n\nEsta ação não pode ser desfeita.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Sim, excluir', callback_data: `confirmdel:${id}` }, { text: '❌ Não', callback_data: 'cancel' }]
      ]}}
    );
  }

  if (data.startsWith('confirmdel:')) {
    const id = data.split(':')[1];
    await supabase.from('clientes').delete().eq('id', id);
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendMenu(chatId, '✅ Cliente excluído com sucesso.');
  }

  // Ver matches
  if (data.startsWith('match:')) {
    const id = data.split(':')[1];
    const [{ data: c }, { data: imoveis }] = await Promise.all([
      supabase.from('clientes').select('*').eq('id', id).single(),
      supabase.from('imoveis').select('*').limit(50)
    ]);
    if (!c)           return bot.sendMessage(chatId, '❌ Cliente não encontrado.');
    if (!imoveis?.length) return bot.sendMessage(chatId, '🏠 Nenhum imóvel no portfólio ainda.');

    const parseV = s => parseFloat(String(s||'').replace(/[^\d]/g,'')) || 0;
    const parseN = s => parseInt(String(s||'').replace(/\D/g,'')) || 0;
    const localLead = (c.local||'').toLowerCase();

    const scored = imoveis.map(im => {
      let score = 0;
      const imB = (im.bairro||'').toLowerCase();
      if (localLead && imB && (localLead.includes(imB) || imB.includes(localLead))) score += 35;
      const vL = parseV(c.imovel_atual), vI = parseV(im.valor);
      if (vL && vI) { const r = vI/vL; if (r>=0.7&&r<=1.4) score+=30; else if (r>=0.5) score+=10; }
      const dL = parseN(c.imovel_origem), dI = parseN(im.dorms);
      if (dL && dI && Math.abs(dL-dI)<=1) score+=20;
      return { im, score };
    }).filter(x => x.score >= 20).sort((a,b) => b.score-a.score).slice(0,5);

    if (!scored.length) return bot.sendMessage(chatId,
      `🎯 Nenhum imóvel compatível para *${c.nome}* ainda.\n\nComplete o perfil do lead ou cadastre mais imóveis.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );

    let txt = `🎯 *Matches para ${c.nome}:*\n\n`;
    scored.forEach(({ im, score }) => {
      txt += `🏠 *${im.nome||'—'}* — Score: *${score}pts*\n`;
      txt += `   📍 ${im.bairro||'—'} · 💰 R$ ${im.valor||'—'} · 🛏 ${im.dorms||'—'}\n\n`;
    });
    return bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', ...mainMenu });
  }

  // Editar imóvel
  if (data.startsWith('imedit:')) {
    const id = data.split(':')[1];
    return bot.sendMessage(chatId, '✏️ *O que deseja editar no imóvel?*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '💰 Valor',    callback_data: `imef:${id}:valor` },   { text: '📍 Bairro',   callback_data: `imef:${id}:bairro` }],
        [{ text: '🛏 Dorms',   callback_data: `imef:${id}:dorms` },   { text: '💡 Obs',       callback_data: `imef:${id}:obs` }],
        [{ text: '🔄 Permuta', callback_data: `imef:${id}:permuta` }, { text: '💳 Parcela',   callback_data: `imef:${id}:parcelamento` }],
        [{ text: '❌ Cancelar', callback_data: 'cancel' }]
      ]}
    });
  }

  if (data.startsWith('imef:')) {
    const [, id, field] = data.split(':');
    const labels = { valor:'Valor', bairro:'Bairro', dorms:'Dormitórios', obs:'Observação', permuta:'Permuta', parcelamento:'Parcelamento' };
    userState[chatId] = { acao: 'editar_imovel', step: 'valor', data: { imovelId: id, field } };
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendMessage(chatId,
      `✏️ *Editar ${labels[field]||field}*\n\nDigite o novo valor:`,
      { parse_mode: 'Markdown', reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true } }
    );
  }

  // Excluir imóvel
  if (data.startsWith('imdel:')) {
    const id = data.split(':')[1];
    const { data: im } = await supabase.from('imoveis').select('nome').eq('id', id).single();
    return bot.sendMessage(chatId,
      `⚠️ *Excluir "${im?.nome||'este imóvel'}"?*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '✅ Sim, excluir', callback_data: `confirmimdel:${id}` }, { text: '❌ Não', callback_data: 'cancel' }]
      ]}}
    );
  }

  if (data.startsWith('confirmimdel:')) {
    const id = data.split(':')[1];
    await supabase.from('imoveis').delete().eq('id', id);
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendMenu(chatId, '✅ Imóvel excluído com sucesso.');
  }

  if (data === 'cancel') {
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendMenu(chatId, '❌ Ação cancelada.');
  }
});

// =====================
// ÁUDIO 🎤
// =====================
bot.on('voice', async (msg) => {
  if (!await isAllowed(msg)) return;
  const chatId = msg.chat.id;
  if (!GROQ_KEY) return bot.sendMessage(chatId, '⚠️ Áudio não configurado.', mainMenu);

  const thinking = await bot.sendMessage(chatId, '🎤 _Ouvindo..._', { parse_mode: 'Markdown' });
  try {
    const audioPath   = await downloadAudio(msg.voice.file_id);
    const transcricao = await transcribeAudio(audioPath);
    fs.unlink(audioPath, () => {});

    if (!transcricao) return bot.editMessageText('❌ Não entendi. Tente novamente.', { chat_id: chatId, message_id: thinking.message_id });
    await bot.editMessageText(`🎤 _Ouvi:_ "${transcricao}"`, { chat_id: chatId, message_id: thinking.message_id, parse_mode: 'Markdown' });

    const state = userState[chatId];
    if (state) return processarTexto(chatId, transcricao, msg);

    const cmd = await interpretarComando(transcricao);
    if (!cmd || cmd.acao === 'desconhecido') {
      return bot.sendMessage(chatId, `🤔 Não entendi: _"${transcricao}"_\n\nUse os botões abaixo.`, { parse_mode: 'Markdown', ...mainMenu });
    }
    switch (cmd.acao) {
      case 'novo_cliente':     await iniciarNovoCliente(chatId); break;
      case 'novo_imovel':      await iniciarNovoImovel(chatId); break;
      case 'listar':           await listarClientes(chatId); break;
      case 'listar_imoveis':   await listarImoveis(chatId); break;
      case 'lembretes':        await enviarLembretes(chatId); break;
      case 'agendar_visita':   await iniciarVisita(chatId); break;
      case 'proximas_visitas': await proximasVisitas(chatId); break;
      case 'resumo':           await resumoDia(chatId); break;
      case 'buscar':
        if (cmd.query) await buscarCliente(chatId, cmd.query);
        else {
          userState[chatId] = { acao: 'buscar', step: 'query' };
          await bot.sendMessage(chatId, '🔍 Digite o nome:', { reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true } });
        }
        break;
    }
  } catch (err) {
    console.error('Erro áudio:', err);
    await bot.sendMessage(chatId, '❌ Erro ao processar áudio.', mainMenu);
  }
});

// =====================
// WIZARDS — INÍCIO
// =====================
async function iniciarNovoCliente(chatId) {
  userState[chatId] = { acao: 'novo_cliente', step: 'nome', data: {} };
  await bot.sendMessage(chatId,
    '👤 *Novo Cliente*\n\nQual o *nome*?\n_Pode responder por áudio_ 🎤',
    { parse_mode: 'Markdown', reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true } }
  );
}
bot.onText(/👤 Novo Cliente|\/novo/, async (msg) => { if (!await isAllowed(msg)) return; await iniciarNovoCliente(msg.chat.id); });

async function iniciarNovoImovel(chatId) {
  userState[chatId] = { acao: 'novo_imovel', step: 'nome', data: {} };
  await bot.sendMessage(chatId,
    '🏠 *Novo Imóvel*\n\nQual o *nome/edifício*?\n_Pode responder por áudio_ 🎤',
    { parse_mode: 'Markdown', reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true } }
  );
}
bot.onText(/🏠 Novo Imóvel|\/imovel$/, async (msg) => { if (!await isAllowed(msg)) return; await iniciarNovoImovel(msg.chat.id); });

async function iniciarVisita(chatId) {
  const { data: clientes } = await supabase.from('clientes').select('id, nome').order('nome').limit(20);
  if (!clientes?.length) return sendMenu(chatId, '⚠️ Cadastre ao menos um cliente primeiro.');
  userState[chatId] = { acao: 'nova_visita', step: 'cliente', data: {}, clientes };
  const keyboard = clientes.map(c => [c.nome]);
  keyboard.push(['❌ Cancelar']);
  await bot.sendMessage(chatId, '📅 *Agendar Visita*\n\nQual o *cliente*?', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard, resize_keyboard: true }
  });
}
bot.onText(/📅 Agendar Visita|\/visita$/, async (msg) => { if (!await isAllowed(msg)) return; await iniciarVisita(msg.chat.id); });

// =====================
// PROCESSAR WIZARD
// =====================
async function processarTexto(chatId, text, msg) {
  if (text === '❌ Cancelar') return sendMenu(chatId, '❌ Cancelado.');
  const state = userState[chatId];
  if (!state) return;
  const pular = text.toLowerCase() === 'pular';

  // BUSCAR
  if (state.acao === 'buscar' && state.step === 'query') return buscarCliente(chatId, text);

  // REGISTRAR CONTATO
  if (state.acao === 'registrar_contato' && state.step === 'obs') {
    const { clienteId, tipo } = state.data;
    await supabase.from('clientes').update({ last_edit: new Date().toISOString() }).eq('id', clienteId);
    const tipoLimpo = tipo.replace(/[^\w\s]/g,'').trim();
    return sendMenu(chatId, `✅ *${tipoLimpo}* registrado!${(!pular && text) ? '\n💡 '+text : ''}`);
  }

  // EDITAR CAMPO CLIENTE
  if (state.acao === 'editar_campo' && state.step === 'valor') {
    const { clienteId, field } = state.data;
    const { error } = await supabase.from('clientes').update({ [field]: text, last_edit: new Date().toISOString() }).eq('id', clienteId);
    if (error) return sendMenu(chatId, `❌ Erro: ${error.message}`);
    const { data: c } = await supabase.from('clientes').select('*').eq('id', clienteId).single();
    return bot.sendMessage(chatId, `✅ *Atualizado!*\n\n${fmtCliente(c)}`, { parse_mode: 'Markdown', ...botoesCliente(c.id, c.telefone) });
  }

  // EDITAR CAMPO IMÓVEL
  if (state.acao === 'editar_imovel' && state.step === 'valor') {
    const { imovelId, field } = state.data;
    const { error } = await supabase.from('imoveis').update({ [field]: text }).eq('id', imovelId);
    if (error) return sendMenu(chatId, `❌ Erro: ${error.message}`);
    const { data: im } = await supabase.from('imoveis').select('*').eq('id', imovelId).single();
    return bot.sendMessage(chatId, `✅ *Imóvel atualizado!*\n\n${fmtImovel(im)}`, { parse_mode: 'Markdown', ...botoesImovel(im.id) });
  }

  // NOVO CLIENTE
  if (state.acao === 'novo_cliente') {
    if (state.step === 'nome') {
      state.data.nome = pular ? 'Lead sem nome' : text;
      state.step = 'telefone';
      return bot.sendMessage(chatId,
        `✅ Nome: *${state.data.nome}*\n\n📞 Telefone/WhatsApp?\n_Ex: 48999999999_\n_Pode responder por áudio_ 🎤`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true } }
      );
    }
    if (state.step === 'telefone') {
      state.data.telefone = pular ? null : text.replace(/[^\d]/g,'');
      state.step = 'status';
      return bot.sendMessage(chatId, 'Qual o *status* do lead?', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['🔵 Novo Lead','🟡 Em Atendimento'],['🟠 Ajustes','🔴 Em Proposta'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'status') {
      const smap = { '🔵 Novo Lead':'Novo Lead','🟡 Em Atendimento':'Em Atendimento','🟠 Ajustes':'Ajustes de viabilidade','🔴 Em Proposta':'Em Proposta' };
      state.data.status = smap[text] || text || 'Novo Lead';
      state.step = 'local';
      return bot.sendMessage(chatId, 'Qual a *localização de interesse*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Balneário Camboriú','Itajaí'],['Camboriú','Praia Brava'],['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'local') {
      state.data.local = pular ? null : text;
      state.step = 'imovel';
      return bot.sendMessage(chatId, 'Qual o *imóvel de interesse*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'imovel') {
      state.data.imovel_atual = pular ? null : text;
      state.step = 'obs';
      return bot.sendMessage(chatId, 'Alguma *observação*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = pular ? null : text;
      const _uTel = await getUsuarioByChatId(chatId);
      const nc = {
        id: gerarId(), nome: state.data.nome, telefone: state.data.telefone||null,
        status: state.data.status||'Novo Lead', local: state.data.local||null,
        imovel_atual: state.data.imovel_atual||null, obs: state.data.obs||null,
        corretor_id:   _uTel ? _uTel.id   : null,
        corretor_nome: _uTel ? _uTel.nome  : null,
        sinais: [], contatos: [],
        created_at: new Date().toISOString(), last_edit: new Date().toISOString(),
      };
      const { error } = await supabase.from('clientes').insert([nc]);
      if (error) return sendMenu(chatId, `❌ Erro ao salvar: ${error.message}`);
      return sendMenu(chatId, `✅ *Cliente cadastrado!*\n\n👤 ${nc.nome}\n📞 ${nc.telefone||'—'}\n${STATUS_EMOJI[nc.status]||''} ${nc.status}\n📍 ${nc.local||'—'}`);
    }
  }

  // NOVO IMÓVEL
  if (state.acao === 'novo_imovel') {
    if (state.step === 'nome') {
      state.data.nome = pular ? 'Imóvel sem nome' : text;
      state.step = 'tipo';
      return bot.sendMessage(chatId, `✅ *${state.data.nome}*\n\nQual o *tipo*?`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Apartamento','Casa'],['Cobertura','Studio'],['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'tipo') {
      state.data.tipo = pular ? null : text;
      state.step = 'bairro';
      return bot.sendMessage(chatId, 'Qual o *bairro/cidade*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Balneário Camboriú','Itajaí'],['Camboriú','Praia Brava'],['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'bairro') {
      state.data.bairro = pular ? null : text;
      state.step = 'valor';
      return bot.sendMessage(chatId, 'Qual o *valor*?\nEx: 6.500.000\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'valor') {
      state.data.valor = pular ? null : text;
      state.step = 'dorms';
      return bot.sendMessage(chatId, 'Quantos *dormitórios*?', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['1','2','3'],['4','5'],['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'dorms') {
      state.data.dorms = pular ? null : text;
      state.step = 'obs';
      return bot.sendMessage(chatId, 'Alguma *observação*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = pular ? null : text;
      const ni = {
        id: gerarId(), nome: state.data.nome||null, tipo: state.data.tipo||null,
        bairro: state.data.bairro||null, valor: state.data.valor||null,
        dorms: state.data.dorms||null, obs: state.data.obs||null,
        created_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('imoveis').insert([ni]);
      if (error) return sendMenu(chatId, `❌ Erro ao salvar: ${error.message}`);
      return sendMenu(chatId, `✅ *Imóvel cadastrado!*\n\n🏠 ${ni.nome}\n📍 ${ni.bairro||'—'}\nTipo: ${ni.tipo||'—'}\n💰 R$ ${ni.valor||'—'}\n🛏 ${ni.dorms||'—'}`);
    }
  }

  // NOVA VISITA
  if (state.acao === 'nova_visita') {
    if (state.step === 'cliente') {
      let c = state.clientes.find(x => x.nome === text) || state.clientes.find(x => x.nome.toLowerCase().includes(text.toLowerCase()));
      if (!c) return bot.sendMessage(chatId, '⚠️ Cliente não encontrado. Selecione da lista.');
      state.data.clienteId = c.id; state.data.clienteNome = c.nome;
      state.step = 'data';
      return bot.sendMessage(chatId,
        `👤 *${c.nome}*\n\nQual a *data*?\nFormato: DD/MM/AAAA\n_Pode responder por áudio_ 🎤`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [[new Date().toLocaleDateString('pt-BR')],[new Date(Date.now()+86400000).toLocaleDateString('pt-BR')],['❌ Cancelar']], resize_keyboard: true } }
      );
    }
    if (state.step === 'data') {
      let iso;
      const t = text.toLowerCase();
      if (t==='hoje') iso = new Date().toISOString().split('T')[0];
      else if (t==='amanhã'||t==='amanha') iso = new Date(Date.now()+86400000).toISOString().split('T')[0];
      else {
        const p = text.replace(/[\/\-\.]/g,'/').split('/');
        if (p.length!==3) return bot.sendMessage(chatId, '⚠️ Use DD/MM/AAAA ou "hoje"/"amanhã"');
        iso = `${p[2].length===2?'20'+p[2]:p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
      }
      state.data.data = iso;
      state.step = 'imovel';
      return bot.sendMessage(chatId,
        `📅 *${new Date(iso+'T12:00:00').toLocaleDateString('pt-BR')}*\n\nQual o *imóvel* a visitar?\n_Pode responder por áudio_ 🎤`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true } }
      );
    }
    if (state.step === 'imovel') {
      state.data.imovel = pular ? null : text;
      state.step = 'obs';
      return bot.sendMessage(chatId, 'Alguma *observação*?\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'],['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = pular ? null : text;
      const nv = {
        id: gerarId(), cliente_id: state.data.clienteId, cliente_nome: state.data.clienteNome,
        imovel: state.data.imovel||null, data: state.data.data, obs: state.data.obs||null,
      };
      const { error } = await supabase.from('visitas').insert([nv]);
      if (error) return sendMenu(chatId, `❌ Erro ao salvar: ${error.message}`);
      const dtStr = new Date(state.data.data+'T12:00:00').toLocaleDateString('pt-BR');
      const title = encodeURIComponent(`Visita: ${state.data.clienteNome}${state.data.imovel?' — '+state.data.imovel:''}`);
      const gd    = state.data.data.replace(/-/g,'');
      const gcal  = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${gd}/${gd}`;
      return sendMenu(chatId, `✅ *Visita agendada!*\n\n👤 ${state.data.clienteNome}\n🏠 ${state.data.imovel||'—'}\n📅 ${dtStr}\n\n[📅 Adicionar ao Google Calendar](${gcal})`);
    }
  }
}

// =====================
// LEMBRETES AUTOMÁTICOS
// =====================
const ALERTA_URGENTE = 7;
const ALERTA_AVISO   = 15;
const ALERTA_FRIO    = 30;

async function enviarLembretes(chatId) {
  try {
    const { data: clientes } = await supabase.from('clientes').select('*')
      .not('status','eq','Venda Fechada').not('status','eq','Perdido');
    if (!clientes?.length) {
      if (chatId) bot.sendMessage(chatId, '✅ *Todos os leads estão em dia!* 💪', { parse_mode: 'Markdown', ...mainMenu });
      return;
    }
    const urgentes = [], avisos = [], frios = [];
    clientes.forEach(c => {
      const dias = diasSemContato(c);
      if (dias >= ALERTA_FRIO) frios.push({...c,dias});
      else if (dias >= ALERTA_AVISO) avisos.push({...c,dias});
      else if (dias >= ALERTA_URGENTE && ['Em Proposta','Negociação'].includes(c.status)) urgentes.push({...c,dias});
    });
    if (!urgentes.length && !avisos.length && !frios.length) {
      if (chatId) bot.sendMessage(chatId, '✅ *Nenhum lead precisando de atenção!* 💪', { parse_mode: 'Markdown', ...mainMenu });
      return;
    }
    let txt = `⏰ *FOLLOW-UP*\n_${new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'})}_\n\n`;
    if (urgentes.length) { txt += `🔴 *URGENTE:*\n`; urgentes.slice(0,5).forEach(c=>{txt+=`• ${c.nome} — ${c.dias}d (${c.status})\n`;}); txt+='\n'; }
    if (avisos.length)   { txt += `🟡 *ATENÇÃO:*\n`; avisos.slice(0,5).forEach(c=>{txt+=`• ${c.nome} — ${c.dias}d\n`;}); txt+='\n'; }
    if (frios.length)    { txt += `❄️ *FRIOS:*\n`;   frios.slice(0,5).forEach(c=>{txt+=`• ${c.nome} — ${c.dias}d\n`;}); txt+='\n'; }
    txt += `📊 Total: *${urgentes.length+avisos.length+frios.length}* precisando de contato`;
    const target = chatId || ALLOWED_USER;
    if (target) bot.sendMessage(target, txt, { parse_mode: 'Markdown', ...mainMenu });
  } catch(e) { console.error('Erro lembretes:', e.message); }
}

async function enviarAvisoVisitas(chatId) {
  try {
    const hoje = new Date(), amanha = new Date(hoje);
    amanha.setDate(amanha.getDate()+1);
    const fmt = d => d.toISOString().slice(0,10);
    const { data: visitas } = await supabase.from('visitas').select('*')
      .gte('data',fmt(hoje)).lte('data',fmt(amanha)+'T23:59:59').order('data',{ascending:true});
    if (!visitas?.length) return;
    let txt = '📅 *VISITAS DE HOJE E AMANHÃ*\n\n';
    visitas.forEach(v => {
      const dt = new Date(v.data), isHoje = dt.toDateString()===hoje.toDateString();
      txt += `${isHoje?'📍 *HOJE*':'📅 Amanhã'}\n👤 ${v.cliente_nome||'—'}\n🏠 ${v.imovel||'—'}\n\n`;
    });
    const target = chatId || ALLOWED_USER;
    if (target) bot.sendMessage(target, txt, { parse_mode: 'Markdown' });
  } catch(e) { console.error('Erro visitas:', e.message); }
}

function iniciarAgendador() {
  console.log('⏰ Agendador iniciado');
  setInterval(() => {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h===8  && m<5) { resumoDia(ALLOWED_USER); enviarLembretes(null); enviarAvisoVisitas(null); }
    if (h===12 && m<5) enviarLembretes(null);
    if (h===18 && m<5) enviarLembretes(null);
  }, 5*60*1000);
}

bot.onText(/\/lembretes|🔔 Lembretes/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await bot.sendMessage(msg.chat.id, '🔍 Verificando leads...', { parse_mode: 'Markdown' });
  await enviarLembretes(msg.chat.id);
});

bot.onText(/\/visitas_hoje/, async (msg) => {
  if (!await isAllowed(msg)) return;
  await enviarAvisoVisitas(msg.chat.id);
});

// =====================
// HANDLER GERAL
// =====================
bot.on('message', async (msg) => {
  if (!await isAllowed(msg)) return;
  if (msg.voice) return;
  const chatId = msg.chat.id, text = msg.text || '';
  const cmds = [
    '/start','/novo','/imovel','/imoveis','/listar','/visita','/visitas','/resumo','/buscar','/lembretes','/visitas_hoje',
    '👤 Novo Cliente','🏠 Novo Imóvel','📋 Listar Clientes','🏘 Ver Imóveis',
    '📅 Agendar Visita','🗓 Próximas Visitas','📊 Resumo do Dia','🔔 Lembretes','🔍 Buscar Cliente'
  ];
  if (cmds.some(c => text===c || text.startsWith(c+' '))) return;
  await processarTexto(chatId, text, msg);
});

// =====================
// COMANDOS
// =====================
// Comando /meuid — mostra o chat ID do usuário
bot.onText(/\/meuid/, async (msg) => {
  const chatId = msg.chat.id;
  const u = await getUsuarioByChatId(chatId);
  if(u) {
    bot.sendMessage(chatId,
      `✅ *Seu Telegram já está vinculado!*\n\n👤 ${u.nome}\n🔑 Nível: ${u.nivel}\n📋 ID: \`${chatId}\``,
      { parse_mode: 'Markdown' }
    );
  } else {
    bot.sendMessage(chatId,
      `📋 *Seu ID do Telegram é:*\n\n\`${chatId}\`\n\n_Cole esse número no CRM em Minha Conta → Telegram Chat ID_`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.setMyCommands([
  { command: 'start',        description: '🏠 Menu principal' },
  { command: 'novo',         description: '👤 Novo cliente' },
  { command: 'imovel',       description: '🏠 Novo imóvel' },
  { command: 'listar',       description: '📋 Listar clientes' },
  { command: 'imoveis',      description: '🏘 Ver portfólio' },
  { command: 'visita',       description: '📅 Agendar visita' },
  { command: 'visitas',      description: '🗓 Próximas visitas' },
  { command: 'resumo',       description: '📊 Resumo do dia' },
  { command: 'buscar',       description: '🔍 Buscar cliente' },
  { command: 'lembretes',    description: '🔔 Leads sem contato' },
  { command: 'visitas_hoje', description: '📅 Visitas hoje/amanhã' },
  { command: 'meuid',        description: '🔑 Ver meu ID do Telegram' },
]);

iniciarAgendador();

// =====================
// SERVIDOR HTTP
// =====================
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('🏠 REALTOR PRO CRM Bot rodando!'); }).listen(PORT, () => {
  console.log(`🏠 Bot rodando na porta ${PORT}...`);
});
