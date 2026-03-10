const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const https = require('https');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const ALLOWED_USER = process.env.TELEGRAM_USER_ID;

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
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
      ['🔍 Buscar Cliente'],
    ],
    resize_keyboard: true,
    persistent: true
  }
};

bot.setMyCommands([
  { command: 'start', description: '🏠 Abrir menu principal' },
  { command: 'novo', description: '👤 Novo cliente' },
  { command: 'imovel', description: '🏠 Novo imóvel' },
  { command: 'listar', description: '📋 Listar clientes' },
  { command: 'visita', description: '📅 Agendar visita' },
  { command: 'resumo', description: '📊 Resumo do dia' },
  { command: 'buscar', description: '🔍 Buscar cliente' },
]);

// =====================
// HELPERS
// =====================
async function sendMenu(chatId, msg = '✅ Pronto! O que deseja fazer?') {
  userState[chatId] = null;
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...mainMenu });
}

function gerarId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 7);
}

// Baixa arquivo de áudio do Telegram
async function downloadAudio(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
  const tmpPath = `/tmp/audio_${Date.now()}.ogg`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath);
    https.get(fileUrl, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', reject);
  });
}

// Transcreve áudio com Groq Whisper
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
  if (!res.ok) { console.error('Groq Whisper error:', await res.text()); return null; }
  return (await res.text()).trim();
}

// Interpreta comando de voz com Groq LLM
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
          content: `Você é um assistente de CRM imobiliário do corretor João Lucas.
Analise o texto e retorne APENAS um JSON com a ação identificada.
Ações: novo_cliente, novo_imovel, listar, agendar_visita, proximas_visitas, resumo, buscar (com "query"), desconhecido.
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
// START
// =====================
bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg)) return;
  userState[msg.chat.id] = null;
  await bot.sendMessage(msg.chat.id,
    `🏠 *Olá, João Lucas!*\n\nBem-vindo ao seu CRM imobiliário.\n\n` +
    `Você pode usar os *botões abaixo* ou 🎤 *mandar áudio* — eu entendo e executo!\n\n` +
    `Exemplos de áudio:\n` +
    `_"Cadastrar novo cliente"_\n_"Novo imóvel"_\n_"Listar clientes"_`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// =====================
// LISTAR CLIENTES
// =====================
async function listarClientes(chatId) {
  const { data, error } = await supabase.from('clientes').select('*').order('created_at', { ascending: false }).limit(10);
  if (error) { console.error('Erro listar:', error); return sendMenu(chatId, '❌ Erro ao buscar clientes.'); }
  if (!data || !data.length) return sendMenu(chatId, '📋 Nenhum cliente cadastrado ainda.');
  const emoji = { 'Novo Lead':'🔵','Em Atendimento':'🟡','Ajustes de viabilidade':'🟠','Em Proposta':'🔴','Venda Fechada':'🟢','Perdido':'⚫' };
  const texto = data.map((c,i) => `${i+1}. *${c.nome}* ${emoji[c.status]||'⚪'}\n   📞 ${c.telefone||'—'}  📍 ${c.local||'—'}`).join('\n\n');
  await bot.sendMessage(chatId, `📋 *Últimos Clientes:*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
}

bot.onText(/📋 Listar Clientes|\/listar/, async (msg) => { if (!isAllowed(msg)) return; await listarClientes(msg.chat.id); });

// =====================
// BUSCAR CLIENTE
// =====================
async function buscarCliente(chatId, query) {
  const { data } = await supabase.from('clientes').select('*').ilike('nome', `%${query}%`).limit(5);
  if (!data || !data.length) return sendMenu(chatId, `🔍 Nenhum cliente encontrado para "*${query}*".`);
  const emoji = { 'Novo Lead':'🔵','Em Atendimento':'🟡','Em Proposta':'🔴','Venda Fechada':'🟢','Perdido':'⚫' };
  const texto = data.map((c,i) =>
    `${i+1}. *${c.nome}* ${emoji[c.status]||'⚪'}\n📞 ${c.telefone||'—'}\n🏠 ${c.imovel_atual||'—'}\n📍 ${c.local||'—'}\nStatus: ${c.status||'—'}`
  ).join('\n\n');
  await bot.sendMessage(chatId, `🔍 *"${query}":*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
}

bot.onText(/🔍 Buscar Cliente|\/buscar/, async (msg) => {
  if (!isAllowed(msg)) return;
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
  const { data } = await supabase.from('visitas').select('*').gte('data', hoje).order('data', { ascending: true }).limit(10);
  if (!data || !data.length) return sendMenu(chatId, '📅 Nenhuma visita agendada.');
  const texto = data.map(v => {
    const dt = new Date(v.data + 'T12:00:00');
    const dia = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `📅 *${dia}* — ${v.cliente_nome}\n   🏠 ${v.imovel||'—'}${v.obs?`\n   📝 ${v.obs}`:''}`;
  }).join('\n\n');
  await bot.sendMessage(chatId, `🗓 *Próximas Visitas:*\n\n${texto}`, { parse_mode: 'Markdown', ...mainMenu });
}

bot.onText(/🗓 Próximas Visitas|\/visitas/, async (msg) => { if (!isAllowed(msg)) return; await proximasVisitas(msg.chat.id); });

// =====================
// RESUMO DO DIA
// =====================
async function resumoDia(chatId) {
  const hoje = new Date().toISOString().split('T')[0];
  const [{ count: total }, { count: emProposta }, { count: fechados }, { data: visitasHoje }] = await Promise.all([
    supabase.from('clientes').select('*', { count: 'exact', head: true }),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Em Proposta'),
    supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('status', 'Venda Fechada'),
    supabase.from('visitas').select('*').eq('data', hoje),
  ]);
  const visitasTexto = visitasHoje && visitasHoje.length
    ? visitasHoje.map(v => `   • ${v.cliente_nome} → ${v.imovel||'—'}`).join('\n')
    : '   Nenhuma visita hoje';
  await bot.sendMessage(chatId,
    `📊 *Resumo — ${new Date().toLocaleDateString('pt-BR')}*\n\n` +
    `👥 Total clientes: *${total||0}*\n🔴 Em proposta: *${emProposta||0}*\n🟢 Vendas fechadas: *${fechados||0}*\n\n` +
    `🗓 *Visitas hoje:*\n${visitasTexto}`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
}

bot.onText(/📊 Resumo do Dia|\/resumo/, async (msg) => { if (!isAllowed(msg)) return; await resumoDia(msg.chat.id); });

// =====================
// NOVO CLIENTE (wizard)
// =====================
async function iniciarNovoCliente(chatId) {
  userState[chatId] = { acao: 'novo_cliente', step: 'nome', data: {} };
  await bot.sendMessage(chatId, '👤 *Novo Cliente*\n\nQual o *nome completo*?\n\n_Pode responder por áudio_ 🎤', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
  });
}

bot.onText(/👤 Novo Cliente|\/novo/, async (msg) => { if (!isAllowed(msg)) return; await iniciarNovoCliente(msg.chat.id); });

// =====================
// NOVO IMÓVEL (wizard)
// =====================
async function iniciarNovoImovel(chatId) {
  userState[chatId] = { acao: 'novo_imovel', step: 'nome', data: {} };
  await bot.sendMessage(chatId, '🏠 *Novo Imóvel*\n\nQual o *nome/título* do imóvel?\n\n_Pode responder por áudio_ 🎤', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true }
  });
}

bot.onText(/🏠 Novo Imóvel|\/imovel/, async (msg) => { if (!isAllowed(msg)) return; await iniciarNovoImovel(msg.chat.id); });

// =====================
// AGENDAR VISITA (wizard)
// =====================
async function iniciarVisita(chatId) {
  const { data: clientes } = await supabase.from('clientes').select('id, nome').order('nome').limit(20);
  if (!clientes || !clientes.length) return sendMenu(chatId, '⚠️ Cadastre ao menos um cliente antes de agendar uma visita.');
  userState[chatId] = { acao: 'nova_visita', step: 'cliente', data: {}, clientes };
  const keyboard = clientes.map(c => [c.nome]);
  keyboard.push(['❌ Cancelar']);
  await bot.sendMessage(chatId, '📅 *Agendar Visita*\n\nQual o *cliente*?\n\n_Pode digitar ou selecionar_ 🎤', {
    parse_mode: 'Markdown',
    reply_markup: { keyboard, resize_keyboard: true }
  });
}

bot.onText(/📅 Agendar Visita|\/visita/, async (msg) => { if (!isAllowed(msg)) return; await iniciarVisita(msg.chat.id); });

// =====================
// HANDLER DE ÁUDIO 🎤
// =====================
bot.on('voice', async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  if (!GROQ_KEY) return bot.sendMessage(chatId, '⚠️ Áudio não configurado. Configure GROQ_API_KEY.', mainMenu);
  const thinking = await bot.sendMessage(chatId, '🎤 _Ouvindo..._', { parse_mode: 'Markdown' });
  try {
    const audioPath = await downloadAudio(msg.voice.file_id);
    const transcricao = await transcribeAudio(audioPath);
    fs.unlink(audioPath, () => {});
    if (!transcricao) return bot.editMessageText('❌ Não consegui entender. Tente novamente.', { chat_id: chatId, message_id: thinking.message_id });
    await bot.editMessageText(`🎤 _Ouvi:_ "${transcricao}"`, { chat_id: chatId, message_id: thinking.message_id, parse_mode: 'Markdown' });
    const state = userState[chatId];
    if (state) { await processarTexto(chatId, transcricao, msg); return; }
    const comando = await interpretarComando(transcricao);
    if (!comando || comando.acao === 'desconhecido') {
      return bot.sendMessage(chatId, `🤔 Não entendi: _"${transcricao}"_\n\nUse os botões abaixo.`, { parse_mode: 'Markdown', ...mainMenu });
    }
    switch (comando.acao) {
      case 'novo_cliente': await iniciarNovoCliente(chatId); break;
      case 'novo_imovel': await iniciarNovoImovel(chatId); break;
      case 'listar': await listarClientes(chatId); break;
      case 'agendar_visita': await iniciarVisita(chatId); break;
      case 'proximas_visitas': await proximasVisitas(chatId); break;
      case 'resumo': await resumoDia(chatId); break;
      case 'buscar':
        if (comando.query) await buscarCliente(chatId, comando.query);
        else {
          userState[chatId] = { acao: 'buscar', step: 'query' };
          await bot.sendMessage(chatId, '🔍 Digite o nome:', { reply_markup: { keyboard: [['❌ Cancelar']], resize_keyboard: true } });
        }
        break;
    }
  } catch (err) {
    console.error('Erro no áudio:', err);
    await bot.sendMessage(chatId, '❌ Erro ao processar áudio.', mainMenu);
  }
});

// =====================
// PROCESSAR TEXTO (wizard steps)
// =====================
async function processarTexto(chatId, text, msg) {
  if (text === '❌ Cancelar') return sendMenu(chatId, '❌ Ação cancelada.');
  const state = userState[chatId];
  if (!state) return;

  // ---- BUSCAR ----
  if (state.acao === 'buscar' && state.step === 'query') return buscarCliente(chatId, text);

  // ---- NOVO CLIENTE ----
  if (state.acao === 'novo_cliente') {
    const pular = text.toLowerCase() === 'pular';
    if (state.step === 'nome') {
      state.data.nome = text;
      state.step = 'telefone';
      return bot.sendMessage(chatId, `✅ Nome: *${text}*\n\nQual o *telefone/WhatsApp*?\nEx: 48999999999\n\n_Pode responder por áudio_ 🎤`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'telefone') {
      state.data.telefone = pular ? null : text.replace(/[^0-9]/g, '');
      state.step = 'status';
      return bot.sendMessage(chatId, 'Qual o *status* do lead?', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['🔵 Novo Lead', '🟡 Em Atendimento'], ['🟠 Ajustes', '🔴 Em Proposta'], ['❌ Cancelar']],
          resize_keyboard: true
        }
      });
    }
    if (state.step === 'status') {
      const statusMap = {
        '🔵 Novo Lead': 'Novo Lead', '🟡 Em Atendimento': 'Em Atendimento',
        '🟠 Ajustes': 'Ajustes de viabilidade', '🔴 Em Proposta': 'Em Proposta',
        'novo lead': 'Novo Lead', 'em atendimento': 'Em Atendimento',
        'ajustes': 'Ajustes de viabilidade', 'em proposta': 'Em Proposta',
      };
      state.data.status = statusMap[text] || statusMap[text.toLowerCase()] || 'Novo Lead';
      state.step = 'local';
      return bot.sendMessage(chatId, 'Qual a *localização de interesse*?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['Balneário Camboriú', 'Itajaí'], ['Camboriú', 'Praia Brava'], ['pular'], ['❌ Cancelar']],
          resize_keyboard: true
        }
      });
    }
    if (state.step === 'local') {
      state.data.local = pular ? null : text;
      state.step = 'imovel';
      return bot.sendMessage(chatId, 'Qual o *imóvel de interesse*?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'imovel') {
      state.data.imovel_atual = pular ? null : text;
      state.step = 'obs';
      return bot.sendMessage(chatId, 'Alguma *observação* sobre este cliente?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = pular ? null : text;
      const novoCliente = {
        id: gerarId(),
        nome: state.data.nome,
        telefone: state.data.telefone || null,
        status: state.data.status || 'Novo Lead',
        local: state.data.local || null,
        imovel_atual: state.data.imovel_atual || null,
        obs: state.data.obs || null,
        sinais: [],
        contatos: [],
        created_at: new Date().toISOString(),
        last_edit: new Date().toISOString(),
      };
      const { error } = await supabase.from('clientes').insert([novoCliente]);
      if (error) {
        console.error('Erro ao salvar cliente:', JSON.stringify(error));
        return sendMenu(chatId, `❌ Erro ao salvar cliente: ${error.message}`);
      }
      return sendMenu(chatId,
        `✅ *Cliente cadastrado!*\n\n👤 ${novoCliente.nome}\n📞 ${novoCliente.telefone||'—'}\nStatus: ${novoCliente.status}\n📍 ${novoCliente.local||'—'}\n🏠 ${novoCliente.imovel_atual||'—'}`
      );
    }
  }

  // ---- NOVO IMÓVEL ----
  if (state.acao === 'novo_imovel') {
    const pular = text.toLowerCase() === 'pular';
    if (state.step === 'nome') {
      state.data.nome = text;
      state.step = 'tipo';
      return bot.sendMessage(chatId, `✅ Imóvel: *${text}*\n\nQual o *tipo*?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['Apartamento', 'Casa'], ['Cobertura', 'Studio'], ['pular'], ['❌ Cancelar']],
          resize_keyboard: true
        }
      });
    }
    if (state.step === 'tipo') {
      state.data.tipo = pular ? null : text;
      state.step = 'bairro';
      return bot.sendMessage(chatId, 'Qual o *bairro/cidade*?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [['Balneário Camboriú', 'Itajaí'], ['Camboriú', 'Praia Brava'], ['pular'], ['❌ Cancelar']],
          resize_keyboard: true
        }
      });
    }
    if (state.step === 'bairro') {
      state.data.bairro = pular ? null : text;
      state.step = 'valor';
      return bot.sendMessage(chatId, 'Qual o *valor de venda*?\nEx: 6.500.000\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'valor') {
      state.data.valor = pular ? null : text;
      state.step = 'dorms';
      return bot.sendMessage(chatId, 'Quantos *dormitórios*?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['1', '2', '3'], ['4', '5'], ['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'dorms') {
      state.data.dorms = pular ? null : text;
      state.step = 'area';
      return bot.sendMessage(chatId, 'Qual a *área em m²*?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'area') {
      state.data.area = pular ? null : text;
      state.step = 'descricao';
      return bot.sendMessage(chatId, 'Alguma *descrição/observação* sobre o imóvel?\n\n_Pode responder por áudio_ 🎤', {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'descricao') {
      state.data.descricao = pular ? null : text;
      const novoImovel = {
        id: gerarId(),
        nome: state.data.nome || null,
        tipo: state.data.tipo || null,
        bairro: state.data.bairro || null,
        valor: state.data.valor || null,
        dorms: state.data.dorms || null,
        area: state.data.area || null,
        obs: state.data.descricao || null,
        created_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('imoveis').insert([novoImovel]);
      if (error) {
        console.error('Erro ao salvar imóvel:', JSON.stringify(error));
        return sendMenu(chatId, `❌ Erro ao salvar imóvel: ${error.message}`);
      }
      return sendMenu(chatId,
        `✅ *Imóvel cadastrado!*\n\n🏠 ${novoImovel.nome}\n📍 ${novoImovel.bairro||'—'}\nTipo: ${novoImovel.tipo||'—'}\nValor: ${novoImovel.valor||'—'}\nDorms: ${novoImovel.dorms||'—'}\nÁrea: ${novoImovel.area||'—'} m²`
      );
    }
  }

  // ---- NOVA VISITA ----
  if (state.acao === 'nova_visita') {
    if (state.step === 'cliente') {
      let cliente = state.clientes.find(c => c.nome === text);
      if (!cliente) cliente = state.clientes.find(c => c.nome.toLowerCase().includes(text.toLowerCase()));
      if (!cliente) return bot.sendMessage(chatId, '⚠️ Cliente não encontrado. Tente novamente ou selecione da lista.');
      state.data.clienteId = cliente.id;
      state.data.clienteNome = cliente.nome;
      state.step = 'data';
      return bot.sendMessage(chatId, `👤 Cliente: *${cliente.nome}*\n\nQual a *data da visita*?\nFormato: DD/MM/AAAA\n\n_Pode responder por áudio_ 🎤`, {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [new Date().toLocaleDateString('pt-BR')],
            [new Date(Date.now()+86400000).toLocaleDateString('pt-BR')],
            ['❌ Cancelar']
          ],
          resize_keyboard: true
        }
      });
    }
    if (state.step === 'data') {
      let iso;
      const t = text.toLowerCase();
      if (t === 'hoje') iso = new Date().toISOString().split('T')[0];
      else if (t === 'amanhã' || t === 'amanha') iso = new Date(Date.now()+86400000).toISOString().split('T')[0];
      else {
        const partes = text.replace(/[\/\-\.]/g, '/').split('/');
        if (partes.length !== 3) return bot.sendMessage(chatId, '⚠️ Use DD/MM/AAAA ou diga "hoje" / "amanhã"');
        iso = `${partes[2].length===2?'20'+partes[2]:partes[2]}-${partes[1].padStart(2,'0')}-${partes[0].padStart(2,'0')}`;
      }
      state.data.data = iso;
      state.step = 'imovel';
      return bot.sendMessage(chatId, `📅 Data: *${new Date(iso+'T12:00:00').toLocaleDateString('pt-BR')}*\n\nQual o *imóvel* a visitar?\n\n_Pode responder por áudio_ 🎤`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'imovel') {
      state.data.imovel = text === 'pular' ? null : text;
      state.step = 'obs';
      return bot.sendMessage(chatId, `🏠 Imóvel: *${state.data.imovel||'—'}*\n\nAlguma *observação*?\n\n_Pode responder por áudio_ 🎤`, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [['pular'], ['❌ Cancelar']], resize_keyboard: true }
      });
    }
    if (state.step === 'obs') {
      state.data.obs = text === 'pular' ? null : text;
      const novaVisita = {
        id: gerarId(),
        cliente_id: state.data.clienteId,
        cliente_nome: state.data.clienteNome,
        imovel: state.data.imovel || null,
        data: state.data.data,
        obs: state.data.obs || null,
      };
      const { error } = await supabase.from('visitas').insert([novaVisita]);
      if (error) {
        console.error('Erro ao salvar visita:', JSON.stringify(error));
        return sendMenu(chatId, `❌ Erro ao salvar visita: ${error.message}`);
      }
      const dtStr = new Date(state.data.data+'T12:00:00').toLocaleDateString('pt-BR');
      const title = encodeURIComponent(`Visita: ${state.data.clienteNome}${state.data.imovel?' — '+state.data.imovel:''}`);
      const gd = state.data.data.replace(/-/g,'');
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${gd}/${gd}`;
      return bot.sendMessage(chatId,
        `✅ *Visita agendada!*\n\n👤 ${state.data.clienteNome}\n🏠 ${state.data.imovel||'—'}\n📅 ${dtStr}\n\n[📅 Adicionar ao Google Calendar](${gcal})`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
  }
}

// =====================
// HANDLER GERAL DE MENSAGENS
// =====================
bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  if (msg.voice) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const comandos = [
    '/start','/novo','/imovel','/listar','/visita','/visitas','/resumo','/buscar',
    '👤 Novo Cliente','🏠 Novo Imóvel','📅 Agendar Visita','📋 Listar Clientes',
    '🗓 Próximas Visitas','📊 Resumo do Dia','🔍 Buscar Cliente'
  ];
  if (comandos.some(c => text === c || text.startsWith(c+' '))) return;
  await processarTexto(chatId, text, msg);
});

// =====================
// SERVIDOR HTTP (Render.com)
// =====================
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('🏠 REALTOR PRO CRM Bot rodando!'); }).listen(PORT, () => {
  console.log(`🏠 Bot rodando na porta ${PORT}...`);
});
