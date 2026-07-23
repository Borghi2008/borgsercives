/* ==========================================================
   BORG Services — Script Principal (Supabase Edition)
   1.  Supabase Config
   2.  Estado Global
   3.  Utilitários
   4.  Navegação entre páginas
   5.  Sidebar (mobile)
   6.  Dashboard
   7.  Clientes (CRUD)
   8.  Funcionárias (CRUD)
   9.  Agenda Semanal
   10. Serviços (CRUD)
   11. Relatórios
   12. Modais
   13. Toast
   14. Auth
   15. Init
   ========================================================== */

/* ── 1. Supabase Config ───────────────────────────────────── */
// Esta é a "anon/publishable key" — é NORMAL e seguro que apareça no
// frontend, é assim que qualquer app Supabase funciona. A segurança
// real vem das políticas RLS (ver schema_v2_seguranca.sql), não de
// esconder esta chave. Nunca colocar aqui a "service_role key".

const SUPABASE_URL = 'https://ivydplbnnpnvtwsfembg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tjDl2WjIo7M49aqmbYgTeQ_U7HVs5SE';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── 2. Estado Global ─────────────────────────────────────── */

let dados = {
  clientes:          [],
  funcionarias:      [],
  servicos:          [],
  usuarios:          [],
  produtos:          [],
  mensagens:         [],
  mensagens_internas: [],
  site_textos:       {},
  avaliacoes:        [],
  avaliacoes_chat:   [],
  cliente_servicos:   [],  // Área do Cliente: só os serviços do cliente autenticado
  cliente_mensagens:  [],  // Área do Cliente: chat com a empresa
  funcionarias_pub:   [],  // Área do Cliente: cache de funcionarias_publicas (id+nome, p/ mostrar "quem vai")
  mensagens_clientes: [],  // Painel da equipa: todas as conversas com clientes (aba "Chat com Clientes")
};

let semanaOffset = 0;
let authUsuario  = null;
let authCliente  = null;   // linha de "clientes" ligada à sessão atual, se for uma conta de cliente
let acaoPendente = null;
let chatClienteAlvoId = null; // id do cliente cuja conversa a equipa tem aberta (aba "Chat com Clientes")

// Mesma hierarquia usada nas Funcionárias (NIVEIS_FUNCIONARIA), para não haver
// confusão entre o "cargo" da funcionária (rótulo) e o "papel" do usuário (permissões).
const PAPEL_HIERARQUIA = ['Administrador', 'Gestor', 'Supervisor', 'Assistente', 'Auxiliar'];

// Normaliza papéis antigos ou femininos para a forma canónica
function normalizarPapel(papel) {
  if (!papel) return 'Colaborador';
  // Administradora → Administrador (registo antigo com género)
  if (/^administrador[a]?$/i.test(papel)) return 'Administrador';
  // Gestor(a) → Gestor
  if (/^gestor[a]?$/i.test(papel)) return 'Gestor';
  // Supervisor(a) → Supervisor
  if (/^supervisor[a]?$/i.test(papel)) return 'Supervisor';
  return papel;
}

function papelNivel(papel) {
  const normalizado = normalizarPapel(papel);
  const idx = PAPEL_HIERARQUIA.indexOf(normalizado);
  // Papéis desconhecidos (Colaborador, etc.) ficam abaixo de todos → nível máx + 1
  return idx === -1 ? PAPEL_HIERARQUIA.length + 1 : idx;
}

// Páginas que cada papel (abaixo de Gestor) pode ver.
// Administrador e Gestor não entram aqui — têm sempre acesso total.
// Papéis desconhecidos (ex: 'Colaborador' à espera de cargo) não têm
// nenhuma página própria e ficam presos à Área do Colaborador.
const PAGINAS_POR_PAPEL = {
  Supervisor: ['agenda', 'produtos', 'mensagens', 'avaliacoes'],
  Assistente: ['agenda', 'produtos', 'avaliacoes'],
  Auxiliar:   ['agenda', 'produtos', 'avaliacoes'],
};

function paginasPermitidasPara(papel) {
  const normalizado = normalizarPapel(papel);
  return PAGINAS_POR_PAPEL[normalizado] || [];
}

/* ── Loading Overlay ──────────────────────────────────────── */

function mostrarLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.style.display = 'flex';
}

function esconderLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.style.display = 'none';
}

/* ── Carregar todos os dados do Supabase ──────────────────── */

async function carregarDados() {
  const [resC, resF, resS, resU, resP, resM, resST, resAv, resAvC, resMI, resMC] = await Promise.all([
    sb.from('clientes').select('*').order('created_at', { ascending: true }),
    sb.from('funcionarias').select('*').order('created_at', { ascending: true }),
    sb.from('servicos').select('*').order('created_at', { ascending: true }),
    sb.from('perfis').select('*').order('created_at', { ascending: true }),
    sb.from('produtos').select('*').order('ordem', { ascending: true }),
    sb.from('contactos').select('*').order('created_at', { ascending: false }),
    sb.from('site_textos').select('*'),
    sb.from('avaliacoes').select('*').order('created_at', { ascending: false }),
    sb.from('avaliacoes_chat').select('*').order('created_at', { ascending: true }),
    sb.from('mensagens_internas').select('*').order('created_at', { ascending: true }),
    sb.from('mensagens_clientes').select('*').order('created_at', { ascending: true }),
  ]);

  dados.clientes     = resC.data || [];
  dados.funcionarias = resF.data || [];
  dados.usuarios     = resU.data || [];
  dados.produtos     = resP.data || [];
  dados.mensagens    = resM.data || [];
  dados.avaliacoes   = resAv.data || [];
  dados.avaliacoes_chat    = resAvC.data || [];
  dados.mensagens_internas = resMI.data || [];
  dados.mensagens_clientes = resMC.data || [];

  // site_textos: array → mapa {chave: valor}
  dados.site_textos = {};
  (resST.data || []).forEach(t => { dados.site_textos[t.chave] = t.valor; });

  // snake_case → camelCase para serviços
  dados.servicos = (resS.data || []).map(s => ({
    ...s,
    clienteId:     s.cliente_id,
    funcionariaId: s.funcionaria_id,
    semanaOffset:  s.semana_offset,
  }));

  // Clientes/Funcionárias/Serviços/Perfis exigem sessão iniciada (RLS).
  // Para um visitante anónimo isto vem vazio de propósito — é o
  // comportamento esperado, não um bug, por isso nunca bloqueia o site.
  if (resC.error) console.warn('Clientes: ',     resC.error.message);
  if (resF.error) console.warn('Funcionárias: ', resF.error.message);
  if (resS.error) console.warn('Serviços: ',     resS.error.message);
  if (resU.error) console.warn('Perfis: ',       resU.error.message);
  // Falhas em tabelas opcionais não bloqueiam o site
  if (resP.error)   console.warn('Produtos: ',         resP.error.message);
  if (resM.error)   console.warn('Mensagens: ',        resM.error.message);
  if (resST.error)  console.warn('Site textos: ',      resST.error.message);
  if (resAv.error)  console.warn('Avaliações: ',       resAv.error.message);
  if (resAvC.error) console.warn('Chat avaliações: ',  resAvC.error.message);
  if (resMI.error)  console.warn('Chat interno: ',     resMI.error.message);
}

/* ── 3. Utilitários ───────────────────────────────────────── */

function gerarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const CORES = [
  '#3B82F6','#10B981','#F59E0B','#EF4444',
  '#8B5CF6','#06B6D4','#EC4899','#F97316',
];

function corPorIndice(i) { return CORES[i % CORES.length]; }

function corFuncionaria(id) {
  const i = dados.funcionarias.findIndex(f => f.id === id);
  return corPorIndice(i === -1 ? 0 : i);
}

function calcularDiferencaHoras(inicio, fim) {
  if (!inicio || !fim) return 0;
  const [hi, mi] = inicio.split(':').map(Number);
  const [hf, mf] = fim.split(':').map(Number);
  const diff = (hf * 60 + mf) - (hi * 60 + mi);
  return diff > 0 ? diff / 60 : 0;
}

function formatarHoras(h) {
  if (!h) return '0h';
  const horas = Math.floor(h);
  const mins  = Math.round((h - horas) * 60);
  return mins > 0 ? `${horas}h${String(mins).padStart(2,'0')}m` : `${horas}h`;
}

function obterSegundaFeira(offset = 0) {
  const hoje    = new Date();
  const dia     = hoje.getDay();
  const diff    = (dia === 0 ? -6 : 1 - dia);
  const segunda = new Date(hoje);
  segunda.setDate(hoje.getDate() + diff + offset * 7);
  segunda.setHours(0, 0, 0, 0);
  return segunda;
}

function diasDaSemana(segunda) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(segunda);
    d.setDate(segunda.getDate() + i);
    return d;
  });
}

const NOMES_DIAS      = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];

function safeCreateIcons() {
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function iniciais(nome) {
  return nome.trim().split(' ').slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

/* ── 4. Navegação entre Páginas ───────────────────────────── */

function irParaPagina(pagina) {
  // Colaboradores só podem ir a páginas permitidas para o seu cargo;
  // sem cargo reconhecido (ou sem sessão), ficam presos à Área do Colaborador.
  if (estaAutenticado() && !usuarioEhGestorPlus() && pagina !== 'colaborador') {
    const permitidas = paginasPermitidasPara(authUsuario.papel);
    if (!permitidas.includes(pagina)) pagina = 'colaborador';
  }

  localStorage.setItem('lg_pagina_ativa', pagina);

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pagina);
  });

  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === 'page-' + pagina);
  });

  const titulos = {
    relatorios:   'Relatórios',
    colaborador:  'Área do Colaborador',
    clientes:     'Clientes',
    funcionarias: 'Funcionárias',
    configuracao: 'Configuração',
    agenda:       'Agenda Semanal',
    produtos:     'Produtos',
    mensagens:    'Mensagens',
    avaliacoes:   'Avaliações',
  };
  document.getElementById('topbarTitle').textContent = titulos[pagina] || '';

  // 'relatorios' é a página que contém tanto o dashboard como os relatórios
  if (pagina === 'relatorios')   { renderDashboard(); renderRelatorios(); }
  if (pagina === 'clientes')     renderClientes();
  if (pagina === 'funcionarias') renderFuncionarias();
  if (pagina === 'configuracao') renderConfiguracao();
  if (pagina === 'agenda')       renderAgenda();
  if (pagina === 'produtos')     renderProdutos();
  if (pagina === 'mensagens')    renderMensagens();
  if (pagina === 'colaborador')  renderColaboradorArea();
  if (pagina === 'avaliacoes')   renderAvaliacoes();

  fecharSidebar();
}

/* ── 5. Sidebar Mobile ────────────────────────────────────── */

function fecharSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('show');
});

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => irParaPagina(btn.dataset.page));
});

const loginHeaderButton = document.getElementById('btnLoginHeader');
if (loginHeaderButton) {
  loginHeaderButton.addEventListener('click', () => {
    if (estaAutenticado()) abrirModalPerfil();
    else abrirLogin();
  });
}

/* ── 6. Dashboard ─────────────────────────────────────────── */

function renderDashboard() {
  const segunda  = obterSegundaFeira(0);
  const dias     = diasDaSemana(segunda);
  const servicos = servicosDaSemana(0);

  document.getElementById('stat-servicos').textContent     = servicos.length;
  document.getElementById('stat-clientes').textContent     = dados.clientes.length;
  document.getElementById('stat-funcionarias').textContent = dados.funcionarias.length;

  const totalHoras = servicos.reduce((acc, s) => acc + calcularDiferencaHoras(s.inicio, s.fim), 0);
  document.getElementById('stat-horas').textContent = formatarHoras(totalHoras);

  const hoje = new Date();
  document.getElementById('today-date').textContent =
    hoje.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });

  const containerFunc = document.getElementById('horas-funcionarias');
  if (!dados.funcionarias.length) {
    containerFunc.innerHTML = `<div class="empty-state-small">
      <i data-lucide="user-x"></i><p>Sem funcionárias registadas</p></div>`;
  } else {
    const horasPorFunc = {};
    dados.funcionarias.forEach(f => { horasPorFunc[f.id] = 0; });
    servicos.forEach(s => {
      if (horasPorFunc[s.funcionariaId] !== undefined)
        horasPorFunc[s.funcionariaId] += calcularDiferencaHoras(s.inicio, s.fim);
    });
    const maxH = Math.max(...Object.values(horasPorFunc), 1);

    containerFunc.innerHTML = dados.funcionarias.map((f, i) => {
      const h   = horasPorFunc[f.id] || 0;
      const pct = Math.round((h / maxH) * 100);
      const cor = corPorIndice(i);
      return `
        <div class="funcionaria-row">
          <div class="func-avatar-sm" style="background:${cor}">${iniciais(f.nome)}</div>
          <span class="func-name-sm">${f.nome}</span>
          <div class="func-bar-wrap">
            <div class="func-bar" style="width:${pct}%;background:${cor}"></div>
          </div>
          <span class="func-horas">${formatarHoras(h)}</span>
        </div>`;
    }).join('');
  }

  const diaHoje = hoje.getDay();
  const idxHoje = diaHoje === 0 ? 6 : diaHoje - 1;
  const containerHoje = document.getElementById('servicos-hoje');
  const servicosHoje  = servicos.filter(s => Number(s.dia) === idxHoje);

  if (!servicosHoje.length) {
    containerHoje.innerHTML = `<div class="empty-state-small">
      <i data-lucide="calendar-x"></i><p>Sem serviços hoje</p></div>`;
  } else {
    servicosHoje.sort((a, b) => a.inicio.localeCompare(b.inicio));
    containerHoje.innerHTML = servicosHoje.map(s => {
      const cliente = dados.clientes.find(c => c.id === s.clienteId);
      const func    = dados.funcionarias.find(f => f.id === s.funcionariaId);
      return `
        <div class="servico-hoje-item">
          <div class="servico-dot"></div>
          <div class="servico-info-sm">
            <span class="s-cliente">${cliente?.nome || '—'}</span>
            <span class="s-func">${func?.nome || '—'}</span>
          </div>
          <span class="servico-horario">${s.inicio}–${s.fim}</span>
        </div>`;
    }).join('');
  }

  safeCreateIcons();
}

/* ── 7. Clientes (CRUD) ───────────────────────────────────── */

function renderClientes() {
  const filtro = (document.getElementById('searchClientes')?.value || '').toLowerCase();
  const lista  = dados.clientes.filter(c =>
    c.nome.toLowerCase().includes(filtro) ||
    (c.telefone || '').includes(filtro)   ||
    (c.morada   || '').toLowerCase().includes(filtro)
  );

  const tbody = document.getElementById('tabela-clientes');
  const empty = document.getElementById('clientes-empty');

  if (!lista.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = lista.map(c => `
      <tr class="clickable-row" onclick="abrirModalCliente('${c.id}')">
        <td><strong>${c.nome}</strong> ${c.usuario_id ? '<span class="badge-conta" title="Tem conta no Portal do Cliente">Portal</span>' : ''}</td>
        <td>${c.telefone ? `<a href="tel:${c.telefone}" style="color:var(--color-accent-dark)">${c.telefone}</a>` : '—'}</td>
        <td>${c.morada || '—'}</td>
        <td><span class="obs-text">${c.obs || '—'}</span></td>
      </tr>`).join('');
  }
  safeCreateIcons();
}

function abrirModalCliente(id) {
  document.getElementById('cliente-id').value = id || '';
  document.getElementById('modal-cliente-title').textContent = id ? 'Editar Cliente' : 'Novo Cliente';

  const deleteBtn = document.getElementById('btn-eliminar-cliente');
  const ligarSecao = document.getElementById('ligar-conta-secao');
  document.getElementById('ligar-conta-busca').value = '';
  document.getElementById('ligar-conta-resultados').innerHTML = '';

  let cliente = null;
  if (id) {
    cliente = dados.clientes.find(c => c.id === id);
    document.getElementById('cliente-nome').value     = cliente.nome || '';
    document.getElementById('cliente-telefone').value = cliente.telefone || '';
    document.getElementById('cliente-morada').value   = cliente.morada || '';
    document.getElementById('cliente-obs').value      = cliente.obs || '';
    deleteBtn.style.display = 'inline-flex';
  } else {
    document.getElementById('cliente-nome').value     = '';
    document.getElementById('cliente-telefone').value = '';
    document.getElementById('cliente-morada').value   = '';
    document.getElementById('cliente-obs').value      = '';
    deleteBtn.style.display = 'none';
  }
  ligarSecao.style.display = (id && cliente && !cliente.usuario_id) ? 'block' : 'none';
  abrirModal('modal-cliente');
}

function buscarContasParaLigar() {
  const termo   = document.getElementById('ligar-conta-busca').value.trim().toLowerCase();
  const idAtual = document.getElementById('cliente-id').value;
  const cont    = document.getElementById('ligar-conta-resultados');

  if (termo.length < 2) { cont.innerHTML = ''; return; }

  const candidatos = dados.clientes.filter(c => c.usuario_id && c.id !== idAtual).map(c => {
    const perfil = dados.usuarios.find(u => u.id === c.usuario_id);
    return { ...c, email: perfil?.email || '' };
  }).filter(c =>
    c.nome.toLowerCase().includes(termo) ||
    (c.telefone || '').includes(termo) ||
    c.email.toLowerCase().includes(termo)
  );

  if (!candidatos.length) {
    cont.innerHTML = '<p class="chat-empty">Nenhuma conta encontrada.</p>';
    return;
  }
  cont.innerHTML = candidatos.map(c => `
    <button type="button" class="ligar-conta-item" onclick="selecionarContaParaLigar('${c.id}')">
      <strong>${c.nome}</strong>
      <span>${c.telefone || '—'} · ${c.email || '—'}</span>
    </button>`).join('');
}

async function selecionarContaParaLigar(clienteNovoId) {
  const idAtual = document.getElementById('cliente-id').value;
  const nomeAtual = document.getElementById('cliente-nome').value;
  const novo = dados.clientes.find(c => c.id === clienteNovoId);
  if (!novo) return;

  const ok = confirm(`Ligar a conta de "${novo.nome}" a este cliente ("${nomeAtual}")?\n\nO registo novo e vazio será removido; o histórico deste cliente mantém-se.`);
  if (!ok) return;

  const { error } = await sb.rpc('merge_cliente_conta', {
    cliente_antigo_id: idAtual,
    cliente_novo_id:   clienteNovoId,
  });
  if (error) { mostrarToast('Erro ao ligar conta: ' + error.message, 'error'); return; }

  mostrarToast('Conta ligada com sucesso!', 'success');
  fecharModal('modal-cliente');
  await carregarDados();
  renderClientes();
}

async function salvarCliente() {
  const nome = document.getElementById('cliente-nome').value.trim();
  if (!nome) { mostrarToast('O nome é obrigatório.', 'error'); return; }

  const id  = document.getElementById('cliente-id').value;
  const obj = {
    nome,
    telefone: document.getElementById('cliente-telefone').value.trim(),
    morada:   document.getElementById('cliente-morada').value.trim(),
    obs:      document.getElementById('cliente-obs').value.trim(),
  };

  if (id) {
    const { error } = await sb.from('clientes').update(obj).eq('id', id);
    if (error) { mostrarToast('Erro ao atualizar cliente.', 'error'); return; }
    const idx = dados.clientes.findIndex(c => c.id === id);
    dados.clientes[idx] = { ...dados.clientes[idx], ...obj };
    mostrarToast('Cliente atualizado com sucesso!', 'success');
  } else {
    const newId = gerarId();
    const { error } = await sb.from('clientes').insert({ id: newId, ...obj });
    if (error) { mostrarToast('Erro ao adicionar cliente.', 'error'); return; }
    dados.clientes.push({ id: newId, ...obj });
    mostrarToast('Cliente adicionado com sucesso!', 'success');
  }
  fecharModal('modal-cliente');
  renderClientes();
  safeCreateIcons();
}

/* ── 8. Funcionárias (CRUD) ───────────────────────────────── */

function renderFuncionarias() {
  const grid  = document.getElementById('grid-funcionarias');
  const empty = document.getElementById('funcionarias-empty');
  const servicosSemana = servicosDaSemana(0);

  if (!dados.funcionarias.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    const ordenadas = [...dados.funcionarias].sort((a, b) => (b.nivel || 0) - (a.nivel || 0));
    grid.innerHTML = ordenadas.map((f, i) => {
      const cor   = corPorIndice(i);
      const horas = servicosSemana
        .filter(s => s.funcionariaId === f.id)
        .reduce((acc, s) => acc + calcularDiferencaHoras(s.inicio, s.fim), 0);
      return `
        <div class="func-card" onclick="abrirModalFuncionaria('${f.id}')">
          <div class="func-card-avatar" style="background:${cor}">${iniciais(f.nome)}</div>
          <div class="func-card-name">${f.nome}</div>
          <div class="func-card-role">${f.cargo || 'Sem cargo'}</div>
          <div class="func-card-contact">${f.contacto || 'Sem contacto'}</div>
          <div class="func-card-stat">
            <i data-lucide="clock" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>
            ${formatarHoras(horas)} esta semana
          </div>
        </div>`;
    }).join('');
  }
  safeCreateIcons();
}

const NIVEIS_FUNCIONARIA = [
  { value: 5, label: 'Administrador' },
  { value: 4, label: 'Gestor' },
  { value: 3, label: 'Supervisor' },
  { value: 2, label: 'Assistente' },
  { value: 1, label: 'Auxiliar' },
];

function abrirModalFuncionaria(id) {
  document.getElementById('funcionaria-id').value = id || '';
  document.getElementById('modal-funcionaria-title').textContent = id ? 'Editar Funcionária' : 'Nova Funcionária';

  const selUsuario = document.getElementById('funcionaria-usuario');
  if (selUsuario) {
    selUsuario.innerHTML = '<option value="">Sem conta vinculada</option>' +
      dados.usuarios.map(u => `<option value="${u.id}">${u.nome} (${normalizarPapel(u.papel)})</option>`).join('');
  }

  const deleteBtn = document.getElementById('btn-eliminar-funcionaria');
  if (id) {
    const f = dados.funcionarias.find(f => f.id === id);
    document.getElementById('funcionaria-nome').value     = f.nome || '';
    document.getElementById('funcionaria-contacto').value = f.contacto || '';
    document.getElementById('funcionaria-nivel').value    = f.nivel || '';
    if (selUsuario) selUsuario.value = f.usuario_id || '';
    deleteBtn.style.display = 'inline-flex';
  } else {
    document.getElementById('funcionaria-nome').value     = '';
    document.getElementById('funcionaria-contacto').value = '';
    document.getElementById('funcionaria-nivel').value    = '';
    if (selUsuario) selUsuario.value = '';
    deleteBtn.style.display = 'none';
  }
  abrirModal('modal-funcionaria');
}

// Ao escolher uma conta de login no modal de Funcionárias, preenche
// automaticamente o Nome e o Cargo com os dados dessa conta.
function autoPreencherFuncionariaPorUsuario() {
  const selUsuario = document.getElementById('funcionaria-usuario');
  const usuarioId  = selUsuario?.value;
  if (!usuarioId) return;

  const u = dados.usuarios.find(u => u.id === usuarioId);
  if (!u) return;

  const nomeInput = document.getElementById('funcionaria-nome');
  if (nomeInput) nomeInput.value = u.nome || nomeInput.value;

  const papel      = normalizarPapel(u.papel);
  const nivelInfo  = NIVEIS_FUNCIONARIA.find(n => n.label === papel);
  const nivelSelect = document.getElementById('funcionaria-nivel');
  if (nivelSelect && nivelInfo) nivelSelect.value = nivelInfo.value;
}

async function salvarFuncionaria() {
  const nome = document.getElementById('funcionaria-nome').value.trim();
  if (!nome) { mostrarToast('O nome é obrigatório.', 'error'); return; }

  const id         = document.getElementById('funcionaria-id').value;
  const nivel      = Number(document.getElementById('funcionaria-nivel').value);
  const cargo      = NIVEIS_FUNCIONARIA.find(n => n.value === nivel)?.label || '';
  const usuarioId  = document.getElementById('funcionaria-usuario')?.value || null;
  const obj   = {
    nome,
    contacto: document.getElementById('funcionaria-contacto').value.trim(),
    nivel,
    cargo,
    usuario_id: usuarioId || null,
  };

  if (id) {
    const { error } = await sb.from('funcionarias').update(obj).eq('id', id);
    if (error) { mostrarToast('Erro ao atualizar funcionária.', 'error'); return; }
    const idx = dados.funcionarias.findIndex(f => f.id === id);
    dados.funcionarias[idx] = { ...dados.funcionarias[idx], ...obj };
    mostrarToast('Funcionária atualizada!', 'success');
  } else {
    const newId = gerarId();
    const { error } = await sb.from('funcionarias').insert({ id: newId, ...obj });
    if (error) { mostrarToast('Erro ao adicionar funcionária.', 'error'); return; }
    dados.funcionarias.push({ id: newId, ...obj });
    mostrarToast('Funcionária adicionada!', 'success');
  }
  fecharModal('modal-funcionaria');
  renderFuncionarias();
  safeCreateIcons();
}

/* ── 9. Agenda Semanal ────────────────────────────────────── */

function servicosDaSemana(offset) {
  return dados.servicos.filter(s => s.semanaOffset === offset);
}

function renderAgenda() {
  const segunda = obterSegundaFeira(semanaOffset);
  const dias    = diasDaSemana(segunda);
  const hoje    = new Date(); hoje.setHours(0, 0, 0, 0);

  const fmt = d => d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
  document.getElementById('semana-label').textContent = `${fmt(dias[0])} – ${fmt(dias[6])}`;

  const container = document.getElementById('agenda-container');
  container.innerHTML = '';

  const cellVazio = document.createElement('div');
  cellVazio.className = 'agenda-header-cell';
  cellVazio.textContent = 'Funcionária';
  container.appendChild(cellVazio);

  dias.forEach((d, i) => {
    const celula  = document.createElement('div');
    const isHoje  = d.getTime() === hoje.getTime();
    celula.className = 'agenda-header-cell' + (isHoje ? ' hoje' : '');
    celula.textContent = NOMES_DIAS[i];
    container.appendChild(celula);
  });

  if (!dados.funcionarias.length) {
    const msg = document.createElement('div');
    msg.style.gridColumn = '1 / -1';
    msg.innerHTML = `<div class="empty-state">
      <i data-lucide="users"></i>
      <h3>Sem funcionárias</h3>
      <p>Adicione funcionárias para organizar a agenda</p>
    </div>`;
    container.appendChild(msg);
    safeCreateIcons();
    return;
  }

  dados.funcionarias.forEach((f, fi) => {
    const cor = corPorIndice(fi);

    const nomeCell = document.createElement('div');
    nomeCell.className = 'agenda-func-name';
    nomeCell.innerHTML = `
      <div class="func-avatar-sm" style="background:${cor}">${iniciais(f.nome)}</div>
      <span>${f.nome.split(' ')[0]}</span>`;
    container.appendChild(nomeCell);

    const podeEditar = podeEditarAgendaDe(f.id);

    dias.forEach((d, di) => {
      const isHoje = d.getTime() === hoje.getTime();
      const cell   = document.createElement('div');
      cell.className = 'agenda-cell' + (isHoje ? ' hoje-col' : '');

      const servicosCelula = dados.servicos
        .filter(s =>
          s.funcionariaId === f.id &&
          Number(s.dia)   === di   &&
          s.semanaOffset  === semanaOffset
        )
        .sort((a, b) => a.inicio.localeCompare(b.inicio));

      servicosCelula.forEach(s => {
        const cliente = dados.clientes.find(c => c.id === s.clienteId);
        const horas   = calcularDiferencaHoras(s.inicio, s.fim);
        const card    = document.createElement('div');
        card.className = 'servico-card' + (podeEditar ? '' : ' sem-permissao');
        card.innerHTML = `
          <span class="sc-horas">${formatarHoras(horas)}</span>
          <span class="sc-cliente">${cliente?.nome || '—'}</span>
          <span class="sc-horario">
            <i data-lucide="clock"></i>${s.inicio}–${s.fim}
          </span>
          ${podeEditar ? `<button class="sc-del" onclick="eliminarServico('${s.id}',event)" title="Eliminar">
            <i data-lucide="x"></i>
          </button>` : ''}`;
        if (podeEditar) card.addEventListener('click', () => abrirModalServico(s.id));
        cell.appendChild(card);
      });

      if (podeEditar) {
        const addBtn = document.createElement('button');
        addBtn.className = 'cell-add-btn';
        addBtn.innerHTML = `<i data-lucide="plus"></i> Serviço`;
        addBtn.addEventListener('click', () => abrirModalServico(null, f.id, di));
        cell.appendChild(addBtn);
      }

      container.appendChild(cell);
    });
  });

  safeCreateIcons();
}

document.getElementById('semanaAnterior').addEventListener('click', () => {
  semanaOffset--;
  renderAgenda();
});
document.getElementById('semanaProxima').addEventListener('click', () => {
  semanaOffset++;
  renderAgenda();
});

/* ── 10. Serviços (CRUD) ──────────────────────────────────── */

function abrirModalServico(id, funcId, diaIdx) {
  const selCliente = document.getElementById('servico-cliente');
  const selFunc    = document.getElementById('servico-funcionaria');

  selCliente.innerHTML = '<option value="">Selecionar cliente...</option>' +
    dados.clientes.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
  selFunc.innerHTML = '<option value="">Selecionar funcionária...</option>' +
    dados.funcionarias.map(f => `<option value="${f.id}">${f.nome}</option>`).join('');

  document.getElementById('servico-id').value = id || '';
  document.getElementById('horas-calculadas').style.display = 'none';

  // Repor todos os botões de dia (desselecionar)
  document.querySelectorAll('#dias-selecao .dia-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  if (id) {
    const s = dados.servicos.find(s => s.id === id);
    document.getElementById('modal-servico-title').textContent = 'Editar Serviço';
    selCliente.value = s.clienteId || '';
    selFunc.value    = s.funcionariaId || '';
    selFunc.disabled = false;
    // Selecionar o dia do serviço existente
    const diaBtn = document.querySelector(`#dias-selecao .dia-btn[data-dia="${s.dia}"]`);
    if (diaBtn) diaBtn.classList.add('active');
    document.getElementById('servico-inicio').value = s.inicio || '';
    document.getElementById('servico-fim').value    = s.fim || '';
    calcularHoras();
  } else {
    document.getElementById('modal-servico-title').textContent = 'Novo Serviço';
    selCliente.value = '';
    selFunc.value    = funcId || '';
    selFunc.disabled = Boolean(funcId);
    // Pré-selecionar o dia se veio da agenda
    if (diaIdx !== undefined) {
      const diaBtn = document.querySelector(`#dias-selecao .dia-btn[data-dia="${diaIdx}"]`);
      if (diaBtn) diaBtn.classList.add('active');
    }
    document.getElementById('servico-inicio').value = '';
    document.getElementById('servico-fim').value    = '';
  }

  abrirModal('modal-servico');
}

// Toggle de selecção de dias no modal de serviço
document.addEventListener('click', e => {
  if (e.target.closest('#dias-selecao .dia-btn')) {
    e.target.closest('.dia-btn').classList.toggle('active');
  }
});

function calcularHoras() {
  const inicio = document.getElementById('servico-inicio').value;
  const fim    = document.getElementById('servico-fim').value;
  const el     = document.getElementById('horas-calculadas');
  const txt    = document.getElementById('horas-calculadas-text');

  if (inicio && fim) {
    const h = calcularDiferencaHoras(inicio, fim);
    if (h > 0) {
      txt.textContent      = `Total: ${formatarHoras(h)}`;
      el.style.display     = 'flex';
      el.style.background  = '#F0FDF4';
      el.style.borderColor = '#BBF7D0';
      el.style.color       = '#065F46';
    } else {
      txt.textContent      = 'A hora de fim deve ser posterior à de início.';
      el.style.display     = 'flex';
      el.style.background  = '#FEF2F2';
      el.style.borderColor = '#FECACA';
      el.style.color       = '#991B1B';
      return;
    }
  } else {
    el.style.display = 'none';
  }
}

async function salvarServico() {
  const clienteId     = document.getElementById('servico-cliente').value;
  const funcionariaId = document.getElementById('servico-funcionaria').value;
  const inicio        = document.getElementById('servico-inicio').value;
  const fim           = document.getElementById('servico-fim').value;

  // Ler dias seleccionados dos botões (substitui o antigo <select id="servico-dia">)
  const diasAtivos = [...document.querySelectorAll('#dias-selecao .dia-btn.active')];
  const diasSelecionados = diasAtivos.map(b => Number(b.dataset.dia));

  if (!clienteId || !funcionariaId || diasSelecionados.length === 0 || !inicio || !fim) {
    mostrarToast('Preencha todos os campos e seleccione pelo menos um dia.', 'error');
    return;
  }
  if (!podeEditarAgendaDe(funcionariaId)) {
    mostrarToast('Não tem permissão para editar a agenda desta funcionária/o.', 'error');
    return;
  }
  if (calcularDiferencaHoras(inicio, fim) <= 0) {
    mostrarToast('A hora de fim deve ser posterior à de início.', 'error');
    return;
  }

  const id = document.getElementById('servico-id').value;

  if (id) {
    // Edição: usa o primeiro dia seleccionado
    const dia = diasSelecionados[0];
    const dbObj = {
      cliente_id:     clienteId,
      funcionaria_id: funcionariaId,
      dia,
      inicio,
      fim,
      semana_offset:  semanaOffset,
    };
    const { error } = await sb.from('servicos').update(dbObj).eq('id', id);
    if (error) { mostrarToast('Erro ao atualizar serviço.', 'error'); return; }
    const idx = dados.servicos.findIndex(s => s.id === id);
    dados.servicos[idx] = { ...dados.servicos[idx], ...dbObj, clienteId, funcionariaId, semanaOffset };
    mostrarToast('Serviço atualizado!', 'success');
  } else {
    // Novo: cria um registo por cada dia seleccionado
    for (const dia of diasSelecionados) {
      const newId = gerarId();
      const dbObj = {
        id: newId,
        cliente_id:     clienteId,
        funcionaria_id: funcionariaId,
        dia,
        inicio,
        fim,
        semana_offset:  semanaOffset,
      };
      const { error } = await sb.from('servicos').insert(dbObj);
      if (error) { mostrarToast('Erro ao adicionar serviço.', 'error'); return; }
      dados.servicos.push({
        ...dbObj,
        clienteId,
        funcionariaId,
        semanaOffset,
      });
    }
    const label = diasSelecionados.length > 1
      ? `${diasSelecionados.length} serviços adicionados!`
      : 'Serviço adicionado!';
    mostrarToast(label, 'success');
  }

  fecharModal('modal-servico');
  renderAgenda();
  if (document.getElementById('page-relatorios')?.classList.contains('active')) {
    renderDashboard();
  }
}

function eliminarServico(id, evento) {
  evento.stopPropagation();
  confirmarEliminar('servico', id);
}

/* ── 10.1 Produtos (CRUD) ──────────────────────────────────── */

function renderProdutos() {
  const grid  = document.getElementById('produtos-grid');
  const empty = document.getElementById('produtos-empty');
  const podeGerir = usuarioEhGestorPlus();

  if (!dados.produtos.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = dados.produtos.map(p => `
      <div class="produto-card-app">
        <div class="produto-card-app-actions" style="display:${podeGerir ? 'flex' : 'none'}">
          <button class="produto-action-btn produto-action-edit" onclick="abrirModalProduto('${p.id}')" title="Editar">
            <i data-lucide="edit-3"></i>
          </button>
          <button class="produto-action-btn produto-action-del" onclick="confirmarEliminar('produto','${p.id}')" title="Eliminar">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        <div class="produto-card-app-img">
          ${p.imagem_url
            ? `<img src="${p.imagem_url}" alt="${p.nome}" onerror="this.parentElement.textContent='📦'" />`
            : '📦'}
        </div>
        <div class="produto-card-app-body">
          <div class="produto-card-app-nome">${p.nome}</div>
          <div class="produto-card-app-desc">${p.descricao || 'Sem descrição.'}</div>
          ${(p.link_compra || '').split(',').map(l => l.trim()).filter(Boolean).map(l => `
            <a href="${l}" target="_blank" rel="noopener noreferrer" class="produto-card-app-link">
              <i data-lucide="external-link"></i> Ver na loja
            </a>`).join(' ')}
        </div>
      </div>`).join('');
  }

  document.querySelectorAll('#btn-add-produto, #produtos-empty .btn-primary').forEach(btn => {
    btn.style.display = podeGerir ? 'inline-flex' : 'none';
  });

  safeCreateIcons();
}

function renderPublicProdutos() {
  const grid = document.getElementById('pub-produtos-grid');
  if (!grid) return;

  if (!dados.produtos.length) {
    grid.innerHTML = `
      <div class="pub-prod-empty" id="pub-prod-empty">
        <i data-lucide="package"></i>
        <p>Nenhum produto adicionado ainda</p>
      </div>`;
  } else {
    grid.innerHTML = dados.produtos.map(p => {
      const links = (p.link_compra || '').split(',').map(l => l.trim()).filter(Boolean);
      return `
        <div class="pub-produto-card">
          <div class="pub-produto-img">
            ${p.imagem_url
              ? `<img src="${p.imagem_url}" alt="${p.nome}" onerror="this.parentElement.textContent='📦'" />`
              : '📦'}
          </div>
          <div class="pub-produto-body">
            <div class="pub-produto-nome">${p.nome}</div>
            <div class="pub-produto-desc">${p.descricao || ''}</div>
            ${links.map(l => `
              <a href="${l}" target="_blank" rel="noopener noreferrer" class="pub-produto-link">
                <i data-lucide="external-link"></i> Ver Produto
              </a>`).join(' ')}
          </div>
        </div>`;
    }).join('');
  }
  safeCreateIcons();
}

function abrirModalProduto(id) {
  definirEstadoProcessamentoImagem(false);
  document.getElementById('produto-id').value = id || '';
  document.getElementById('modal-produto-title').textContent = id ? 'Editar Produto' : 'Novo Produto';

  const deleteBtn = document.getElementById('btn-eliminar-produto');
  if (id) {
    const p = dados.produtos.find(p => p.id === id);
    document.getElementById('produto-nome').value      = p?.nome || '';
    document.getElementById('produto-descricao').value = p?.descricao || '';
    document.getElementById('produto-imagem').value    = p?.imagem_url || '';
    document.getElementById('produto-link').value      = p?.link_compra || '';
    document.getElementById('produto-ordem').value      = p?.ordem ?? '';
    definirPreviewProdutoImagem(p?.imagem_url || '');
    deleteBtn.style.display = 'inline-flex';
  } else {
    document.getElementById('produto-nome').value      = '';
    document.getElementById('produto-descricao').value = '';
    document.getElementById('produto-imagem').value    = '';
    document.getElementById('produto-link').value      = '';
    document.getElementById('produto-ordem').value      = '';
    definirPreviewProdutoImagem('');
    deleteBtn.style.display = 'none';
  }
  document.getElementById('produto-imagem-file').value = '';
  abrirModal('modal-produto');
}

// Mostra/esconde a pré-visualização da foto do produto no modal
function definirPreviewProdutoImagem(dataUrlOuVazio) {
  const img    = document.getElementById('produto-imagem-preview');
  const icon   = document.getElementById('produto-imagem-preview-icon');
  const remover = document.getElementById('produto-imagem-remover');
  if (dataUrlOuVazio) {
    img.src = dataUrlOuVazio;
    img.style.display = 'block';
    icon.style.display = 'none';
    remover.style.display = 'inline';
  } else {
    img.src = '';
    img.style.display = 'none';
    icon.style.display = 'block';
    remover.style.display = 'none';
  }
}

// Enquanto a foto está a ser lida/comprimida, bloqueia o botão Guardar
// para não deixar o produto ser gravado sem imagem por engano (o
// processamento é assíncrono e nunca deve ser mais rápido que um clique).
function definirEstadoProcessamentoImagem(aProcessar) {
  const guardarBtn = document.getElementById('btn-guardar-produto');
  const nota       = document.getElementById('produto-imagem-nota');
  if (guardarBtn) guardarBtn.disabled = aProcessar;
  if (nota) {
    nota.textContent = aProcessar
      ? 'A preparar a foto, aguarda um instante…'
      : 'Escolhe uma foto do telemóvel ou computador (opcional).';
  }
}

// Lê a foto escolhida do dispositivo, redimensiona/comprime para caber
// numa imagem web razoável, e guarda como data URL no campo escondido
// (o mesmo campo #produto-imagem que antes recebia a URL manual — por
// isso salvarProduto() não precisa de nenhuma alteração).
const PRODUTO_IMAGEM_MAX_LADO = 600;
const PRODUTO_IMAGEM_QUALIDADE = 0.82;

function handleProdutoImagemFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  // Alguns browsers (sobretudo em telemóvel) podem não indicar o tipo do
  // ficheiro; só rejeitamos quando temos a certeza de que NÃO é imagem.
  if (file.type && !file.type.startsWith('image/')) {
    mostrarToast('Escolhe um ficheiro de imagem válido.', 'error');
    event.target.value = '';
    return;
  }

  definirEstadoProcessamentoImagem(true);

  const leitor = new FileReader();

  leitor.onerror = () => {
    console.error('Erro ao ler o ficheiro da foto:', leitor.error);
    mostrarToast('Não foi possível ler esse ficheiro. Tenta outra foto.', 'error');
    definirEstadoProcessamentoImagem(false);
    event.target.value = '';
  };

  leitor.onload = () => {
    const dataUrlOriginal = leitor.result;

    const imgTemp = new Image();

    imgTemp.onload = () => {
      try {
        let { width, height } = imgTemp;
        if (width > PRODUTO_IMAGEM_MAX_LADO || height > PRODUTO_IMAGEM_MAX_LADO) {
          const escala = PRODUTO_IMAGEM_MAX_LADO / Math.max(width, height);
          width  = Math.round(width * escala);
          height = Math.round(height * escala);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(imgTemp, 0, 0, width, height);
        const dataUrlFinal = canvas.toDataURL('image/jpeg', PRODUTO_IMAGEM_QUALIDADE);
        document.getElementById('produto-imagem').value = dataUrlFinal;
        definirPreviewProdutoImagem(dataUrlFinal);
      } catch (err) {
        // Se o redimensionamento falhar por algum motivo, não perdemos a
        // foto — usamos a imagem original tal como foi lida do ficheiro.
        console.error('Erro ao redimensionar a foto, a usar original:', err);
        document.getElementById('produto-imagem').value = dataUrlOriginal;
        definirPreviewProdutoImagem(dataUrlOriginal);
      } finally {
        definirEstadoProcessamentoImagem(false);
      }
    };

    imgTemp.onerror = () => {
      console.error('Não foi possível descodificar a imagem escolhida.');
      mostrarToast('Não foi possível ler essa imagem. Tenta outra foto.', 'error');
      definirEstadoProcessamentoImagem(false);
      event.target.value = '';
    };

    imgTemp.src = dataUrlOriginal;
  };

  leitor.readAsDataURL(file);
}

function removerProdutoImagem() {
  document.getElementById('produto-imagem').value = '';
  document.getElementById('produto-imagem-file').value = '';
  definirPreviewProdutoImagem('');
  definirEstadoProcessamentoImagem(false);
}

async function salvarProduto() {
  const nome = document.getElementById('produto-nome').value.trim();
  if (!nome) { mostrarToast('O nome do produto é obrigatório.', 'error'); return; }

  const id  = document.getElementById('produto-id').value;
  const obj = {
    nome,
    descricao:   document.getElementById('produto-descricao').value.trim(),
    imagem_url:  document.getElementById('produto-imagem').value.trim(),
    link_compra: document.getElementById('produto-link').value.trim(),
    ordem:       Number(document.getElementById('produto-ordem').value) || 0,
  };

  if (id) {
    const { error } = await sb.from('produtos').update(obj).eq('id', id);
    if (error) {
      console.error('Erro ao atualizar produto:', error);
      mostrarToast('Erro ao atualizar produto: ' + (error.message || 'desconhecido'), 'error');
      return;
    }
    const idx = dados.produtos.findIndex(p => p.id === id);
    dados.produtos[idx] = { ...dados.produtos[idx], ...obj };
    mostrarToast('Produto atualizado!', 'success');
  } else {
    const newId = gerarId();
    const { error } = await sb.from('produtos').insert({ id: newId, ...obj });
    if (error) {
      console.error('Erro ao adicionar produto:', error);
      mostrarToast('Erro ao adicionar produto: ' + (error.message || 'desconhecido'), 'error');
      return;
    }
    dados.produtos.push({ id: newId, ...obj });
    mostrarToast('Produto adicionado!', 'success');
  }

  dados.produtos.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  fecharModal('modal-produto');
  renderProdutos();
  renderPublicProdutos();
}

/* ── 10.2 Mensagens (Contactos do Site + Chat Interno) ────── */

let mensagensTabAtiva   = 'clientes';
let chatInternoAlvoId   = null;

function renderMensagens() {
  const gestorPlus = usuarioEhGestorPlus();
  const tabsEl = document.getElementById('mensagens-tabs');
  if (tabsEl) tabsEl.style.display = gestorPlus ? 'flex' : 'none';

  if (gestorPlus) {
    renderMensagensClientes();
    renderChatEquipaLista();
    mudarTabMensagens(mensagensTabAtiva || 'clientes');
  } else {
    mudarTabMensagens('equipa');
    if (estaAutenticado()) abrirChatInterno(authUsuario.id);
  }

  atualizarBadgeMensagens();
  safeCreateIcons();
}

function mudarTabMensagens(tab) {
  mensagensTabAtiva = tab;
  document.querySelectorAll('#mensagens-tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const elClientes = document.getElementById('mensagens-tab-clientes');
  const elEquipa   = document.getElementById('mensagens-tab-equipa');
  const elPortal   = document.getElementById('mensagens-tab-portal');
  if (elClientes) elClientes.style.display = tab === 'clientes' ? '' : 'none';
  if (elEquipa)   elEquipa.style.display   = tab === 'equipa'   ? '' : 'none';
  if (elPortal)   elPortal.style.display   = tab === 'portal'   ? '' : 'none';
  if (tab === 'equipa' && chatInternoAlvoId) abrirChatInterno(chatInternoAlvoId);
  if (tab === 'portal') { renderChatClientesLista(); if (chatClienteAlvoId) abrirChatCliente(chatClienteAlvoId); }
}

function renderMensagensClientes() {
  const lista = document.getElementById('mensagens-lista');
  const empty = document.getElementById('mensagens-empty');
  if (!lista || !empty) return;

  if (!dados.mensagens.length) {
    lista.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    lista.innerHTML = dados.mensagens.map(m => {
      const data = m.created_at
        ? new Date(m.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
      const classes = ['mensagem-card'];
      if (!m.lido) classes.push('nao-lida');
      if (m.respondido) classes.push('respondida');

      return `
        <div class="${classes.join(' ')}" onclick="abrirModalMensagem('${m.id}')">
          <div class="mensagem-card-header">
            <span class="mensagem-nome">${m.nome}</span>
            ${!m.lido ? '<span class="mensagem-badge-novo">Novo</span>' : ''}
            ${m.respondido ? '<span class="mensagem-badge-resp">Respondido</span>' : ''}
            <span class="mensagem-data">${data}</span>
          </div>
          <div class="mensagem-assunto">${m.assunto || 'Contacto Geral'}</div>
          <div class="mensagem-preview">${m.mensagem}</div>
          <div class="mensagem-contacto">
            ${m.email    ? `<span><i data-lucide="mail" style="width:12px;height:12px;vertical-align:middle"></i> ${m.email}</span>` : ''}
            ${m.telefone ? `<span><i data-lucide="phone" style="width:12px;height:12px;vertical-align:middle"></i> ${m.telefone}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }
  safeCreateIcons();
}

function atualizarBadgeMensagens() {
  const badge = document.getElementById('badge-mensagens');
  if (!badge) return;

  let naoLidas = 0;
  if (usuarioEhGestorPlus()) {
    naoLidas = dados.mensagens.filter(m => !m.lido).length +
      dados.mensagens_internas.filter(m => m.remetente === 'colaborador' && !m.lido).length +
      dados.mensagens_clientes.filter(m => m.remetente === 'cliente' && !m.lido).length;
  } else if (estaAutenticado()) {
    naoLidas = dados.mensagens_internas.filter(m => m.usuario_id === authUsuario.id && m.remetente === 'gestao' && !m.lido).length;
  }
  badge.textContent = String(naoLidas);
  badge.style.display = naoLidas > 0 ? 'inline-flex' : 'none';
}

async function carregarMensagensApp() {
  const [resM, resMI] = await Promise.all([
    sb.from('contactos').select('*').order('created_at', { ascending: false }),
    sb.from('mensagens_internas').select('*').order('created_at', { ascending: true }),
  ]);
  if (resM.error) { mostrarToast('Erro ao atualizar mensagens: ' + resM.error.message, 'error'); return; }
  dados.mensagens = resM.data || [];
  if (!resMI.error) dados.mensagens_internas = resMI.data || [];
  renderMensagens();
  mostrarToast('Mensagens atualizadas.', 'success');
}

/* ── 10.3 Chat Interno (Colaborador ↔ Gestão) ─────────────── */

// Lista de contas de colaboradores (para a gestão escolher com quem falar)
function threadsColaboradores() {
  return dados.usuarios.filter(u => papelNivel(u.papel) > papelNivel('Gestor'));
}

function renderChatEquipaLista() {
  const cont = document.getElementById('chatEquipaLista');
  if (!cont) return;

  const colaboradores = threadsColaboradores();
  if (!colaboradores.length) {
    cont.innerHTML = '<p class="chat-empty">Sem colaboradores registados.</p>';
    return;
  }

  cont.innerHTML = colaboradores.map(u => {
    const naoLidas = dados.mensagens_internas.filter(m => m.usuario_id === u.id && m.remetente === 'colaborador' && !m.lido).length;
    const ativo    = chatInternoAlvoId === u.id;
    return `
      <button class="chat-equipa-item${ativo ? ' active' : ''}" onclick="abrirChatInterno('${u.id}')">
        <span class="chat-equipa-nome">${u.nome}</span>
        <span class="chat-equipa-cargo">${normalizarPapel(u.papel)}</span>
        ${naoLidas ? `<span class="nav-badge">${naoLidas}</span>` : ''}
      </button>`;
  }).join('');
  safeCreateIcons();
}

function abrirChatInterno(usuarioId) {
  chatInternoAlvoId = usuarioId;

  const gestorPlus = usuarioEhGestorPlus();
  const titulo = document.getElementById('chat-equipa-titulo');
  if (titulo) {
    if (gestorPlus) {
      const alvo = dados.usuarios.find(u => u.id === usuarioId);
      titulo.textContent = alvo ? `Conversa com ${alvo.nome}` : 'Selecione uma conversa';
    } else {
      titulo.textContent = 'O meu chat com a Gestão';
    }
  }

  if (gestorPlus) renderChatEquipaLista();
  carregarMensagemInterna();
  marcarMensagensInternasLidas(usuarioId);
}

function carregarMensagemInterna() {
  const chat = document.getElementById('chat-equipa-msgs');
  if (!chat || !chatInternoAlvoId) return;

  const msgs = dados.mensagens_internas.filter(m => m.usuario_id === chatInternoAlvoId);
  if (!msgs.length) {
    chat.innerHTML = '<p class="chat-empty">Sem mensagens ainda. Inicie a conversa!</p>';
    return;
  }
  chat.innerHTML = msgs.map(m => {
    const hora = m.created_at
      ? new Date(m.created_at).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="chat-msg ${m.remetente === 'gestao' ? 'equipa' : 'cliente'}">
        <div class="chat-msg-autor">${m.autor_nome}</div>
        <div class="chat-msg-texto">${m.mensagem}</div>
        <div class="chat-msg-hora">${hora}</div>
      </div>`;
  }).join('');
  chat.scrollTop = chat.scrollHeight;
}

async function marcarMensagensInternasLidas(usuarioId) {
  const gestorPlus = usuarioEhGestorPlus();
  const remetenteAlvo = gestorPlus ? 'colaborador' : 'gestao';
  const naoLidas = dados.mensagens_internas.filter(m =>
    m.usuario_id === usuarioId && m.remetente === remetenteAlvo && !m.lido);
  if (!naoLidas.length) return;

  for (const m of naoLidas) {
    const { error } = await sb.from('mensagens_internas').update({ lido: true }).eq('id', m.id);
    if (!error) m.lido = true;
  }
  if (gestorPlus) renderChatEquipaLista();
  atualizarBadgeMensagens();
}

async function enviarMensagemInterna() {
  if (!estaAutenticado()) return;
  const input = document.getElementById('chat-equipa-input');
  const texto = (input?.value || '').trim();
  if (!texto) return;

  const gestorPlus  = usuarioEhGestorPlus();
  const usuarioAlvo = gestorPlus ? chatInternoAlvoId : authUsuario.id;
  if (!usuarioAlvo) { mostrarToast('Selecione uma conversa primeiro.', 'error'); return; }

  const obj = {
    id:         gerarId(),
    usuario_id: usuarioAlvo,
    remetente:  gestorPlus ? 'gestao' : 'colaborador',
    autor_nome: authUsuario.nome || (gestorPlus ? 'Gestão' : 'Colaborador'),
    mensagem:   texto,
    lido:       gestorPlus, // enviada pela gestão já fica lida por ela; do colaborador, fica por ler para a gestão
  };

  const { error } = await sb.from('mensagens_internas').insert(obj);
  if (error) { mostrarToast('Erro ao enviar mensagem.', 'error'); return; }

  dados.mensagens_internas.push({ ...obj, created_at: new Date().toISOString() });
  input.value = '';
  chatInternoAlvoId = usuarioAlvo;
  carregarMensagemInterna();
  if (gestorPlus) renderChatEquipaLista();
  atualizarBadgeMensagens();
}

async function abrirModalMensagem(id) {
  const m = dados.mensagens.find(m => m.id === id);
  if (!m) return;

  document.getElementById('mensagem-id').value = id;

  const data = m.created_at
    ? new Date(m.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  document.getElementById('mensagem-detalhe').innerHTML = `
    <h4>${m.nome}</h4>
    <div class="md-meta">${m.assunto || 'Contacto Geral'} · ${data}${m.email ? ` · ${m.email}` : ''}${m.telefone ? ` · ${m.telefone}` : ''}</div>
    <div class="md-texto">${m.mensagem}</div>
    ${m.respondido ? `
      <div class="md-resp">
        <div class="md-resp-label">A sua resposta</div>
        <div class="md-resp-texto">${m.resposta || ''}</div>
      </div>` : ''}`;
  document.getElementById('mensagem-resposta').value = m.resposta || '';

  const delBtnMsg = document.getElementById('btn-eliminar-mensagem');
  if (delBtnMsg) delBtnMsg.style.display = usuarioEhGestorPlus() ? 'inline-flex' : 'none';

  abrirModal('modal-mensagem');

  if (!m.lido) {
    const { error } = await sb.from('contactos').update({ lido: true }).eq('id', id);
    if (!error) { m.lido = true; renderMensagens(); }
  }
}

async function responderMensagem() {
  const id       = document.getElementById('mensagem-id').value;
  const resposta = document.getElementById('mensagem-resposta').value.trim();
  if (!resposta) { mostrarToast('Escreva uma resposta antes de guardar.', 'error'); return; }

  const { error } = await sb.from('contactos').update({ resposta, respondido: true, lido: true }).eq('id', id);
  if (error) { mostrarToast('Erro ao guardar resposta.', 'error'); return; }

  const m = dados.mensagens.find(m => m.id === id);
  if (m) { m.resposta = resposta; m.respondido = true; m.lido = true; }

  fecharModal('modal-mensagem');
  renderMensagens();
  mostrarToast('Resposta guardada com sucesso!', 'success');
}

/* ── 11. Relatórios ───────────────────────────────────────── */

function renderRelatorios() {
  const relFunc = document.getElementById('relatorio-funcionarias');
  if (!dados.funcionarias.length) {
    relFunc.innerHTML = `<div class="empty-state-small"><i data-lucide="user-x"></i><p>Sem funcionárias</p></div>`;
  } else {
    relFunc.innerHTML = dados.funcionarias.map((f, i) => {
      const horas = dados.servicos
        .filter(s => s.funcionariaId === f.id)
        .reduce((acc, s) => acc + calcularDiferencaHoras(s.inicio, s.fim), 0);
      const total = dados.servicos.filter(s => s.funcionariaId === f.id).length;
      const cor   = corPorIndice(i);
      return `
        <div class="relatorio-row">
          <div class="func-avatar-sm" style="background:${cor};width:28px;height:28px;font-size:10px">${iniciais(f.nome)}</div>
          <span class="rel-name">${f.nome}</span>
          <span class="rel-value">${total} serviços · ${formatarHoras(horas)}</span>
        </div>`;
    }).join('');
  }

  const relCli = document.getElementById('relatorio-clientes');
  if (!dados.clientes.length) {
    relCli.innerHTML = `<div class="empty-state-small"><i data-lucide="users"></i><p>Sem clientes</p></div>`;
  } else {
    const comServicos = dados.clientes
      .map(c => ({
        ...c,
        total: dados.servicos.filter(s => s.clienteId === c.id).length,
        horas: dados.servicos.filter(s => s.clienteId === c.id)
               .reduce((a, s) => a + calcularDiferencaHoras(s.inicio, s.fim), 0),
      }))
      .sort((a, b) => b.total - a.total);

    relCli.innerHTML = comServicos.map(c => `
      <div class="relatorio-row">
        <span class="rel-name">${c.nome}</span>
        <span class="rel-value">${c.total} serviços · ${formatarHoras(c.horas)}</span>
      </div>`).join('');
  }

  const relSem = document.getElementById('relatorio-semanal');
  const servicosSemAtual = servicosDaSemana(semanaOffset);
  const horasPorDia = Array.from({ length: 7 }, (_, i) =>
    servicosSemAtual
      .filter(s => Number(s.dia) === i)
      .reduce((acc, s) => acc + calcularDiferencaHoras(s.inicio, s.fim), 0)
  );
  const maxH = Math.max(...horasPorDia, 1);

  relSem.innerHTML = horasPorDia.map((h, i) => `
    <div class="chart-bar-col">
      <span class="chart-bar-val">${h > 0 ? formatarHoras(h) : ''}</span>
      <div class="chart-bar" style="height:${Math.round((h / maxH) * 130)}px"></div>
      <span class="chart-bar-label">${NOMES_DIAS[i]}</span>
    </div>`).join('');

  safeCreateIcons();
}

/* ── 12. Modais ───────────────────────────────────────────── */

function abrirModal(id) {
  document.getElementById(id).classList.add('open');
}

function fecharModal(id) {
  document.getElementById(id).classList.remove('open');
}

document.querySelectorAll('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => {
    if (e.target === bd) fecharModal(bd.id);
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => fecharModal(m.id));
    // Fecha o login overlay também com Escape
    const lo = document.getElementById('loginOverlay');
    if (lo && !lo.classList.contains('hidden')) fecharLogin();
  }
});

// Fecha o login ao clicar no fundo escuro fora do card
document.getElementById('loginOverlay').addEventListener('click', function(e) {
  if (e.target === this) fecharLogin();
});

function confirmarEliminar(tipo, id) {
  const msgs = {
    cliente:     'Tem a certeza que deseja eliminar este cliente? Os serviços associados também serão removidos.',
    funcionaria: 'Tem a certeza que deseja eliminar esta funcionária? Os serviços associados também serão removidos.',
    servico:     'Tem a certeza que deseja eliminar este serviço?',
    produto:     'Tem a certeza que deseja eliminar este produto? Deixará de aparecer no site público.',
    mensagem:    'Tem a certeza que deseja eliminar esta mensagem? A ação é irreversível.',
    avaliacao:   'Tem a certeza que deseja eliminar esta avaliação? O chat associado também será removido.',
  };
  document.getElementById('confirm-msg').textContent = msgs[tipo] || 'Confirmar eliminação?';
  acaoPendente = { tipo, id };
  document.getElementById('btn-confirmar-acao').onclick = executarEliminar;
  abrirModal('modal-confirmar');
}

async function executarEliminar() {
  if (!acaoPendente) return;
  const { tipo, id } = acaoPendente;

  if (tipo === 'cliente') {
    const { error } = await sb.from('clientes').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar cliente.', 'error'); return; }
    dados.clientes = dados.clientes.filter(c => c.id !== id);
    dados.servicos = dados.servicos.filter(s => s.clienteId !== id);
    fecharModal('modal-cliente');
    renderClientes();
    mostrarToast('Cliente eliminado.', 'success');
  } else if (tipo === 'funcionaria') {
    const { error } = await sb.from('funcionarias').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar funcionária.', 'error'); return; }
    dados.funcionarias = dados.funcionarias.filter(f => f.id !== id);
    dados.servicos     = dados.servicos.filter(s => s.funcionariaId !== id);
    fecharModal('modal-funcionaria');
    renderFuncionarias();
    mostrarToast('Funcionária eliminada.', 'success');
  } else if (tipo === 'servico') {
    const { error } = await sb.from('servicos').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar serviço.', 'error'); return; }
    dados.servicos = dados.servicos.filter(s => s.id !== id);
    renderAgenda();
    mostrarToast('Serviço eliminado.', 'success');
  } else if (tipo === 'produto') {
    const { error } = await sb.from('produtos').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar produto.', 'error'); return; }
    dados.produtos = dados.produtos.filter(p => p.id !== id);
    fecharModal('modal-produto');
    renderProdutos();
    renderPublicProdutos();
    mostrarToast('Produto eliminado.', 'success');
  } else if (tipo === 'mensagem') {
    const { error } = await sb.from('contactos').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar mensagem.', 'error'); return; }
    dados.mensagens = dados.mensagens.filter(m => m.id !== id);
    fecharModal('modal-mensagem');
    renderMensagens();
    mostrarToast('Mensagem eliminada.', 'success');
  } else if (tipo === 'avaliacao') {
    await sb.from('avaliacoes_chat').delete().eq('avaliacao_id', id);
    const { error } = await sb.from('avaliacoes').delete().eq('id', id);
    if (error) { mostrarToast('Erro ao eliminar avaliação.', 'error'); return; }
    dados.avaliacoes      = dados.avaliacoes.filter(a => a.id !== id);
    dados.avaliacoes_chat = dados.avaliacoes_chat.filter(c => c.avaliacao_id !== id);
    fecharModal('modal-avaliacao');
    renderAvaliacoes();
    renderPublicAvaliacoes();
    atualizarStatsPublicas();
    mostrarToast('Avaliação eliminada.', 'success');
  }

  acaoPendente = null;
  fecharModal('modal-confirmar');
  safeCreateIcons();
}

/* ── 13. Toast ────────────────────────────────────────────── */

let toastTimer;
function mostrarToast(msg, tipo = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast ' + tipo + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── 14. Auth ─────────────────────────────────────────────── */

function mostrarFormularioAuth(tipo) {
  const loginTab     = document.getElementById('loginTabBtn');
  const registerTab  = document.getElementById('registerTabBtn');
  const loginForm    = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  if (tipo === 'register') {
    loginTab.classList.remove('active');
    registerTab.classList.add('active');
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
  } else {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
  }
}

function abrirLogin() {
  mostrarFormularioAuth('login');
  document.getElementById('loginOverlay').classList.remove('hidden');
}

function fecharLogin() {
  document.getElementById('loginOverlay').classList.add('hidden');
}

async function loginUsuario() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const senha = document.getElementById('login-senha').value;

  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) { mostrarToast('Email ou senha incorretos.', 'error'); return; }

  await aplicarSessao(data.session);
  await carregarDados();
  aplicarTextosSite();
  renderPublicProdutos();
  renderPublicAvaliacoes();
  atualizarStatsPublicas();
  atualizarInterface();
  safeCreateIcons();
  fecharLogin();
  mostrarToast(`Bem-vindo${authUsuario?.nome ? ', ' + authUsuario.nome : ''}!`, 'success');
  if (authCliente) irParaApp(); // clientes vão logo para a sua Área
  // Restante fica no site público — pode clicar "Painel" quando quiser
}

async function registrarUsuario() {
  const email     = document.getElementById('reg-email').value.trim().toLowerCase();
  const username  = document.getElementById('reg-username').value.trim().toLowerCase();
  const telefone  = document.getElementById('reg-telefone').value.trim();
  const senha     = document.getElementById('reg-senha').value;
  const confirmar = document.getElementById('reg-confirmar-senha').value;

  if (!username)           { mostrarToast('O username é obrigatório.', 'error'); return; }
  if (senha.length < 6)    { mostrarToast('A senha deve ter pelo menos 6 caracteres.', 'error'); return; }
  if (senha !== confirmar) { mostrarToast('As senhas não coincidem.', 'error'); return; }

  // Nota: já não enviamos "tipo" (cliente/equipa) — a conta fica sem
  // qualquer cargo atribuído. É a equipa que decide depois, manualmente,
  // se a conta é de um cliente (ligando-a a um registo em "Clientes") ou
  // de um membro da equipa (atribuindo-lhe um cargo em "Perfis").
  const { data, error } = await sb.auth.signUp({
    email,
    password: senha,
    options: { data: { nome: username, username, telefone } },
  });

  if (error) {
    const msg = error.message || '';
    if (/registered|exists/i.test(msg))     mostrarToast('Este email já está registado.', 'error');
    else if (/username/i.test(msg))         mostrarToast('Este username já está registado.', 'error');
    else if (/telefone/i.test(msg))         mostrarToast('Este telefone já está registado.', 'error');
    else                                     mostrarToast('Erro ao criar conta: ' + msg, 'error');
    return;
  }

  if (!data.session) {
    // "Confirm email" está ativo nas definições de Auth do Supabase —
    // a conta foi criada mas só entra depois de confirmar o email.
    mostrarToast('Conta criada! Verifique o seu email para confirmar antes de entrar.', 'success');
    fecharLogin();
    return;
  }

  await aplicarSessao(data.session);
  await carregarDados();
  aplicarTextosSite();
  renderPublicProdutos();
  renderPublicAvaliacoes();
  atualizarStatsPublicas();
  atualizarInterface();
  safeCreateIcons();
  fecharLogin();

  // Fica sempre no site público — sem cargo atribuído ainda não há painel
  // para entrar. A equipa atribui o acesso e o utilizador pode voltar depois.
  mostrarToast('Conta criada com sucesso! A nossa equipa vai atribuir o seu acesso em breve.', 'success');
}

// Aplica uma sessão do Supabase Auth ao estado local (authUsuario),
// procurando o perfil correspondente na tabela "perfis".
async function aplicarSessao(session) {
  if (session && session.user) {
    const { data: perfil } = await sb.from('perfis').select('*').eq('id', session.user.id).maybeSingle();
    authUsuario = perfil || null;
    const { data: cliente } = await sb.from('clientes').select('*').eq('usuario_id', session.user.id).maybeSingle();
    authCliente = cliente || null;
  } else {
    authUsuario = null;
    authCliente = null;
  }
  atualizarUsuarioLogado();
}

// Restaura a sessão ao carregar a página (equivalente ao antigo iniciarAuth).
async function restaurarSessaoInicial() {
  const { data: { session } } = await sb.auth.getSession();
  await aplicarSessao(session);
}

// Mantém a app sincronizada se a sessão expirar/for terminada noutro separador.
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    authUsuario = null;
    authCliente = null;
    dados.cliente_servicos = [];
    atualizarUsuarioLogado();
    atualizarInterface();
  }
});

function atualizarInterface() {
  atualizarUsuarioLogado();

  const isGestorPlus  = usuarioEhGestorPlus();
  const logado        = estaAutenticado();
  const permitidas    = logado && !isGestorPlus ? paginasPermitidasPara(authUsuario.papel) : [];
  const isPendente    = usuarioPendente();

  // Mostrar/ocultar itens de nav consoante o papel
  document.querySelectorAll('.nav-item').forEach(item => {
    const isColabOnly = item.classList.contains('colaborador-only');
    const isAdminOnly = item.classList.contains('admin-only');
    const pagina       = item.dataset.page;

    if (isColabOnly) {
      // Área do Colaborador: só para quem ainda não tem cargo reconhecido
      item.style.display = isPendente ? 'flex' : 'none';
      return;
    }
    if (isGestorPlus) {
      // Administrador/Gestor têm acesso total (incl. Configuração)
      item.style.display = 'flex';
      return;
    }
    if (!logado || isAdminOnly) {
      item.style.display = 'none';
      return;
    }
    // Colaborador com cargo reconhecido: só as páginas do seu cargo
    item.style.display = permitidas.includes(pagina) ? 'flex' : 'none';
  });

  // Elementos gerais admin-only fora da nav (botões, secções, etc.)
  // Nota: usar sempre 'flex' aqui "achatava" os botões (.btn-primary usa
  // inline-flex) — o botão ficava a ocupar a largura toda e o conteúdo
  // colava-se à esquerda em vez de ficar centrado (bug visível em
  // "Produtos" ao recarregar a página com sessão de Gestor/Admin ativa).
  document.querySelectorAll('.admin-only:not(.nav-item)').forEach(item => {
    if (!isGestorPlus) { item.style.display = 'none'; return; }
    item.style.display = item.classList.contains('btn-primary') ? 'inline-flex' : 'flex';
  });
  document.querySelectorAll('.colaborador-only:not(.nav-item)').forEach(item => {
    item.style.display = usuarioEhColaborador() ? 'flex' : 'none';
  });

  atualizarBadgeMensagens();

  // Botões Entrar / Painel no site público
  ['pub-btn-entrar', 'pub-mobile-entrar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('pub-hidden', logado);
  });
  ['pub-btn-painel', 'pub-mobile-painel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('pub-hidden', !logado);
  });

  // Botões de edição inline no site público (só para Gestor+)
  document.querySelectorAll('.pub-edit-trigger').forEach(btn => {
    btn.style.display = isGestorPlus ? '' : 'none';
  });
  const prodBtn = document.getElementById('pub-produtos-gerir-btn');
  if (prodBtn) prodBtn.style.display = isGestorPlus ? 'block' : 'none';

  const loginBtn = document.getElementById('btnLoginHeader');
  if (!loginBtn) return;
  loginBtn.innerHTML = authUsuario
    ? `<i data-lucide="user-circle"></i><span>Perfil</span>`
    : `<i data-lucide="log-in"></i><span>Login</span>`;
  safeCreateIcons();
}

function atualizarUsuarioLogado() {
  const avatarEl = document.getElementById('userAvatar');
  const nameEl   = document.querySelector('.sidebar-user .user-name');
  const roleEl   = document.querySelector('.sidebar-user .user-role');

  if (estaAutenticado()) {
    if (avatarEl) {
      avatarEl.textContent = authUsuario.foto ? '' : iniciais(authUsuario.nome || 'Usuário');
      avatarEl.style.backgroundImage = authUsuario.foto ? `url(${authUsuario.foto})` : '';
    }
    if (nameEl) nameEl.textContent = authUsuario.nome || 'Usuário';
    // Mostrar sempre o papel normalizado (nunca "Administradora")
    if (roleEl) roleEl.textContent = normalizarPapel(authUsuario.papel);
  } else {
    if (avatarEl) { avatarEl.textContent = 'U'; avatarEl.style.backgroundImage = ''; }
    if (nameEl) nameEl.textContent = 'Convidado';
    if (roleEl) roleEl.textContent = 'Visitante';
  }
}

function estaAutenticado() {
  return !!(authUsuario && authUsuario.id);
}

function usuarioEhColaborador() {
  if (!estaAutenticado()) return false;
  // É colaborador quem tem nível ACIMA de Gestor (índice > 1), ou seja,
  // Supervisor, Assistente, Auxiliar, ou qualquer papel não reconhecido.
  // Administrador (0) e Gestor (1) NÃO são colaboradores.
  return papelNivel(authUsuario.papel) > papelNivel('Gestor');
}

function renderColaboradorArea() {
  const nomeEl = document.getElementById('colaborador-name');
  if (nomeEl && authUsuario) nomeEl.textContent = authUsuario.nome || 'Colaborador';
}

// Só true para quem está autenticado, NÃO é Gestor+, e o papel (ou falta dele)
// não dá acesso a nenhuma página — ou seja, à espera de cargo. Diferente de
// usuarioEhColaborador(), que também é true para Supervisor/Assistente/Auxiliar
// (cargos reais, não pendentes).
function usuarioPendente() {
  if (!estaAutenticado() || usuarioEhGestorPlus()) return false;
  return paginasPermitidasPara(authUsuario.papel).length === 0;
}

function usuarioEhGestorPlus() {
  if (!estaAutenticado()) return false;
  // Gestor+ = nível <= 1 (Administrador=0, Gestor=1)
  return papelNivel(authUsuario.papel) <= papelNivel('Gestor');
}

// Devolve a funcionária/o ligada à conta de login indicada (ver funcionaria-usuario no modal de Funcionárias)
function funcionariaDoUsuario(usuarioId) {
  if (!usuarioId) return null;
  return dados.funcionarias.find(f => f.usuario_id === usuarioId) || null;
}

// Só gestores/administradores podem criar/editar/eliminar entradas da
// agenda. Cargos abaixo de Gestor (Supervisor, Assistente, Auxiliar) podem
// ver a agenda mas não podem alterar a sua própria — mesmo que o serviço
// lhes esteja atribuído.
function podeEditarAgendaDe(funcionariaId) {
  return usuarioEhGestorPlus();
}

function abrirModalPerfil() {
  if (!estaAutenticado()) { abrirLogin(); return; }
  carregarPerfilAtual();
  abrirModal('modal-perfil');
}

async function logoutUsuario() {
  await sb.auth.signOut();
  authUsuario = null;
  authCliente = null;
  await carregarDados(); // recarrega já com a visibilidade de visitante anónimo
  aplicarTextosSite();
  renderPublicProdutos();
  renderPublicAvaliacoes();
  atualizarStatsPublicas();
  atualizarUsuarioLogado();
  atualizarInterface();
  safeCreateIcons();
  fecharModal('modal-perfil');
  voltarParaSite(); // volta ao site público após logout
  mostrarToast('Sessão encerrada.', 'success');
}

function carregarPerfilAtual() {
  if (!authUsuario) return;
  document.getElementById('profileName').value     = authUsuario.nome || '';
  document.getElementById('profileEmail').value    = authUsuario.email || '';
  document.getElementById('profileTelefone').value = authUsuario.telefone || '';

  const preview = document.getElementById('profilePhotoPreview');
  if (authUsuario.foto) {
    preview.innerHTML = `<img src="${authUsuario.foto}" alt="Foto de perfil" />`;
    preview.classList.add('has-image');
    preview.dataset.photo = authUsuario.foto;
  } else {
    preview.textContent = iniciais(authUsuario.nome || 'Usuário');
    preview.classList.remove('has-image');
    delete preview.dataset.photo;
  }
}

function previewPerfilFoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const dataUrl = e.target.result;
    const preview = document.getElementById('profilePhotoPreview');
    preview.innerHTML = `<img src="${dataUrl}" alt="Foto de perfil" />`;
    preview.classList.add('has-image');
    preview.dataset.photo = dataUrl;
  };
  reader.readAsDataURL(file);
}

async function salvarPerfil() {
  const nome     = document.getElementById('profileName').value.trim();
  const email    = document.getElementById('profileEmail').value.trim().toLowerCase();
  const telefone = document.getElementById('profileTelefone').value.trim();
  const preview  = document.getElementById('profilePhotoPreview');
  const foto     = preview.dataset.photo || null;

  if (!nome || !email || !telefone) {
    mostrarToast('Preencha todos os campos obrigatórios.', 'error');
    return;
  }

  // Mudar o email de login exige confirmação pelo Supabase Auth.
  if (email !== authUsuario.email) {
    const { error: authErr } = await sb.auth.updateUser({ email });
    if (authErr) { mostrarToast('Erro ao atualizar email: ' + authErr.message, 'error'); return; }
    mostrarToast('Verifique o novo email para confirmar a alteração.', 'success');
  }

  const { error } = await sb.from('perfis').update({ nome, email, telefone, foto }).eq('id', authUsuario.id);
  if (error) {
    const msg = /duplicate key/i.test(error.message)
      ? 'Este telefone já está associado a outra conta.'
      : 'Erro ao guardar perfil.';
    mostrarToast(msg, 'error');
    return;
  }

  authUsuario.nome     = nome;
  authUsuario.email    = email;
  authUsuario.telefone = telefone;
  authUsuario.foto     = foto;

  const idx = dados.usuarios.findIndex(u => u.id === authUsuario.id);
  if (idx !== -1) dados.usuarios[idx] = { ...dados.usuarios[idx], nome, email, telefone, foto };

  atualizarUsuarioLogado();
  fecharModal('modal-perfil');
  mostrarToast('Perfil atualizado com sucesso.', 'success');
}

function renderConfiguracao() {
  const tbody = document.getElementById('tabela-configuracao');
  const empty = document.getElementById('configuracao-empty');

  if (!usuarioEhGestorPlus()) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    empty.innerHTML = `
      <i data-lucide="shield-alert"></i>
      <h3>Acesso restrito</h3>
      <p>Somente gestores e administradores podem gerir cargos.</p>`;
    safeCreateIcons();
    return;
  }

  // Contas de cliente (ligadas a um registo em "clientes") não são staff —
  // não devem aparecer aqui nem ser promovíveis a um cargo.
  const idsClientes = new Set(dados.clientes.filter(c => c.usuario_id).map(c => c.usuario_id));
  const usuariosEquipa = dados.usuarios.filter(u => !idsClientes.has(u.id));

  if (!usuariosEquipa.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    empty.innerHTML = `
      <i data-lucide="user-check"></i>
      <h3>Nenhum usuário registado</h3>
      <p>Registe pelo menos uma conta para gerir cargos.</p>`;
    safeCreateIcons();
    return;
  }

  empty.style.display = 'none';
  const currentNivel = papelNivel(authUsuario.papel);
  tbody.innerHTML = usuariosEquipa.map(u => {
    const allowedRoles       = PAPEL_HIERARQUIA.filter(opt => papelNivel(opt) > currentNivel);
    const currentRoleAllowed = allowedRoles.includes(u.papel);
    const options            = [];
    if (!currentRoleAllowed) {
      options.push(`<option value="${u.papel}" selected disabled>${u.papel}</option>`);
    }
    options.push(...allowedRoles.map(opt =>
      `<option value="${opt}" ${u.papel === opt ? 'selected' : ''}>${opt}</option>`
    ));

    return `
      <tr>
        <td>${u.nome}</td>
        <td>${u.email}</td>
        <td>${u.telefone || '—'}</td>
        <td>
          <select id="user-role-${u.id}">
            ${options.join('')}
          </select>
        </td>
        <td>
          <button class="btn-sm btn-primary" type="button"
            onclick="alterarPapelUsuario('${u.id}', document.getElementById('user-role-${u.id}').value)">
            Guardar
          </button>
        </td>
      </tr>`;
  }).join('');

  safeCreateIcons();
}

async function alterarPapelUsuario(id, novoPapel) {
  if (!usuarioEhGestorPlus()) { mostrarToast('Acesso negado.', 'error'); return; }

  const usuario = dados.usuarios.find(u => u.id === id);
  if (!usuario) { mostrarToast('Usuário não encontrado.', 'error'); return; }

  const currentNivel = papelNivel(authUsuario.papel);
  const targetNivel  = papelNivel(novoPapel);
  if (targetNivel <= currentNivel) {
    mostrarToast('Não pode atribuir um cargo igual ou superior ao seu.', 'error');
    return;
  }

  const { error } = await sb.from('perfis').update({ papel: novoPapel }).eq('id', id);
  if (error) { mostrarToast('Erro ao atualizar cargo: ' + error.message, 'error'); return; }

  usuario.papel = novoPapel;
  if (authUsuario && authUsuario.id === id) {
    authUsuario.papel = novoPapel;
    atualizarUsuarioLogado();
  }

  mostrarToast(`Cargo de ${usuario.nome} atualizado para ${novoPapel}.`, 'success');
  atualizarInterface();
  renderConfiguracao();
}

/* ── Funções do Site Público ──────────────────────────────── */

// Aplica os textos guardados em site_textos aos elementos [data-content-key]
function aplicarTextosSite() {
  document.querySelectorAll('[data-content-key]').forEach(el => {
    const chave = el.dataset.contentKey;
    if (dados.site_textos[chave] !== undefined) {
      el.textContent = dados.site_textos[chave];
    }
  });
}

// Estatísticas reais no topo do site público
function atualizarStatsPublicas() {
  const elClientes = document.getElementById('pub-stat-clientes');
  const elServicos = document.getElementById('pub-stat-servicos');
  const elAvaliacao = document.getElementById('pub-stat-avaliacao');
  if (elClientes) elClientes.textContent = dados.clientes.length;
  if (elServicos) elServicos.textContent = dados.servicos.length;

  if (elAvaliacao) {
    const avs = dados.avaliacoes || [];
    if (avs.length === 0) {
      elAvaliacao.textContent = '—';
    } else {
      const media = avs.reduce((acc, av) => acc + (av.estrelas || 0), 0) / avs.length;
      elAvaliacao.textContent = media.toFixed(1) + ' ★';
    }
  }
}

// Abre um pequeno formulário inline para editar um texto do site (Gestor+)
function iniciarEdicaoInline(chave, elementId) {
  if (!usuarioEhGestorPlus()) return;

  const el = document.getElementById(elementId);
  if (!el || el.dataset.editando === 'true') return;

  const valorAtual  = dados.site_textos[chave] !== undefined ? dados.site_textos[chave] : el.textContent.trim();
  const multilinha  = el.tagName === 'P' || valorAtual.length > 60;
  const fundoEscuro = !!el.closest('.pub-hero, .pub-section-dark');

  el.dataset.editando = 'true';
  el.style.display = 'none';

  const editBtn = document.getElementById('edit-' + elementId.replace('pub-', ''));
  if (editBtn) editBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'inline-edit-form';
  form.id = 'inline-edit-form-' + elementId;

  const input = document.createElement(multilinha ? 'textarea' : 'input');
  if (multilinha) input.rows = 3;
  else input.type = 'text';
  input.value = valorAtual;

  const actions = document.createElement('div');
  actions.className = 'inline-edit-actions';

  const btnSalvar = document.createElement('button');
  btnSalvar.type = 'button';
  btnSalvar.className = 'inline-edit-save';
  btnSalvar.textContent = 'Guardar';
  btnSalvar.addEventListener('click', () => salvarTextoSite(chave, elementId, input.value));

  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button';
  btnCancelar.className = 'inline-edit-cancel' + (fundoEscuro ? '' : ' dark');
  btnCancelar.textContent = 'Cancelar';
  btnCancelar.addEventListener('click', () => cancelarEdicaoInline(elementId));

  actions.appendChild(btnSalvar);
  actions.appendChild(btnCancelar);
  form.appendChild(input);
  form.appendChild(actions);

  el.insertAdjacentElement('afterend', form);
  input.focus();
  if (input.select) input.select();
}

function cancelarEdicaoInline(elementId) {
  const el   = document.getElementById(elementId);
  const form = document.getElementById('inline-edit-form-' + elementId);
  if (form) form.remove();
  if (el) { el.style.display = ''; delete el.dataset.editando; }

  const editBtn = document.getElementById('edit-' + elementId.replace('pub-', ''));
  if (editBtn) editBtn.style.display = '';
}

async function salvarTextoSite(chave, elementId, novoValor) {
  novoValor = (novoValor || '').trim();
  if (!novoValor) { mostrarToast('O texto não pode estar vazio.', 'error'); return; }

  const { error } = await sb.from('site_textos')
    .upsert({ chave, valor: novoValor, updated_at: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) { mostrarToast('Erro ao guardar texto: ' + error.message, 'error'); return; }

  dados.site_textos[chave] = novoValor;
  const el = document.getElementById(elementId);
  if (el) el.textContent = novoValor;
  cancelarEdicaoInline(elementId);
  mostrarToast('Texto atualizado com sucesso!', 'success');
}

// Envio do formulário de contacto público (visitantes não autenticados)
async function enviarContacto() {
  const nome     = document.getElementById('contacto-nome').value.trim();
  const email    = document.getElementById('contacto-email').value.trim();
  const telefone = document.getElementById('contacto-telefone').value.trim();
  const assunto  = document.getElementById('contacto-assunto').value;
  const mensagem = document.getElementById('contacto-mensagem').value.trim();

  if (!nome || !mensagem) { mostrarToast('Preencha o nome e a mensagem.', 'error'); return; }

  const newId = gerarId();
  const obj   = { id: newId, nome, email, telefone, assunto, mensagem };

  const { error } = await sb.from('contactos').insert(obj);
  if (error) { mostrarToast('Erro ao enviar mensagem: ' + error.message, 'error'); return; }

  dados.mensagens.unshift({
    ...obj, resposta: null, respondido: false, lido: false, created_at: new Date().toISOString(),
  });
  atualizarBadgeMensagens();

  document.getElementById('contacto-nome').value     = '';
  document.getElementById('contacto-email').value    = '';
  document.getElementById('contacto-telefone').value = '';
  document.getElementById('contacto-mensagem').value = '';

  mostrarToast('Mensagem enviada com sucesso! Entraremos em contacto brevemente.', 'success');
}

// Abre o login a partir do site público (botão "Entrar")
function abrirLoginPublico() {
  if (!dados.usuarios.length) mostrarFormularioAuth('register');
  else                        mostrarFormularioAuth('login');
  abrirLogin();
}

// Troca o site público pelo painel (requer autenticação)
function irParaApp(pagina) {
  if (!estaAutenticado()) { abrirLoginPublico(); return; }

  if (authCliente) {
    mostrarClientContainer();
    irParaPaginaCliente(pagina && ['mensagens', 'servicos'].includes(pagina) ? pagina : (localStorage.getItem('lg_pagina_cliente') || 'mensagens'));
    return;
  }

  document.getElementById('public-site').style.display = 'none';
  document.getElementById('app-container').classList.remove('app-hidden');

  // Se a página foi passada explicitamente, usar essa (ex: botão "Gerir Produtos").
  // Só quem está mesmo pendente (sem cargo atribuído) vai sempre para a Área do
  // Colaborador. Quem já tem cargo (mesmo Supervisor/Assistente/Auxiliar) vai para
  // a última página visitada, ou Agenda por omissão — irParaPagina() valida o
  // acesso de qualquer forma, por isso não há risco de cair numa página proibida.
  let destino;
  if (pagina) {
    destino = pagina;
  } else if (usuarioPendente()) {
    destino = 'colaborador';
  } else if (usuarioEhColaborador()) {
    destino = localStorage.getItem('lg_pagina_ativa') || 'agenda';
  } else {
    destino = localStorage.getItem('lg_pagina_ativa') || 'relatorios';
  }
  irParaPagina(destino);
}

// Volta do painel (equipa OU cliente) para o site público
function voltarParaSite() {
  document.getElementById('public-site').style.display = '';
  document.getElementById('app-container').classList.add('app-hidden');
  const clientCont = document.getElementById('client-container');
  if (clientCont) clientCont.classList.add('app-hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Área do Cliente ──────────────────────────────────────────────────── */

function mostrarClientContainer() {
  document.getElementById('public-site').style.display = 'none';
  document.getElementById('app-container').classList.add('app-hidden');
  document.getElementById('client-container').classList.remove('app-hidden');
  const nomeEl = document.getElementById('client-nome');
  if (nomeEl && authCliente) nomeEl.textContent = authCliente.nome || 'Cliente';
  carregarDadosCliente();
}

function irParaPaginaCliente(pagina) {
  if (!['mensagens', 'servicos'].includes(pagina)) pagina = 'mensagens';
  localStorage.setItem('lg_pagina_cliente', pagina);
  document.querySelectorAll('.client-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cpage === pagina);
  });
  document.querySelectorAll('.client-page').forEach(p => {
    p.classList.toggle('active', p.id === 'cpage-' + pagina);
  });
}

async function carregarDadosCliente() {
  if (!authCliente) return;
  const [resS, resM, resFP] = await Promise.all([
    sb.from('servicos').select('*').eq('cliente_id', authCliente.id).order('dia', { ascending: true }),
    sb.from('mensagens_clientes').select('*').eq('cliente_id', authCliente.id).order('created_at', { ascending: true }),
    sb.from('funcionarias_publicas').select('*'),
  ]);
  dados.cliente_servicos  = resS.data  || [];
  dados.cliente_mensagens = resM.data  || [];
  dados.funcionarias_pub  = resFP.data || [];
  renderClienteServicos();
  renderClienteChat();
  marcarMensagensClienteLidas('cliente');
  safeCreateIcons();
}

function renderClienteServicos() {
  const lista = document.getElementById('cliente-servicos-lista');
  const empty = document.getElementById('cliente-servicos-empty');
  if (!lista || !empty) return;

  if (!dados.cliente_servicos.length) {
    lista.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  lista.innerHTML = dados.cliente_servicos.map(s => {
    const func = dados.funcionarias_pub.find(f => f.id === s.funcionaria_id);
    return `
      <div class="cliente-servico-card">
        <div class="cliente-servico-dia">${NOMES_DIAS[s.dia] || ''}</div>
        <div class="cliente-servico-info">
          <div class="cliente-servico-hora">${s.inicio} – ${s.fim}</div>
          <div class="cliente-servico-func">${func ? func.nome : 'A atribuir'}</div>
        </div>
      </div>`;
  }).join('');
}

function renderClienteChat() {
  const chat = document.getElementById('cliente-chat-mensagens');
  if (!chat) return;
  if (!dados.cliente_mensagens.length) {
    chat.innerHTML = '<p class="chat-empty">Sem mensagens ainda. Escreva-nos!</p>';
    return;
  }
  chat.innerHTML = dados.cliente_mensagens.map(m => {
    const hora = m.created_at
      ? new Date(m.created_at).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="chat-msg ${m.remetente === 'empresa' ? 'equipa' : 'cliente'}">
        <div class="chat-msg-autor">${m.autor_nome}</div>
        <div class="chat-msg-texto">${m.mensagem}</div>
        <div class="chat-msg-hora">${hora}</div>
      </div>`;
  }).join('');
  chat.scrollTop = chat.scrollHeight;
}

async function enviarMensagemCliente() {
  if (!authCliente) return;
  const input = document.getElementById('cliente-chat-input');
  const texto = (input?.value || '').trim();
  if (!texto) return;

  const obj = {
    id:         gerarId(),
    cliente_id: authCliente.id,
    remetente:  'cliente',
    autor_nome: authCliente.nome || 'Cliente',
    mensagem:   texto,
    lido:       false,
  };
  const { error } = await sb.from('mensagens_clientes').insert(obj);
  if (error) { mostrarToast('Erro ao enviar mensagem.', 'error'); return; }

  dados.cliente_mensagens.push({ ...obj, created_at: new Date().toISOString() });
  input.value = '';
  renderClienteChat();
}

function abrirPedidoOrcamento() {
  const desc = document.getElementById('orcamento-descricao');
  if (desc) desc.value = '';
  document.getElementById('modal-orcamento').classList.add('open');
}

async function enviarPedidoOrcamento() {
  if (!authCliente) return;
  const texto = (document.getElementById('orcamento-descricao')?.value || '').trim();
  if (!texto) { mostrarToast('Descreva o que precisa antes de enviar.', 'error'); return; }

  const obj = {
    id:         gerarId(),
    cliente_id: authCliente.id,
    remetente:  'cliente',
    autor_nome: authCliente.nome || 'Cliente',
    mensagem:   '📋 Pedido de Orçamento: ' + texto,
    lido:       false,
  };
  const { error } = await sb.from('mensagens_clientes').insert(obj);
  if (error) { mostrarToast('Erro ao enviar pedido.', 'error'); return; }

  dados.cliente_mensagens.push({ ...obj, created_at: new Date().toISOString() });
  fecharModal('modal-orcamento');
  irParaPaginaCliente('mensagens');
  renderClienteChat();
  mostrarToast('Pedido de orçamento enviado!', 'success');
}

/* ── Área da Equipa: aba "Chat com Clientes" (responder aos pedidos) ────── */

function renderChatClientesLista() {
  const cont = document.getElementById('chatClientesLista');
  if (!cont) return;

  if (!dados.clientes.length) {
    cont.innerHTML = '<p class="chat-empty">Sem clientes registados.</p>';
    return;
  }
  cont.innerHTML = dados.clientes.map(c => {
    const naoLidas = dados.mensagens_clientes.filter(m => m.cliente_id === c.id && m.remetente === 'cliente' && !m.lido).length;
    const ativo    = chatClienteAlvoId === c.id;
    return `
      <button class="chat-equipa-item${ativo ? ' active' : ''}" onclick="abrirChatCliente('${c.id}')">
        <span class="chat-equipa-nome">${c.nome}</span>
        ${naoLidas ? `<span class="nav-badge">${naoLidas}</span>` : ''}
      </button>`;
  }).join('');
}

function abrirChatCliente(clienteId) {
  chatClienteAlvoId = clienteId;
  const titulo = document.getElementById('chat-clientes-titulo');
  if (titulo) {
    const c = dados.clientes.find(c => c.id === clienteId);
    titulo.textContent = c ? `Conversa com ${c.nome}` : 'Selecione uma conversa';
  }
  renderChatClientesLista();
  carregarMensagemCliente_Staff();
  marcarMensagensClienteLidas('empresa');
}

function carregarMensagemCliente_Staff() {
  const chat = document.getElementById('chat-clientes-msgs');
  if (!chat || !chatClienteAlvoId) return;
  const msgs = dados.mensagens_clientes.filter(m => m.cliente_id === chatClienteAlvoId);
  if (!msgs.length) {
    chat.innerHTML = '<p class="chat-empty">Sem mensagens ainda.</p>';
    return;
  }
  chat.innerHTML = msgs.map(m => {
    const hora = m.created_at
      ? new Date(m.created_at).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="chat-msg ${m.remetente === 'empresa' ? 'equipa' : 'cliente'}">
        <div class="chat-msg-autor">${m.autor_nome}</div>
        <div class="chat-msg-texto">${m.mensagem}</div>
        <div class="chat-msg-hora">${hora}</div>
      </div>`;
  }).join('');
  chat.scrollTop = chat.scrollHeight;
}

async function enviarMensagemParaCliente() {
  if (!chatClienteAlvoId) { mostrarToast('Selecione uma conversa primeiro.', 'error'); return; }
  const input = document.getElementById('chat-clientes-input');
  const texto = (input?.value || '').trim();
  if (!texto) return;

  const obj = {
    id:         gerarId(),
    cliente_id: chatClienteAlvoId,
    remetente:  'empresa',
    autor_nome: authUsuario.nome || 'Equipa BORG',
    mensagem:   texto,
    lido:       true,
  };
  const { error } = await sb.from('mensagens_clientes').insert(obj);
  if (error) { mostrarToast('Erro ao enviar mensagem.', 'error'); return; }

  dados.mensagens_clientes.push({ ...obj, created_at: new Date().toISOString() });
  input.value = '';
  carregarMensagemCliente_Staff();
  atualizarBadgeMensagens();
}

// remetenteChamador: 'cliente' quando é a Área do Cliente a marcar como lidas as
// respostas da empresa; 'empresa' quando é a equipa a marcar como lidas as
// mensagens recebidas de um cliente.
async function marcarMensagensClienteLidas(remetenteChamador) {
  const fonte = remetenteChamador === 'cliente' ? dados.cliente_mensagens : dados.mensagens_clientes;
  const alvoId = remetenteChamador === 'cliente' ? authCliente?.id : chatClienteAlvoId;
  const remetenteAlvo = remetenteChamador === 'cliente' ? 'empresa' : 'cliente';
  if (!alvoId) return;

  const naoLidas = fonte.filter(m => m.cliente_id === alvoId && m.remetente === remetenteAlvo && !m.lido);
  if (!naoLidas.length) return;

  for (const m of naoLidas) {
    const { error } = await sb.from('mensagens_clientes').update({ lido: true }).eq('id', m.id);
    if (!error) m.lido = true;
  }
  if (remetenteChamador === 'empresa') renderChatClientesLista();
  atualizarBadgeMensagens();
}

async function carregarMensagensClientesApp() {
  const { data, error } = await sb.from('mensagens_clientes').select('*').order('created_at', { ascending: true });
  if (error) { mostrarToast('Erro ao atualizar chat de clientes.', 'error'); return; }
  dados.mensagens_clientes = data || [];
  renderChatClientesLista();
  if (chatClienteAlvoId) carregarMensagemCliente_Staff();
}

// Scroll suave para uma secção pelo id.
// Não usamos só scrollIntoView({block:'start'}) porque a navbar pública é
// "sticky" (fica fixa no topo, 64px de altura) — isso escondia sempre o
// início real da secção atrás da navbar, dando a impressão de que a
// página "não centrava" no sítio certo. Calculamos a posição à mão e
// descontamos a altura da navbar, para o topo da secção ficar sempre
// visível logo abaixo dela.
function smoothScroll(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const nav = document.getElementById('pubNav');
  const folga = (nav ? nav.offsetHeight : 64) + 16; // + respiro
  const destino = el.getBoundingClientRect().top + window.pageYOffset - folga;
  window.scrollTo({ top: Math.max(destino, 0), behavior: 'smooth' });
}

// Menu hamburger mobile (site público)
function togglePubMenu() {
  const menu = document.getElementById('pubMobileMenu');
  if (menu) menu.classList.toggle('open');
}
function closePubMenu() {
  const menu = document.getElementById('pubMobileMenu');
  if (menu) menu.classList.remove('open');
}

/* ── 10.3 Avaliações ─────────────────────────────────────── */

// Converte a lista de fotos de uma avaliação (guardada como string) num array.
// IMPORTANTE: as fotos são guardadas como JSON (ex.: '["data:image/...","data:image/..."]').
// Antes usava-se split(',') para separar várias fotos, mas cada data-URL em
// base64 já tem uma vírgula logo a seguir a "base64," (ex.: "data:image/png;base64,iVBORw...").
// Isso partia CADA foto ao meio e corrompia o src da imagem — por isso as fotos
// nunca apareciam depois de guardadas. JSON.stringify/parse resolve isto por completo.
function parseFotosUrl(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch (e) {
    // Não é JSON — deve ser um registo antigo guardado no formato corrompido.
    // Não há forma fiável de recuperar fotos antigas partidas por vírgulas,
    // mas evitamos rebentar o ecrã: tratamos como "sem fotos válidas".
  }
  return [];
}

function renderAvaliacoes() {
  const lista = document.getElementById('avaliacoes-lista');
  const empty = document.getElementById('avaliacoes-empty');
  if (!lista) return;

  if (!dados.avaliacoes.length) {
    lista.innerHTML = '';
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    lista.innerHTML = dados.avaliacoes.map(av => {
      // Cada cartão é isolado num try/catch: se um registo tiver dados
      // inesperados/corrompidos, não deve deitar abaixo a lista inteira
      // (era isto que fazia as avaliações "desaparecerem" do ecrã).
      try {
        const func = dados.funcionarias.find(f => f.id === av.funcionaria_id);
        const estrelas = renderStarsHtml(av.estrelas || 0);
        const data = av.created_at
          ? new Date(av.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' })
          : '';
        const chatCount = dados.avaliacoes_chat.filter(c => c.avaliacao_id === av.id).length;
        const fotos = parseFotosUrl(av.fotos_url);
        const nomeCliente = av.cliente_nome || 'Anónimo';

        return `
          <div class="avaliacao-card" onclick="abrirModalAvaliacao('${av.id}')">
            <div class="av-header">
              <div class="av-autor">
                <div class="av-avatar">${nomeCliente[0].toUpperCase()}</div>
                <div>
                  <strong>${nomeCliente}</strong>
                  <div class="av-data">${data}</div>
                </div>
              </div>
              <div class="av-estrelas">${estrelas}</div>
            </div>
            ${func ? `<div class="av-func-tag"><i data-lucide="user" style="width:12px;height:12px;vertical-align:middle;margin-right:4px"></i>${func.nome}</div>` : ''}
            ${av.comentario ? `<div class="av-comentario">${av.comentario}</div>` : ''}
            ${fotos.length ? `<div class="av-fotos-row">${fotos.slice(0,3).map(f => `<img src="${f}" class="av-foto-thumb" onerror="this.style.display='none'" />`).join('')}${fotos.length > 3 ? `<span class="av-fotos-mais">+${fotos.length - 3}</span>` : ''}</div>` : ''}
            <div class="av-footer">
              <span class="av-chat-count"><i data-lucide="message-circle" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>${chatCount} resposta${chatCount !== 1 ? 's' : ''}</span>
              ${av.respondido ? '<span class="mensagem-badge-resp">Respondido</span>' : ''}
            </div>
          </div>`;
      } catch (e) {
        console.error('Avaliação com dados inválidos, ignorada:', av, e);
        return '';
      }
    }).join('');
  }
  safeCreateIcons();
}

function renderStarsHtml(n, interativo = false, prefixo = '') {
  if (interativo) {
    return Array.from({ length: 5 }, (_, i) => {
      const val = i + 1;
      return `<span class="star-btn" data-val="${val}" onclick="${prefixo}setEstrela(${val})" title="${val} estrela${val > 1 ? 's' : ''}">★</span>`;
    }).join('');
  }
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="star ${i < n ? 'filled' : ''}" >★</span>`
  ).join('');
}

let avaliacaoEstrelasSelecionadas = 0;

function setEstrela(val) {
  avaliacaoEstrelasSelecionadas = val;
  document.querySelectorAll('#av-estrelas-input .star-btn').forEach((s, i) => {
    s.classList.toggle('filled', i < val);
  });
}

async function abrirModalAvaliacao(id) {
  const av = dados.avaliacoes.find(a => a.id === id);
  if (!av) return;
  document.getElementById('modal-av-id').value = id;

  const func = dados.funcionarias.find(f => f.id === av.funcionaria_id);
  const estrelas = renderStarsHtml(av.estrelas || 0);
  const data = av.created_at
    ? new Date(av.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const fotos = parseFotosUrl(av.fotos_url);

  document.getElementById('modal-av-detalhe').innerHTML = `
    <div class="av-detail-header">
      <div>
        <h4>${av.cliente_nome}</h4>
        <div class="av-data">${data}${av.cliente_email ? ` · ${av.cliente_email}` : ''}</div>
        <div class="av-estrelas" style="margin-top:6px">${estrelas}</div>
      </div>
      ${func ? `<div class="av-func-pill"><i data-lucide="user" style="width:13px;height:13px;vertical-align:middle;margin-right:5px"></i>${func.nome}</div>` : ''}
    </div>
    ${av.comentario ? `<div class="av-comentario-full">${av.comentario}</div>` : ''}
    ${fotos.length ? `<div class="av-fotos-grid">${fotos.map(f => `<a href="${f}" target="_blank"><img src="${f}" class="av-foto-full" onerror="this.parentElement.style.display='none'" /></a>`).join('')}</div>` : ''}`;

  const delBtnAv = document.getElementById('btn-eliminar-avaliacao');
  if (delBtnAv) delBtnAv.style.display = usuarioEhGestorPlus() ? 'inline-flex' : 'none';

  // Chat
  carregarChatAvaliacao(id);
  abrirModal('modal-avaliacao');
}

function carregarChatAvaliacao(avId) {
  const chat = document.getElementById('av-chat-mensagens');
  if (!chat) return;
  const msgs = dados.avaliacoes_chat.filter(c => c.avaliacao_id === avId);
  if (!msgs.length) {
    chat.innerHTML = '<p class="chat-empty">Sem mensagens ainda. Inicie a conversa!</p>';
    return;
  }
  chat.innerHTML = msgs.map(m => {
    const hora = m.created_at
      ? new Date(m.created_at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
      : '';
    const isEquipa = dados.usuarios.some(u => u.nome === m.autor_nome);
    return `
      <div class="chat-msg ${isEquipa ? 'equipa' : 'cliente'}">
        <div class="chat-msg-autor">${m.autor_nome}</div>
        <div class="chat-msg-texto">${m.mensagem}</div>
        <div class="chat-msg-hora">${hora}</div>
      </div>`;
  }).join('');
  chat.scrollTop = chat.scrollHeight;
}

async function enviarChatAvaliacao() {
  const avId   = document.getElementById('modal-av-id').value;
  const input  = document.getElementById('av-chat-input');
  const texto  = (input?.value || '').trim();
  if (!texto) return;

  const autorNome = authUsuario ? (authUsuario.nome || 'Equipa') : 'Cliente';
  const newId     = gerarId();
  const obj       = { id: newId, avaliacao_id: avId, autor_nome: autorNome, mensagem: texto };

  const { error } = await sb.from('avaliacoes_chat').insert(obj);
  if (error) { mostrarToast('Erro ao enviar mensagem.', 'error'); return; }

  dados.avaliacoes_chat.push({ ...obj, created_at: new Date().toISOString() });
  input.value = '';
  carregarChatAvaliacao(avId);
}

// Submissão pública de avaliação (site público)
async function enviarAvaliacaoPublica() {
  const nome        = document.getElementById('av-pub-nome').value.trim();
  const email       = document.getElementById('av-pub-email').value.trim();
  const funcionariaId = document.getElementById('av-pub-funcionaria').value;
  const comentario  = document.getElementById('av-pub-comentario').value.trim();
  const fotosInput  = document.getElementById('av-pub-fotos');
  const estrelas    = avaliacaoEstrelasSelecionadas;

  if (!nome) { mostrarToast('Introduza o seu nome.', 'error'); return; }
  if (!estrelas) { mostrarToast('Seleccione uma classificação de estrelas.', 'error'); return; }

  // Fotos: converte para base64 (máx 3 fotos, 500KB cada) e guarda como JSON.
  // (Guardar como JSON evita o bug antigo em que juntar as fotos com ","
  // corrompia cada imagem, porque um data-URL em base64 já contém uma
  // vírgula logo a seguir a "base64,".)
  let fotosUrl = '';
  if (fotosInput && fotosInput.files.length) {
    const files = [...fotosInput.files].slice(0, 3);
    const b64List = await Promise.all(files.map(f => new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = e => res(e.target.result);
      reader.onerror = () => res('');
      reader.readAsDataURL(f);
    })));
    fotosUrl = JSON.stringify(b64List.filter(Boolean));
  }

  const newId = gerarId();
  const obj   = { id: newId, cliente_nome: nome, cliente_email: email, funcionaria_id: funcionariaId || null, estrelas, comentario, fotos_url: fotosUrl };

  try {
    const { error } = await sb.from('avaliacoes').insert(obj);
    if (error) { mostrarToast('Erro ao enviar avaliação: ' + error.message, 'error'); return; }

    // Acrescenta já a nova avaliação à lista local — o ecrã fica sempre
    // correto mesmo que o passo de sincronização abaixo falhe ou demore.
    dados.avaliacoes.unshift({ ...obj, created_at: new Date().toISOString() });

    // Tenta sincronizar com o servidor a seguir, para apanhar avaliações
    // de outras pessoas entretanto. IMPORTANTE: só substituímos a lista
    // local se a resposta vier mesmo preenchida. Antes, qualquer resposta
    // tecnicamente "sem erro" mas vazia (ex.: atraso/hiccup momentâneo do
    // Supabase logo a seguir a um insert) substituía a lista inteira por
    // um array vazio — era isso que fazia TODAS as avaliações desaparecerem
    // do ecrã depois de enviar. Um array vazio nunca é motivo para apagar
    // o que já sabemos que existe.
    const { data: avData, error: avErr } = await sb.from('avaliacoes').select('*').order('created_at', { ascending: false });
    if (avErr) console.error('Erro ao sincronizar avaliações após envio:', avErr);
    if (!avErr && avData && avData.length > 0) {
      dados.avaliacoes = avData;
    }

    // Reset form
    ['av-pub-nome','av-pub-email','av-pub-comentario'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    avaliacaoEstrelasSelecionadas = 0;
    document.querySelectorAll('#av-estrelas-input .star-btn').forEach(s => s.classList.remove('filled'));
    if (fotosInput) fotosInput.value = '';
    const previewEl = document.getElementById('av-pub-fotos-preview');
    if (previewEl) previewEl.innerHTML = '';

    mostrarToast('Avaliação enviada! Obrigado pelo seu feedback.', 'success');
  } catch (err) {
    console.error('Erro inesperado ao enviar avaliação:', err);
    mostrarToast('Erro inesperado ao enviar avaliação. Tente novamente.', 'error');
  } finally {
    // Corre SEMPRE, mesmo se algo acima falhar — assim a lista de
    // avaliações nunca fica em branco no ecrã depois de submeter.
    atualizarStatsPublicas();
    renderPublicAvaliacoes();
  }
}

// Mostra avaliações na secção pública
// Quantas avaliações mostrar de cada vez no mural público (o resto
// entra ao clicar em "Ver mais avaliações").
let pubAvaliacoesLimite = 9;

function renderPublicAvaliacoes() {
  const container = document.getElementById('pub-avaliacoes-lista');
  const vermaisWrap = document.getElementById('pub-avaliacoes-vermais');
  if (!container) return;

  if (!dados.avaliacoes.length) {
    container.innerHTML = '<p class="pub-av-empty">Seja o primeiro a deixar uma avaliação!</p>';
    if (vermaisWrap) vermaisWrap.innerHTML = '';
    return;
  }

  const visiveis = dados.avaliacoes.slice(0, pubAvaliacoesLimite);

  container.innerHTML = visiveis.map(av => {
    // Cada cartão é isolado num try/catch: um registo com dados
    // inesperados nunca deve apagar o mural inteiro de avaliações.
    try {
      const func = dados.funcionarias.find(f => f.id === av.funcionaria_id);
      const estrelas = renderStarsHtml(av.estrelas || 0);
      const data = av.created_at
        ? new Date(av.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
      const fotos = parseFotosUrl(av.fotos_url);
      const msgs = dados.avaliacoes_chat.filter(c => c.avaliacao_id === av.id);
      const nomeCliente = av.cliente_nome || 'Anónimo';

      return `
        <div class="pub-av-card">
          <div class="pub-av-top">
            <div class="pub-av-avatar">${nomeCliente[0].toUpperCase()}</div>
            <div>
              <strong class="pub-av-nome">${nomeCliente}</strong>
              <div class="pub-av-data">${data}</div>
            </div>
            <div class="pub-av-estrelas">${estrelas}</div>
          </div>
          ${func ? `<div class="pub-av-func-tag">🧹 ${func.nome}</div>` : ''}
          ${av.comentario ? `<p class="pub-av-texto">${av.comentario}</p>` : ''}
          ${fotos.length ? `<div class="av-fotos-row">${fotos.slice(0, 3).map(f => `<a href="${f}" target="_blank"><img src="${f}" class="av-foto-thumb" onerror="this.style.display='none'" /></a>`).join('')}${fotos.length > 3 ? `<span class="av-fotos-mais">+${fotos.length - 3}</span>` : ''}</div>` : ''}

          <div class="pub-av-thread">
            <div class="av-chat-msgs pub-av-chat-msgs" id="pub-chat-${av.id}">${renderMensagensThreadPublico(msgs)}</div>
            <div class="av-chat-input-row">
              <input type="text" id="pub-chat-nome-${av.id}" placeholder="O seu nome" class="pub-chat-nome-input" />
              <input type="text" id="pub-chat-msg-${av.id}" placeholder="Escreva um comentário…"
                onkeydown="if(event.key==='Enter'){enviarRespostaPublica('${av.id}')}" />
              <button class="btn-icon" onclick="enviarRespostaPublica('${av.id}')" title="Enviar"><i data-lucide="send"></i></button>
            </div>
          </div>
        </div>`;
    } catch (e) {
      console.error('Avaliação pública com dados inválidos, ignorada:', av, e);
      return '';
    }
  }).join('');

  if (vermaisWrap) {
    const faltam = dados.avaliacoes.length - visiveis.length;
    vermaisWrap.innerHTML = faltam > 0
      ? `<button class="btn-secondary" onclick="verMaisAvaliacoesPublico()">Ver mais avaliações (+${faltam})</button>`
      : '';
  }

  safeCreateIcons();
}

function verMaisAvaliacoesPublico() {
  pubAvaliacoesLimite += 9;
  renderPublicAvaliacoes();
}

// Renderiza as mensagens da conversa por baixo de uma avaliação pública.
// Reutiliza o mesmo estilo de balões já usado no chat interno da equipa —
// mensagens de membros da equipa (nome coincide com um utilizador do
// sistema) ficam destacadas para se distinguirem de comentários de visitantes.
function renderMensagensThreadPublico(msgs) {
  if (!msgs.length) return '<p class="chat-empty">Ainda sem comentários. Seja o primeiro a responder!</p>';
  return msgs.map(m => {
    const hora = m.created_at
      ? new Date(m.created_at).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' })
      : '';
    const isEquipa = dados.usuarios.some(u => u.nome === m.autor_nome);
    return `
      <div class="chat-msg ${isEquipa ? 'equipa' : 'cliente'}">
        <div class="chat-msg-autor">${m.autor_nome}${isEquipa ? ' · Equipa BORG' : ''}</div>
        <div class="chat-msg-texto">${m.mensagem}</div>
        <div class="chat-msg-hora">${hora}</div>
      </div>`;
  }).join('');
}

// Qualquer visitante do site pode comentar/responder numa avaliação —
// usa a mesma tabela avaliacoes_chat do chat interno, só que aqui
// aberta ao público (ver migração SQL correspondente).
async function enviarRespostaPublica(avId) {
  const nomeInput = document.getElementById(`pub-chat-nome-${avId}`);
  const msgInput  = document.getElementById(`pub-chat-msg-${avId}`);
  const nome  = (nomeInput?.value || '').trim();
  const texto = (msgInput?.value || '').trim();

  if (!nome)  { mostrarToast('Escreva o seu nome para comentar.', 'error'); return; }
  if (!texto) { mostrarToast('Escreva um comentário antes de enviar.', 'error'); return; }

  const newId = gerarId();
  const obj   = { id: newId, avaliacao_id: avId, autor_nome: nome, mensagem: texto };

  const { error } = await sb.from('avaliacoes_chat').insert(obj);
  if (error) {
    console.error('Erro ao enviar comentário público:', error);
    mostrarToast('Erro ao enviar comentário: ' + (error.message || 'desconhecido'), 'error');
    return;
  }

  dados.avaliacoes_chat.push({ ...obj, created_at: new Date().toISOString() });
  msgInput.value = '';
  renderPublicAvaliacoes();
}

// Pré-visualizar fotos seleccionadas
function previewAvaliacaoFotos(event) {
  const preview = document.getElementById('av-pub-fotos-preview');
  if (!preview) return;
  const todosFicheiros = [...event.target.files];
  const files = todosFicheiros.slice(0, 3);
  if (todosFicheiros.length > 3) {
    mostrarToast('Só pode adicionar até 3 fotos. As restantes foram ignoradas.', 'error');
  }
  preview.innerHTML = files.map(f => {
    const url = URL.createObjectURL(f);
    return `<div class="av-foto-preview-wrap"><img src="${url}" class="av-foto-preview-thumb" /></div>`;
  }).join('');
}

/* Arrastar-e-largar fotos para a avaliação pública */
function avFotosDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add('dragover');
}
function avFotosDragLeave(event) {
  event.currentTarget.classList.remove('dragover');
}
function avFotosDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('dragover');
  const input = document.getElementById('av-pub-fotos');
  if (!input) return;

  const ficheiros = [...event.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (!ficheiros.length) { mostrarToast('Arraste apenas ficheiros de imagem.', 'error'); return; }

  // Constrói uma FileList "a sério" para o <input type="file">, para que o
  // resto do fluxo de envio (que lê fotosInput.files) funcione sem alterações.
  const dt = new DataTransfer();
  ficheiros.slice(0, 3).forEach(f => dt.items.add(f));
  input.files = dt.files;
  previewAvaliacaoFotos({ target: input });
}

async function carregarAvaliacoesApp() {
  const [resAv, resAvC] = await Promise.all([
    sb.from('avaliacoes').select('*').order('created_at', { ascending: false }),
    sb.from('avaliacoes_chat').select('*').order('created_at', { ascending: true }),
  ]);
  if (resAv.error) { mostrarToast('Erro ao actualizar avaliações: ' + resAv.error.message, 'error'); return; }
  dados.avaliacoes      = resAv.data || [];
  dados.avaliacoes_chat = resAvC.data || [];
  renderAvaliacoes();
  atualizarStatsPublicas();
  mostrarToast('Avaliações actualizadas.', 'success');
}

/* ── 15. Init ──────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  mostrarLoading();

  // Restaura a sessão do Supabase Auth ANTES de carregar dados, para que
  // os pedidos já saiam autenticados e a RLS devolva o que é esperado.
  await restaurarSessaoInicial();

  try {
    await carregarDados();
  } catch (err) {
    console.error('Erro ao carregar dados:', err);
    mostrarToast('Erro Supabase: ' + err.message, 'error');
  }

  // Conteúdo do site público (textos editáveis, produtos, estatísticas, avaliações)
  aplicarTextosSite();
  renderPublicProdutos();
  atualizarStatsPublicas();
  atualizarBadgeMensagens();
  renderPublicAvaliacoes();

  // Popula o select de funcionárias no formulário público de avaliação.
  // Usa a view pública "funcionarias_publicas" (só id + nome) — funciona
  // mesmo para visitantes sem sessão, sem expor contacto/cargo/etc.
  const selFuncAv = document.getElementById('av-pub-funcionaria');
  if (selFuncAv) {
    const { data: funcPublicas } = await sb.from('funcionarias_publicas').select('*');
    selFuncAv.innerHTML = '<option value="">Qualquer funcionária/o</option>' +
      (funcPublicas || []).map(f => `<option value="${f.id}">${f.nome}</option>`).join('');
  }

  // Inicializar estrelas interativas no formulário público
  const avEstrelasInput = document.getElementById('av-estrelas-input');
  if (avEstrelasInput) {
    avEstrelasInput.innerHTML = renderStarsHtml(0, true);
  }

  safeCreateIcons();

  // Gestor+ entra automaticamente no painel ao voltar com sessão activa;
  // Clientes entram automaticamente na sua Área; outros Colaboradores ficam
  // no site público até clicar "Painel" manualmente.
  if (authUsuario) {
    const nivelUsuario = papelNivel(authUsuario.papel);
    if (nivelUsuario <= papelNivel('Gestor')) irParaApp();
  }
  if (authCliente) irParaApp();
  atualizarInterface();
  esconderLoading();

  // Animações de scroll (letras a montar-se)
  initScrollAnimations();
});
/* ── Scroll Animations ─────────────────────────────────────── */

function initScrollAnimations() {
  // Typewriter effect for section headings
  function typewriterReveal(entries, observer) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      observer.unobserve(el);
      el.classList.add('revealed');

      if (el.dataset.typewriter === 'true') {
        const original = el.dataset.originalText || el.textContent;
        el.dataset.originalText = original;
        el.textContent = '';
        let i = 0;
        const speed = Math.max(18, Math.min(38, Math.floor(800 / original.length)));
        const interval = setInterval(() => {
          el.textContent = original.slice(0, i + 1);
          i++;
          if (i >= original.length) clearInterval(interval);
        }, speed);
      }
    });
  }

  const observer = new IntersectionObserver(typewriterReveal, {
    threshold: 0.18,
    rootMargin: '0px 0px -60px 0px',
  });

  // Mark h2 headings in public sections for typewriter effect
  document.querySelectorAll(
    '.pub-section-header h2, .pub-contact-info h2, .pub-section-header.light h2'
  ).forEach(el => {
    el.dataset.typewriter = 'true';
    observer.observe(el);
  });

  // Fade-up for cards and steps
  const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('fade-in-up');
        fadeObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll(
    '.pub-service-card, .pub-step, .pub-produto-card, .pub-av-card, .pub-stat'
  ).forEach((el, i) => {
    el.style.transitionDelay = (i * 0.07) + 's';
    fadeObserver.observe(el);
  });
}
