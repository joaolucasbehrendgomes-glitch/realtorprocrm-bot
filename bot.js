const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ALLOWED_USER = process.env.TELEGRAM_USER_ID; // sua segurança pessoal

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Estado temporário por usuário (wizard)
const userState = {};

// =====================
// SEGURANÇA
// =====================
function isAllowed(msg) {
  return !ALLOWED_USER || String(msg.from.id) === String(ALLOWED_USER);
}

// =====================
// MENU PRINCIPAL
// =====================
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['👤 Novo Cliente', '🏠 Novo Imóvel'],
      ['📅 Agendar Visita', '📋 Listar Clientes'],
      ['🗓 Próximas Visitas', '📊 Resumo do Dia'],
    ],
    resize_keyboard: true,
    persistent: true
  }
};

// =====================
// HELPERS
// =====================
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function sendMenu(chatId, msg = '✅ Pronto! O que deseja fazer?') {
  userState[chatId] = null;
  await bot.sendMessage(chatId, msg, mainMenu);
}

// =====================
// START
// =====================
bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `🏠 *Olá, João Lucas!*\n\nSeu CRM imobiliário está pronto.\n\nUse os botões abaixo ou digite comandos como:\n• _"Adicionar cliente Ricardo Almeida"_\n• _"Agendar visita amanhã às 10h"_\n• _"Listar clientes quentes"_`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// =====================
// LISTAR CLIENTES
// =====================
bot.onText(/📋 Listar Clientes/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  const { data, error } = await supabase
    .from('clientes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data || !data.length) {
    return bot.sendMessage(chatId, '📋 Nenhum cliente cadastrado ainda.', mainMenu);
  }

  const statusEmoji = { Quente: '🔴', Morno: '🟡', Frio: '🔵' };
  const texto = data.map((c, i) =>
    `${i+1}. *${c.nome}* ${statusEmoji[c.status] || ''}\n   📞 ${c.telefone || '—'}  💰 ${c.budget ? 'R$ ' + c.budget : '—'}\n   🏘 ${c.interesse_bairro || '—'}`
  ).join('\n\n');

  await bot.sendMessage(chatId, `📋 *Últimos Clientes:*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
});

// =====================
// PRÓXIMAS VISITAS
// =====================
bot.onText(/🗓 Próximas Visitas/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const hoje = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('visitas')
    .select('*')
    .gte('data', hoje)
    .neq('status', 'Realizada')
    .order('data', { ascending: true })
    .limit(10);

  if (error || !data || !data.length) {
    return bot.sendMessage(chatId, '📅 Nenhuma visita agendada.', mainMenu);
  }

  const texto = data.map(v =>
    `📅 *${formatDate(v.data)}* às *${v.hora}*\n   👤 ${v.cliente_nome}\n   🏠 ${v.imovel_nome}${v.obs ? `\n   📝 ${v.obs}` : ''}`
  ).join('\n\n');

  await bot.sendMessage(chatId, `🗓 *Próximas Visitas:*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
});

// =====================
// RESUMO DO DIA
// =====================
bot.onText(/📊 Resumo do Dia/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const hoje = new Date().toISOString().split('T')[0];

  const [{ count: totalClientes }, { count: quentes }, { data: visitasHoje }] = await Promise.all([
    supabase.from('clientes').select('*', { count: 'exact', head: true }),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Quente'),
    supabase.from('visitas').select('*').eq('data', hoje).neq('status', 'Realizada'),
  ]);

  const visitasTexto = visitasHoje && visitasHoje.length
    ? visitasHoje.map(v => `   • ${v.hora} — ${v.cliente_nome} → ${v.imovel_nome}`).join('\n')
    : '   Nenhuma visita hoje';

  await bot.sendMessage(chatId,
    `📊 *Resumo — ${new Date().toLocaleDateString('pt-BR')}*\n\n` +
    `👥 Total de clientes: *${totalClientes || 0}*\n` +
    `🔴 Leads quentes: *${quentes || 0}*\n\n` +
    `🗓 *Visitas de hoje:*\n${visitasTexto}`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// =====================
// NOVO CLIENTE (wizard)
// =====================
bot.onText(/👤 Novo Cliente/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  userState[chatId] = { acao: 'novo_cliente', step: 'nome', data: {} };
  await bot.sendMessage(chatId, '👤 *Novo Cliente*\n\nQual o *nome completo* do cliente?', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
  });
});

// =====================
// NOVO IMÓVEL (wizard)
// =====================
bot.onText(/🏠 Novo Imóvel/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  userState[chatId] = { acao: 'novo_imovel', step: 'nome', data: {} };
  await bot.sendMessage(chatId, '🏠 *Novo Imóvel*\n\nQual o *nome ou edifício*?', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
  });
});

// =====================
// AGENDAR VISITA (wizard)
// =====================
bot.onText(/📅 Agendar Visita/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  // Busca clientes para escolher
  const { data: clientes } = await supabase.from('clientes').select('id, nome').order('nome').limit(20);

  if (!clientes || !clientes.length) {
    return bot.sendMessage(chatId, '⚠️ Cadastre ao menos um cliente antes de agendar uma visita.', mainMenu);
  }

  userState[chatId] = { acao: 'nova_visita', step: 'cliente', data: {}, clientes };

  const keyboard = clientes.map(c => [c.nome]);
  keyboard.push(['❌ Cancelar']);

  await bot.sendMessage(chatId, '📅 *Agendar Visita*\n\nQual o *cliente*?', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard, resize_keyboard: true }
  });
});

// =====================
// HANDLER GERAL DE MENSAGENS (wizard steps)
// =====================
bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Cancelar
  if (text === '❌ Cancelar') {
    return sendMenu(chatId, '❌ Ação cancelada.');
  }

  // Ignorar comandos já tratados pelo onText
  if (text.startsWith('/') || ['👤 Novo Cliente','🏠 Novo Imóvel','📅 Agendar Visita','📋 Listar Clientes','🗓 Próximas Visitas','📊 Resumo do Dia'].includes(text)) return;

  const state = userState[chatId];
  if (!state) return;

  // ---- WIZARD: NOVO CLIENTE ----
  if (state.acao === 'novo_cliente') {
    if (state.step === 'nome') {
      state.data.nome = text;
      state.step = 'telefone';
      return bot.sendMessage(chatId, `✅ Nome: *${text}*\n\nQual o *telefone/WhatsApp*? (ou "pular")`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'telefone') {
      state.data.telefone = text === 'pular' ? null : text;
      state.step = 'email';
      return bot.sendMessage(chatId, 'Qual o *e-mail*? (ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'email') {
      state.data.email = text === 'pular' ? null : text;
      state.step = 'status';
      return bot.sendMessage(chatId, 'Qual o *status* do lead?', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['🔴 Quente'], ['🟡 Morno'], ['🔵 Frio'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'status') {
      state.data.status = text.replace(/🔴 |🟡 |🔵 /, '');
      state.step = 'budget';
      return bot.sendMessage(chatId, 'Qual o *budget* (valor que tem pra investir)? Ex: 3.000.000\n(ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'budget') {
      state.data.budget = text === 'pular' ? null : text;
      state.step = 'bairro';
      return bot.sendMessage(chatId, 'Qual o *bairro/cidade de interesse*? (ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Jurerê Internacional'], ['Balneário Camboriú'], ['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'bairro') {
      state.data.interesse_bairro = text === 'pular' ? null : text;

      // Salvar no Supabase
      const { error } = await supabase.from('clientes').insert([{
        nome: state.data.nome,
        telefone: state.data.telefone,
        email: state.data.email,
        status: state.data.status || 'Morno',
        budget: state.data.budget,
        interesse_bairro: state.data.interesse_bairro,
        interesse: 'Compra'
      }]);

      if (error) {
        return sendMenu(chatId, '❌ Erro ao salvar cliente. Tente novamente.');
      }

      return sendMenu(chatId,
        `✅ *Cliente cadastrado com sucesso!*\n\n👤 ${state.data.nome}\n📞 ${state.data.telefone || '—'}\n💰 ${state.data.budget ? 'R$ ' + state.data.budget : '—'}\n🔥 ${state.data.status}`
      );
    }
  }

  // ---- WIZARD: NOVO IMÓVEL ----
  if (state.acao === 'novo_imovel') {
    if (state.step === 'nome') {
      state.data.nome = text;
      state.step = 'tipo';
      return bot.sendMessage(chatId, `✅ Imóvel: *${text}*\n\nQual o *tipo*?`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Apartamento', 'Cobertura'], ['Casa', 'Mansão'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'tipo') {
      state.data.tipo = text;
      state.step = 'bairro';
      return bot.sendMessage(chatId, 'Qual o *bairro/cidade*?', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['Jurerê Internacional'], ['Beira-Mar Norte'], ['Balneário Camboriú'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'bairro') {
      state.data.bairro = text;
      state.step = 'valor';
      return bot.sendMessage(chatId, 'Qual o *valor de venda*? Ex: 6.500.000\n(ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'valor') {
      state.data.valor = text === 'pular' ? null : text;
      state.step = 'dorms';
      return bot.sendMessage(chatId, 'Quantos *dormitórios*? (ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['3', '4', '5'], ['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'dorms') {
      state.data.dorms = text === 'pular' ? null : text;
      state.step = 'area';
      return bot.sendMessage(chatId, 'Qual a *área em m²*? (ou "pular")', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'area') {
      state.data.area = text === 'pular' ? null : text;

      const { error } = await supabase.from('imoveis').insert([{
        nome: state.data.nome,
        tipo: state.data.tipo,
        bairro: state.data.bairro,
        valor: state.data.valor,
        dorms: state.data.dorms,
        area: state.data.area,
        status: 'Disponível'
      }]);

      if (error) return sendMenu(chatId, '❌ Erro ao salvar imóvel.');

      return sendMenu(chatId,
        `✅ *Imóvel cadastrado!*\n\n🏠 ${state.data.nome}\n📍 ${state.data.bairro}\n💰 ${state.data.valor ? 'R$ ' + state.data.valor : '—'}\n🛏 ${state.data.dorms || '—'} dorms · ${state.data.area || '—'} m²`
      );
    }
  }

  // ---- WIZARD: NOVA VISITA ----
  if (state.acao === 'nova_visita') {
    if (state.step === 'cliente') {
      const cliente = state.clientes.find(c => c.nome === text);
      if (!cliente) return bot.sendMessage(chatId, '⚠️ Selecione um cliente da lista.');
      state.data.clienteId = cliente.id;
      state.data.clienteNome = cliente.nome;
      state.step = 'imovel';

      const { data: imoveis } = await supabase.from('imoveis').select('id, nome').order('nome').limit(20);
      state.imoveis = imoveis || [];

      if (!imoveis || !imoveis.length) {
        return bot.sendMessage(chatId, '⚠️ Cadastre ao menos um imóvel antes de agendar uma visita.', mainMenu);
      }

      const keyboard = imoveis.map(i => [i.nome]);
      keyboard.push(['❌ Cancelar']);
      return bot.sendMessage(chatId, `👤 Cliente: *${cliente.nome}*\n\nQual o *imóvel* a visitar?`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard, resize_keyboard: true }
      });
    }
    if (state.step === 'imovel') {
      const imovel = state.imoveis.find(i => i.nome === text);
      if (!imovel) return bot.sendMessage(chatId, '⚠️ Selecione um imóvel da lista.');
      state.data.imovelId = imovel.id;
      state.data.imovelNome = imovel.nome;
      state.step = 'data';
      return bot.sendMessage(chatId, `🏠 Imóvel: *${imovel.nome}*\n\nQual a *data da visita*?\nFormato: DD/MM/AAAA\nEx: ${new Date().toLocaleDateString('pt-BR')}`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'data') {
      const partes = text.split('/');
      if (partes.length !== 3) return bot.sendMessage(chatId, '⚠️ Use o formato DD/MM/AAAA');
      const iso = `${partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`;
      state.data.data = iso;
      state.step = 'hora';
      return bot.sendMessage(chatId, `📅 Data: *${text}*\n\nQual o *horário*?\nEx: 10:00`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['09:00', '10:00', '11:00'], ['14:00', '15:00', '16:00'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'hora') {
      state.data.hora = text;
      state.step = 'obs';
      return bot.sendMessage(chatId, `⏰ Horário: *${text}*\n\nAlguma *observação*? (ou "pular")`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = text === 'pular' ? null : text;

      const { error } = await supabase.from('visitas').insert([{
        cliente_id: state.data.clienteId,
        cliente_nome: state.data.clienteNome,
        imovel_id: state.data.imovelId,
        imovel_nome: state.data.imovelNome,
        data: state.data.data,
        hora: state.data.hora,
        obs: state.data.obs,
        status: 'Agendada'
      }]);

      if (error) return sendMenu(chatId, '❌ Erro ao salvar visita.');

      // Link Google Calendar
      const dtStart = state.data.data.replace(/-/g,'') + 'T' + state.data.hora.replace(':','') + '00';
      const h = parseInt(state.data.hora.split(':')[0]) + 1;
      const dtEnd = state.data.data.replace(/-/g,'') + 'T' + h.toString().padStart(2,'0') + state.data.hora.split(':')[1] + '00';
      const title = encodeURIComponent(`Visita: ${state.data.imovelNome} com ${state.data.clienteNome}`);
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dtStart}/${dtEnd}`;

      return bot.sendMessage(chatId,
        `✅ *Visita agendada!*\n\n👤 ${state.data.clienteNome}\n🏠 ${state.data.imovelNome}\n📅 ${state.data.data.split('-').reverse().join('/')} às ${state.data.hora}\n\n[📅 Adicionar ao Google Calendar](${gcal})`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
  }
});

// Servidor HTTP necessário para o Render.com Web Service (plano gratuito)
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('🏠 REALTOR PRO CRM Bot está rodando!');
}).listen(PORT, () => {
  console.log(`🏠 REALTOR PRO CRM Bot rodando na porta ${PORT}...`);
});
