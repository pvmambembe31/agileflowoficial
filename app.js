const STORAGE_KEY = 'agileflow.v01'; // Mantido de propósito para preservar os dados da v0.1.
const SCHEMA_VERSION = 17;
const APP_VERSION = '1.0.0';
const RELEASE_CHANNEL = 'stable';
const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_BASE_URL = 'http://127.0.0.1:43127/api/v1';
const BRIDGE_TOKEN_KEY = 'agileflow.bridge.token';

function hostingProvider() {
  const host = String(location.hostname || '').toLowerCase();
  if (host.endsWith('.netlify.app')) return 'Netlify';
  if (host.endsWith('.github.io')) return 'GitHub Pages';
  if (host === 'localhost' || host === '127.0.0.1') return 'Local preview';
  return 'Web host';
}

function hostingOrigin() {
  try { return location.origin; } catch { return ''; }
}

let bridgeStatus = { state: 'checking', connected: false, paired: false, platform: null, root: null, workspaceExists: false, workspaceModified: null, version: null, error: null };
let bridgeSyncTimer = null;
let bridgeStartupResolved = false;
let bridgeHeartbeatTimer = null;
let syncState = { code: 'checking', pending: false, detail: 'Verificando armazenamento local', at: null };
let startupConflict = null;
let syncConflictActive = false;

// A persistência precisa existir ANTES da normalização inicial, porque normalizeState()
// salva migrações imediatamente ao carregar versões anteriores do workspace.
const persistenceAdapter = {
  kind: 'localStorage',
  async read() { return localStorage.getItem(STORAGE_KEY); },
  writeSync(value) { localStorage.setItem(STORAGE_KEY, value); },
  async write(value) { localStorage.setItem(STORAGE_KEY, value); },
  async health() { return { connected: true, kind: 'localStorage' }; }
};


function syncPresentation() {
  const map = {
    checking: { label: 'Checking…', cls: 'checking', icon: '◌' },
    syncing: { label: 'Syncing', cls: 'syncing', icon: '↻' },
    saved: { label: 'Saved locally', cls: 'saved', icon: '✓' },
    offline: { label: 'Offline changes', cls: 'offline', icon: '!' },
    browser: { label: 'Saved in browser', cls: 'browser', icon: '✓' },
    error: { label: 'Sync error', cls: 'error', icon: '!' }
  };
  return map[syncState.code] || map.checking;
}

function setSyncState(code, detail = '', { pending = syncState.pending, at = null } = {}) {
  syncState = { code, detail, pending, at: at || (['saved','browser'].includes(code) ? new Date().toISOString() : syncState.at) };
  updateSyncIndicator();
}

function updateSyncIndicator() {
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  const view = syncPresentation();
  el.className = `sync-indicator ${view.cls}`;
  el.innerHTML = `<span class="sync-icon">${view.icon}</span><span>${view.label}</span>`;
  const titleParts = [syncState.detail];
  if (syncState.at) titleParts.push(`Último salvamento: ${new Date(syncState.at).toLocaleString('pt-BR')}`);
  el.title = titleParts.filter(Boolean).join(' • ');
  el.setAttribute('aria-label', titleParts.filter(Boolean).join('. ') || view.label);
}

async function bridgeHeartbeat() {
  if (syncConflictActive) return;
  if (!state?.preferences?.bridgePrimaryEnabled) return;
  try {
    const wasConnected = bridgeStatus.connected && bridgeStatus.paired;
    const connected = await detectBridge({ quiet: true });
    if (!connected) {
      if (syncState.pending || syncState.code === 'syncing') setSyncState('offline', 'Alterações preservadas no navegador. O AgileFlow tentará sincronizar quando o Bridge voltar.', { pending: true });
      return;
    }
    if (!wasConnected || syncState.pending || syncState.code === 'offline' || syncState.code === 'error') {
      setSyncState('syncing', 'Bridge reconectado. Salvando alterações locais…', { pending: true });
      const ok = await bridgeWriteState(state);
      if (ok) {
        state.preferences.lastBridgeSyncAt = new Date().toISOString();
        bridgeStatus.workspaceExists = true;
        bridgeStatus.workspaceModified = state.meta?.lastSavedAt || state.preferences.lastBridgeSyncAt;
        persistenceAdapter.writeSync(JSON.stringify(state));
        setSyncState('saved', 'Workspace salvo em Documents/AgileFlow.', { pending: false, at: state.preferences.lastBridgeSyncAt });
      } else {
        setSyncState('error', 'Não foi possível gravar no Bridge. As alterações continuam preservadas no navegador.', { pending: true });
      }
    }
  } catch (error) {
    setSyncState('offline', 'Bridge temporariamente indisponível. Alterações preservadas no navegador.', { pending: true });
  }
}

function startBridgeHeartbeat() {
  if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
  bridgeHeartbeatTimer = setInterval(bridgeHeartbeat, 12000);
}

function bridgeRequestInit(init = {}) {
  const next = { mode: 'cors', cache: 'no-store', ...init };
  try {
    if (typeof Request !== 'undefined' && 'targetAddressSpace' in Request.prototype) next.targetAddressSpace = 'loopback';
  } catch {}
  return next;
}

async function bridgeFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem(BRIDGE_TOKEN_KEY);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${BRIDGE_BASE_URL}${path}`, bridgeRequestInit({ ...init, headers }));
}

async function detectBridge({ quiet = false } = {}) {
  bridgeStatus = { ...bridgeStatus, state: 'checking', error: null };
  if (!quiet) render();
  try {
    const healthRes = await bridgeFetch('/health');
    if (!healthRes.ok) throw new Error(`Health ${healthRes.status}`);
    const health = await healthRes.json();
    bridgeStatus = {
      state: 'connected', connected: true, paired: false,
      platform: health.platform || null, root: health.root || null, workspaceExists: Boolean(health.workspaceExists),
      workspaceModified: health.workspaceModified || null, version: health.version || null, error: null
    };
    // Refaz o pairing a cada detecção para recuperar automaticamente de token antigo/reinstalação.
    const pairRes = await bridgeFetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (pairRes.ok) {
      const pair = await pairRes.json();
      if (pair.token) { localStorage.setItem(BRIDGE_TOKEN_KEY, pair.token); bridgeStatus.paired = true; }
    }
  } catch (error) {
    bridgeStatus = { state: 'offline', connected: false, paired: false, platform: null, root: null, workspaceExists: false, workspaceModified: null, version: null, error: String(error?.message || error) };
  }
  if (!quiet) render();
  return bridgeStatus.connected && bridgeStatus.paired;
}

async function bridgeWriteState(value) {
  if (!bridgeStatus.connected || !bridgeStatus.paired) return false;
  try {
    const res = await bridgeFetch('/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: value }) });
    if (!res.ok) throw new Error(`Write ${res.status}`);
    bridgeStatus.workspaceExists = true;
    return true;
  } catch (error) {
    bridgeStatus.error = String(error?.message || error);
    return false;
  }
}

async function bridgeReadWorkspace() {
  if (!bridgeStatus.connected || !bridgeStatus.paired) throw new Error('Bridge desconectado');
  const res = await bridgeFetch('/workspace');
  if (!res.ok) throw new Error(res.status === 404 ? 'Nenhum workspace local encontrado.' : `Read ${res.status}`);
  const payload = await res.json();
  return { state: payload.state || payload, savedAt: payload.savedAt || null, bridgeVersion: payload.bridgeVersion || bridgeStatus.version || null };
}

async function bridgeReadState() {
  return (await bridgeReadWorkspace()).state;
}

async function bridgeCreateBackup() {
  if (!bridgeStatus.connected || !bridgeStatus.paired) throw new Error('Bridge desconectado');
  const res = await bridgeFetch('/backup', { method: 'POST' });
  if (!res.ok) throw new Error(`Backup ${res.status}`);
  return res.json();
}


let state;
let activeView = 'dashboard';
let modal = null;
let toastTimer = null;
const backlogFilters = { search: '', status: 'All', priority: 'All', epic: 'All' };
const boardFilters = { search: '', epic: 'All' };
const evidenceFilters = { search: '', source: 'All' };
const portfolioFilters = { search: '', project: 'All', skill: 'All' };
const growthFilters = { project: 'All', skill: 'All', year: 'All' };
const BOARD_STATUSES = ['Backlog','Ready','In Progress','Review','Done'];

const PROJECT_TEMPLATES = {
  'Scrum': {
    key: 'Scrum', icon: '◷', title: 'Scrum',
    description: 'Trabalho iterativo organizado em Sprints, com objetivo de ciclo, Review e Retrospective.',
    bestFor: 'Produtos e entregas incrementais com ciclos definidos.',
    modules: ['vision','planning','backlog','board','sprints','retro','decisions','impediments','evidence','caseStudy']
  },
  'Kanban': {
    key: 'Kanban', icon: '▤', title: 'Kanban',
    description: 'Fluxo contínuo de trabalho com foco em visualização, WIP e melhoria do fluxo.',
    bestFor: 'Operações, manutenção e projetos sem necessidade de Sprints.',
    modules: ['vision','planning','backlog','board','decisions','impediments','evidence','caseStudy']
  },
  'Hybrid': {
    key: 'Hybrid', icon: '◎', title: 'Hybrid',
    description: 'Combina Sprints, Kanban e práticas de gestão conforme o contexto do projeto.',
    bestFor: 'Projetos que precisam adaptar o método ao longo do trabalho.',
    modules: ['vision','planning','backlog','board','sprints','retro','decisions','impediments','evidence','caseStudy']
  },
  'Simple Project': {
    key: 'Simple Project', icon: '✓', title: 'Simple Project',
    description: 'Estrutura enxuta para organizar trabalho, decisões e resultados sem rituais obrigatórios.',
    bestFor: 'Projetos pessoais, pequenos trabalhos e iniciativas diretas.',
    modules: ['vision','planning','backlog','board','decisions','evidence','caseStudy']
  },
  'Learning / Academic': {
    key: 'Learning / Academic', icon: '◇', title: 'Learning / Academic',
    description: 'Organiza entregas acadêmicas, aprendizados, reflexões e evidências de desenvolvimento.',
    bestFor: 'Faculdade, cursos, pesquisas e projetos de aprendizagem.',
    modules: ['vision','planning','backlog','board','retro','decisions','evidence','caseStudy']
  }
};

function normalizeTemplate(value) {
  return PROJECT_TEMPLATES[value] ? value : 'Hybrid';
}

function projectTemplate(project) {
  return PROJECT_TEMPLATES[normalizeTemplate(project?.template || project?.method)] || PROJECT_TEMPLATES.Hybrid;
}

function projectModuleEnabled(project, view) {
  if (!project) return ['dashboard','projects','portfolio','growth','data','settings'].includes(view);
  if (['dashboard','projects','portfolio','growth','data','settings'].includes(view)) return true;
  return projectTemplate(project).modules.includes(view);
}

function projectModuleLabel(project, view, fallback) {
  const template = normalizeTemplate(project?.template || project?.method);
  if (view === 'backlog') {
    if (template === 'Simple Project') return 'Task Backlog';
    if (template === 'Learning / Academic') return 'Academic Backlog';
    if (template === 'Kanban') return 'Work Backlog';
  }
  if (view === 'board') {
    if (template === 'Simple Project') return 'Work Board';
    if (template === 'Learning / Academic') return 'Progress Board';
  }
  if (view === 'retro' && template === 'Learning / Academic') return 'Reflections';
  return fallback;
}


function templateModuleNames(templateKey) {
  const labels = {
    vision: 'Product Vision', planning: 'Goals, Milestones & Risks', backlog: 'Backlog', board: 'Board', sprints: 'Sprints', retro: 'Retrospectives / Reflections',
    decisions: 'Decision Log', impediments: 'Impediments', evidence: 'Evidence Hub', caseStudy: 'Case Study Builder'
  };
  const cfg = PROJECT_TEMPLATES[normalizeTemplate(templateKey)] || PROJECT_TEMPLATES.Hybrid;
  return cfg.modules.map(m => labels[m] || m);
}

// Initialize persisted state only after PROJECT_TEMPLATES and template helpers exist.
state = normalizeState(loadState());
if (!state.preferences.onboardingCompleted) modal = 'onboarding';

function defaultState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { name: 'Rachel' },
    preferences: { theme: 'light', onboardingCompleted: false, backupReminderDays: 7, lastSeenVersion: null },
    currentProjectId: 'agileflow',
    projects: [createAgileFlowProject(now)],
    activities: [
      { id: uid(), projectId: 'agileflow', title: 'Projeto criado', detail: 'AgileFlow v0.1 iniciado.', at: now },
      { id: uid(), projectId: 'agileflow', title: 'Decisão de arquitetura', detail: 'WebApp no Netlify com persistência local planejada via Bridge.', at: now },
      { id: uid(), projectId: 'agileflow', title: 'Backlog estruturado', detail: 'Epics e User Stories iniciais adicionados ao próprio projeto AgileFlow.', at: now }
    ]
  };
}

function createAgileFlowProject(now) {
  return {
    id: 'agileflow',
    keyPrefix: 'AF',
    storyCounter: 6,
    name: 'AgileFlow',
    description: 'Workspace pessoal para gestão de projetos e construção de portfólio profissional.',
    method: 'Hybrid',
    template: 'Hybrid',
    setup: { challenge: 'Organizar projetos reais e transformar experiência em evidência profissional.', goal: 'Criar um workspace pessoal de gestão e portfólio.', stakeholders: 'Rachel', deadline: '', successCriteria: 'Gerenciar projetos reais com dados locais e gerar evidências profissionais.' },
    status: 'Active',
    progress: 18,
    createdAt: now,
    updatedAt: now,
    vision: {
      problem: 'Organizar projetos reais e transformar experiências de gestão em evidências profissionais estruturadas.',
      vision: 'Criar um workspace pessoal, local-first e multiplataforma para gerenciar projetos e acompanhar crescimento profissional.',
      objectives: 'Validar um fluxo simples de gestão de projetos, manter custo adicional zero e preparar uma base para portfólio.',
      successCriteria: 'Criar projetos, definir visão, estruturar backlog, acompanhar trabalho e preservar os dados entre sessões.',
      constraints: 'Custo adicional zero; compatibilidade com Windows 10/11 e macOS Monterey em Intel; interface leve.'
    },
    goals: [],
    milestones: [],
    risks: [],
    epics: seedEpics(now),
    stories: seedStories(now),
    sprints: [],
    retrospectives: [],
    decisions: [],
    impediments: [],
    evidence: [],
    caseStudy: {
      title: 'AgileFlow — Product Case Study', role: '', period: '', challenge: '', responsibilities: '', approach: '', results: '', lessons: '', status: 'Draft', selectedEvidence: []
    }
  };
}

function seedEpics(now) {
  return [
    { id: 'epic-foundation', title: 'Project Foundation', description: 'Base do workspace, projetos e estrutura de produto.', createdAt: now },
    { id: 'epic-delivery', title: 'Agile Delivery', description: 'Backlog, fluxo, Sprints e acompanhamento do trabalho.', createdAt: now },
    { id: 'epic-portfolio', title: 'Portfolio & Growth', description: 'Evidências, case studies e crescimento profissional.', createdAt: now }
  ];
}

function seedStories(now) {
  const data = [
    ['AF-001','Visualizar meus projetos','Como usuária','quero abrir o AgileFlow e visualizar meus projetos','para saber rapidamente em que estou trabalhando.','epic-foundation','High',5,'Done'],
    ['AF-002','Criar um projeto','Como usuária','quero criar projetos independentes','para usar a ferramenta em diferentes iniciativas.','epic-foundation','High',5,'Done'],
    ['AF-003','Definir Product Vision','Como usuária','quero registrar a visão do projeto','para manter problema, objetivos e critérios de sucesso claros.','epic-foundation','High',5,'Done'],
    ['AF-004','Organizar Epics','Como usuária','quero agrupar grandes áreas de trabalho em Epics','para estruturar melhor o escopo do projeto.','epic-delivery','High',3,'In Progress'],
    ['AF-005','Criar User Stories','Como usuária','quero registrar User Stories com contexto e critérios de aceite','para transformar necessidades em trabalho gerenciável.','epic-delivery','High',5,'Ready'],
    ['AF-006','Priorizar Product Backlog','Como usuária','quero filtrar e priorizar o backlog','para decidir o que merece atenção primeiro.','epic-delivery','High',5,'Ready']
  ];
  return data.map(([key,title,asA,iWant,soThat,epicId,priority,storyPoints,status]) => ({
    id: uid(), key, title, asA, iWant, soThat, epicId, priority, businessValue: 4, storyPoints, status,
    acceptanceCriteria: '', sprintId: null, createdAt: now, updatedAt: now
  }));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : defaultState();
  } catch {
    return defaultState();
  }
}


function normalizeState(input) {
  const base = input && typeof input === 'object' ? input : defaultState();
  base.schemaVersion = SCHEMA_VERSION;
  base.profile = base.profile || { name: 'Rachel' };
  base.preferences = base.preferences || {};
  base.preferences.theme = base.preferences.theme === 'dark' ? 'dark' : 'light';
  base.preferences.lastBackupAt = base.preferences.lastBackupAt || null;
  base.preferences.bridgeMirrorEnabled = Boolean(base.preferences.bridgeMirrorEnabled);
  base.preferences.bridgePrimaryEnabled = Boolean(base.preferences.bridgePrimaryEnabled || base.preferences.bridgeMirrorEnabled);
  base.preferences.lastBridgeSyncAt = base.preferences.lastBridgeSyncAt || null;
  base.preferences.onboardingCompleted = Boolean(base.preferences.onboardingCompleted);
  base.preferences.backupReminderDays = [0,3,7,14,30].includes(Number(base.preferences.backupReminderDays)) ? Number(base.preferences.backupReminderDays) : 7;
  base.preferences.lastSeenVersion = base.preferences.lastSeenVersion || null;
  base.meta = base.meta || {};
  base.meta.lastSavedAt = base.meta.lastSavedAt || null;
  base.projects = Array.isArray(base.projects) ? base.projects : [];
  base.activities = Array.isArray(base.activities) ? base.activities : [];

  base.projects = base.projects.map(project => {
    const p = { ...project };
    p.template = normalizeTemplate(p.template || p.method);
    p.method = p.template;
    p.setup = p.setup && typeof p.setup === 'object' ? p.setup : {};
    p.setup = { challenge: p.setup.challenge || p.vision?.problem || '', goal: p.setup.goal || p.vision?.objectives || '', stakeholders: p.setup.stakeholders || '', deadline: p.setup.deadline || '', successCriteria: p.setup.successCriteria || p.vision?.successCriteria || '' };
    p.vision = p.vision || {};
    p.keyPrefix = p.keyPrefix || derivePrefix(p.name || 'Project');
    const hadEpicField = Array.isArray(p.epics);
    const hadStoryField = Array.isArray(p.stories);
    p.epics = hadEpicField ? p.epics : [];
    p.stories = hadStoryField ? p.stories : [];
    p.sprints = Array.isArray(p.sprints) ? p.sprints : [];
    p.sprints = p.sprints.map(sprint => ({
      id: sprint.id || uid(),
      name: sprint.name || 'Sprint',
      goal: sprint.goal || '',
      startDate: sprint.startDate || '',
      endDate: sprint.endDate || '',
      capacity: Number(sprint.capacity) || 0,
      status: ['Planned','Active','Completed'].includes(sprint.status) ? sprint.status : 'Planned',
      createdAt: sprint.createdAt || new Date().toISOString(),
      startedAt: sprint.startedAt || null,
      completedAt: sprint.completedAt || null,
      snapshot: sprint.snapshot || null
    }));
    p.retrospectives = Array.isArray(p.retrospectives) ? p.retrospectives : [];
    p.retrospectives = p.retrospectives.map(retro => ({
      id: retro.id || uid(),
      sprintId: retro.sprintId || null,
      title: retro.title || '',
      wentWell: retro.wentWell || '',
      didntGoWell: retro.didntGoWell || '',
      learned: retro.learned || '',
      changeNext: retro.changeNext || '',
      includeInPortfolio: Boolean(retro.includeInPortfolio),
      createdAt: retro.createdAt || new Date().toISOString(),
      updatedAt: retro.updatedAt || retro.createdAt || new Date().toISOString(),
      actionItems: Array.isArray(retro.actionItems) ? retro.actionItems.map(item => ({
        id: item.id || uid(),
        text: item.text || '',
        status: item.status === 'Done' ? 'Done' : 'Open',
        createdAt: item.createdAt || retro.createdAt || new Date().toISOString(),
        completedAt: item.completedAt || null
      })).filter(item => item.text) : []
    }));
    p.decisions = Array.isArray(p.decisions) ? p.decisions : [];
    p.decisions = p.decisions.map(decision => ({
      id: decision.id || uid(),
      title: decision.title || '',
      context: decision.context || '',
      alternatives: decision.alternatives || '',
      decision: decision.decision || '',
      reason: decision.reason || '',
      impact: decision.impact || '',
      sprintId: decision.sprintId || null,
      includeInPortfolio: Boolean(decision.includeInPortfolio),
      createdAt: decision.createdAt || new Date().toISOString(),
      updatedAt: decision.updatedAt || decision.createdAt || new Date().toISOString()
    }));
    p.impediments = Array.isArray(p.impediments) ? p.impediments : [];
    p.impediments = p.impediments.map(item => ({
      id: item.id || uid(),
      title: item.title || '',
      description: item.description || '',
      impact: item.impact || '',
      severity: ['Critical','High','Medium','Low'].includes(item.severity) ? item.severity : 'Medium',
      status: item.status === 'Resolved' ? 'Resolved' : 'Active',
      nextStep: item.nextStep || '',
      resolution: item.resolution || '',
      sprintId: item.sprintId || null,
      includeInPortfolio: Boolean(item.includeInPortfolio),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      resolvedAt: item.resolvedAt || null
    }));
    p.goals = Array.isArray(p.goals) ? p.goals : [];
    p.goals = p.goals.map(item => ({
      id: item.id || uid(), title: item.title || '', description: item.description || '',
      status: ['Planned','In Progress','Achieved','Dropped'].includes(item.status) ? item.status : 'Planned',
      targetDate: item.targetDate || '', successMeasure: item.successMeasure || '',
      createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
    }));
    p.milestones = Array.isArray(p.milestones) ? p.milestones : [];
    p.milestones = p.milestones.map(item => ({
      id: item.id || uid(), title: item.title || '', description: item.description || '', goalId: item.goalId || null,
      status: ['Upcoming','In Progress','Completed','Missed'].includes(item.status) ? item.status : 'Upcoming',
      dueDate: item.dueDate || '', includeInPortfolio: Boolean(item.includeInPortfolio),
      createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(), completedAt: item.completedAt || null
    }));
    p.risks = Array.isArray(p.risks) ? p.risks : [];
    p.risks = p.risks.map(item => ({
      id: item.id || uid(), title: item.title || '', description: item.description || '',
      probability: ['Low','Medium','High'].includes(item.probability) ? item.probability : 'Medium',
      impact: ['Low','Medium','High'].includes(item.impact) ? item.impact : 'Medium',
      response: ['Avoid','Reduce','Transfer','Accept'].includes(item.response) ? item.response : 'Reduce',
      mitigation: item.mitigation || '', status: ['Open','Monitoring','Mitigated','Closed'].includes(item.status) ? item.status : 'Open',
      includeInPortfolio: Boolean(item.includeInPortfolio), createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(), closedAt: item.closedAt || null
    }));
    p.evidence = Array.isArray(p.evidence) ? p.evidence : [];
    p.evidence = p.evidence.map(item => ({
      id: item.id || uid(),
      title: item.title || '',
      type: ['Result','Artifact','Feedback','Learning','Milestone','Other'].includes(item.type) ? item.type : 'Other',
      summary: item.summary || '',
      outcome: item.outcome || '',
      skills: Array.isArray(item.skills) ? item.skills : String(item.skills || '').split(',').map(v=>v.trim()).filter(Boolean),
      reference: item.reference || '',
      date: item.date || '',
      featured: Boolean(item.featured),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
    }));
    p.caseStudy = p.caseStudy && typeof p.caseStudy === 'object' ? p.caseStudy : {};
    p.caseStudy = {
      title: p.caseStudy.title || `${p.name || 'Project'} — Case Study`,
      role: p.caseStudy.role || '',
      period: p.caseStudy.period || '',
      challenge: p.caseStudy.challenge || '',
      responsibilities: p.caseStudy.responsibilities || '',
      approach: p.caseStudy.approach || '',
      results: p.caseStudy.results || '',
      lessons: p.caseStudy.lessons || '',
      status: p.caseStudy.status === 'Ready' ? 'Ready' : 'Draft',
      selectedEvidence: Array.isArray(p.caseStudy.selectedEvidence) ? p.caseStudy.selectedEvidence : []
    };

    // Migração suave da v0.1: só semeia o backlog do projeto AgileFlow quando esses campos ainda nem existiam.
    if (p.id === 'agileflow' && !hadEpicField && !hadStoryField) {
      const now = new Date().toISOString();
      p.epics = seedEpics(now);
      p.stories = seedStories(now);
      p.progress = Math.max(Number(p.progress) || 0, 18);
    }

    p.storyCounter = Number(p.storyCounter) || maxStoryNumber(p.stories);
    return p;
  });

  if (!base.currentProjectId && base.projects[0]) base.currentProjectId = base.projects[0].id;
  saveStateObject(base, { touch: false });
  return base;
}

function saveStateObject(value, { touch = true } = {}) {
  if (touch) {
    value.meta = value.meta || {};
    value.meta.lastSavedAt = new Date().toISOString();
  }
  persistenceAdapter.writeSync(JSON.stringify(value));
  if (value?.preferences?.bridgePrimaryEnabled) {
    if (bridgeStatus.connected && bridgeStatus.paired) {
      setSyncState('syncing', 'Salvando alterações em Documents/AgileFlow…', { pending: true });
      scheduleBridgeWrite(value);
    } else {
      setSyncState('offline', 'Alterações salvas no navegador e aguardando o Local Bridge.', { pending: true });
    }
  } else {
    setSyncState('browser', 'Workspace salvo neste navegador.', { pending: false, at: value.meta?.lastSavedAt });
  }
}

function scheduleBridgeWrite(value) {
  clearTimeout(bridgeSyncTimer);
  bridgeSyncTimer = setTimeout(async () => {
    const ok = await bridgeWriteState(value);
    if (ok) {
      value.preferences.lastBridgeSyncAt = new Date().toISOString();
      persistenceAdapter.writeSync(JSON.stringify(value));
      bridgeStatus.workspaceExists = true;
      bridgeStatus.workspaceModified = value.meta?.lastSavedAt || value.preferences.lastBridgeSyncAt;
      setSyncState('saved', 'Workspace salvo em Documents/AgileFlow.', { pending: false, at: value.preferences.lastBridgeSyncAt });
      if (activeView === 'data') render();
    } else {
      setSyncState('offline', 'Não foi possível alcançar o Bridge. As alterações continuam no navegador e serão sincronizadas quando ele voltar.', { pending: true });
    }
  }, 220);
}

function saveState() {
  saveStateObject(state);
}

function stateTimestamp(value) {
  const raw = value?.meta?.lastSavedAt || value?.preferences?.lastBridgeSyncAt || null;
  const t = raw ? Date.parse(raw) : 0;
  return Number.isFinite(t) ? t : 0;
}

async function initializeLocalFirst() {
  try {
    const connected = await detectBridge({ quiet: true });
    if (!connected || !state.preferences.bridgePrimaryEnabled) {
      setSyncState(state.preferences.bridgePrimaryEnabled ? 'offline' : 'browser', state.preferences.bridgePrimaryEnabled ? 'Local Bridge não detectado. Trabalhando com fallback no navegador.' : 'Workspace salvo neste navegador.', { pending: Boolean(state.preferences.bridgePrimaryEnabled), at: state.meta?.lastSavedAt });
      bridgeStartupResolved = true; render(); startBridgeHeartbeat(); return;
    }

    if (!bridgeStatus.workspaceExists) {
      const ok = await bridgeWriteState(state);
      if (ok) {
        state.preferences.lastBridgeSyncAt = new Date().toISOString();
        persistenceAdapter.writeSync(JSON.stringify(state));
        bridgeStatus.workspaceExists = true;
      }
      if (ok) setSyncState('saved', 'Workspace inicial salvo em Documents/AgileFlow.', { pending: false, at: state.preferences.lastBridgeSyncAt });
      else setSyncState('offline', 'O Bridge foi detectado, mas não foi possível gravar o workspace. As alterações permanecem no navegador.', { pending: true });
      bridgeStartupResolved = true; render(); startBridgeHeartbeat(); return;
    }

    const localSnapshot = state;
    const localTs = stateTimestamp(localSnapshot);
    const remote = await bridgeReadWorkspace();
    const remoteCandidate = remote?.state;
    if (!remoteCandidate || !Array.isArray(remoteCandidate.projects)) throw new Error('Workspace local inválido');
    const remoteTs = stateTimestamp(remoteCandidate) || (remote.savedAt ? Date.parse(remote.savedAt) : 0);

    if (localTs && remoteTs && Math.abs(localTs - remoteTs) > 1500) {
      startupConflict = { local: localSnapshot, remote: remoteCandidate, localTs, remoteTs, remoteSavedAt: remote.savedAt || null };
      syncConflictActive = true;
      modal = { type: 'sync-conflict' };
      setSyncState('checking', 'Duas versões diferentes foram encontradas. Escolha qual deve continuar como principal.', { pending: true });
      return;
    }

    if (localTs > remoteTs + 1000) {
      await bridgeWriteState(localSnapshot);
      state.preferences.lastBridgeSyncAt = new Date().toISOString();
      persistenceAdapter.writeSync(JSON.stringify(state));
      setSyncState('saved', 'Alterações offline sincronizadas com Documents/AgileFlow.', { pending: false, at: state.preferences.lastBridgeSyncAt });
    } else {
      state = normalizeState(remoteCandidate);
      state.preferences.bridgePrimaryEnabled = true;
      state.preferences.bridgeMirrorEnabled = true;
      state.preferences.lastBridgeSyncAt = remote.savedAt || new Date().toISOString();
      persistenceAdapter.writeSync(JSON.stringify(state));
      setSyncState('saved', 'Workspace carregado de Documents/AgileFlow.', { pending: false, at: state.preferences.lastBridgeSyncAt });
    }
  } catch (error) {
    console.error('Local-first startup:', error);
    bridgeStatus.error = String(error?.message || error);
    setSyncState('offline', 'Falha ao acessar os arquivos locais. O cache do navegador permanece disponível.', { pending: true });
  } finally {
    bridgeStartupResolved = true;
    if (!syncConflictActive) {
      if (state.preferences.onboardingCompleted && modal === 'onboarding') modal = null;
      if (!state.preferences.onboardingCompleted && !modal) modal = 'onboarding';
    }
    render();
    startBridgeHeartbeat();
  }
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function applyTheme() {
  const theme = state.preferences?.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name=\"theme-color\"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d1220' : '#1457d9');
}

function currentProject() {
  return state.projects.find(p => p.id === state.currentProjectId) || state.projects[0] || null;
}

function addActivity(title, detail, projectId = state.currentProjectId) {
  state.activities.unshift({ id: uid(), projectId, title, detail, at: new Date().toISOString() });
  state.activities = state.activities.slice(0, 80);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(iso) {
  try { return new Intl.DateTimeFormat('pt-BR', { day:'2-digit', month:'short', year:'numeric' }).format(new Date(iso)); }
  catch { return ''; }
}


function daysSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function backupReminderDue() {
  const days = Number(state.preferences?.backupReminderDays ?? 7);
  if (!days) return false;
  return daysSince(state.preferences?.lastBackupAt) >= days;
}

function renderBackupReminder() {
  if (!backupReminderDue()) return '';
  const last = state.preferences?.lastBackupAt ? `${daysSince(state.preferences.lastBackupAt)} dia(s) atrás` : 'ainda não realizado';
  return `<div class="release-alert backup-alert"><div><strong>Backup recomendado</strong><span>Último backup: ${escapeHtml(last)}. Um backup completo protege projetos, histórico e portfólio.</span></div><button class="btn btn-soft" data-action="backup-now">Criar backup agora</button></div>`;
}

function createDemoProject() {
  const existing = state.projects.find(p => p.id === 'agileflow-demo-project');
  if (existing) {
    state.currentProjectId = existing.id;
    activeView = 'dashboard';
    saveState();
    return existing;
  }
  const now = new Date().toISOString();
  const epicId = uid();
  const project = {
    id: 'agileflow-demo-project', keyPrefix: 'DEMO', storyCounter: 4,
    name: 'Projeto Demo — Workshop Online', description: 'Projeto fictício para aprender o fluxo do AgileFlow sem alterar um projeto real.',
    method: 'Hybrid', template: 'Hybrid', status: 'Active', progress: 42, createdAt: now, updatedAt: now,
    setup: { challenge: 'Organizar o lançamento de um workshop online.', goal: 'Publicar a primeira edição com inscrições, conteúdo e feedback organizados.', stakeholders: 'Responsável pelo projeto, participantes', deadline: '4 semanas', successCriteria: 'Workshop publicado e feedback registrado.' },
    vision: { problem: 'O lançamento precisa de escopo, prioridades e acompanhamento claros.', vision: 'Criar um fluxo simples e repetível para lançar workshops.', objectives: 'Planejar conteúdo, inscrições, divulgação e feedback.', successCriteria: 'Entregas principais concluídas e feedback coletado.', constraints: 'Equipe pequena e orçamento limitado.' },
    goals: [{ id: uid(), title: 'Realizar a primeira edição', description: 'Preparar e entregar o workshop.', status: 'In Progress', targetDate: '', successMeasure: 'Workshop realizado com feedback coletado.', createdAt: now, updatedAt: now }],
    milestones: [{ id: uid(), title: 'Página de inscrição pronta', description: 'Fluxo de inscrição validado.', goalId: null, status: 'Completed', dueDate: '', includeInPortfolio: false, createdAt: now, updatedAt: now, completedAt: now }],
    risks: [{ id: uid(), title: 'Baixo número de inscrições', description: 'Divulgação pode não gerar inscrições suficientes.', probability: 'Medium', impact: 'High', response: 'Reduce', mitigation: 'Validar mensagem e iniciar divulgação antecipadamente.', status: 'Monitoring', includeInPortfolio: false, createdAt: now, updatedAt: now, closedAt: null }],
    epics: [{ id: epicId, title: 'Launch', description: 'Preparação e lançamento do workshop.', createdAt: now }],
    stories: [
      { id: uid(), key: 'DEMO-001', title: 'Definir proposta do workshop', asA: 'Como responsável pelo projeto', iWant: 'definir a proposta e o público', soThat: 'a comunicação seja clara', epicId, priority: 'High', businessValue: 5, storyPoints: 3, status: 'Done', acceptanceCriteria: 'Proposta e público documentados.', sprintId: null, createdAt: now, updatedAt: now },
      { id: uid(), key: 'DEMO-002', title: 'Preparar página de inscrição', asA: 'Como participante', iWant: 'entender e me inscrever facilmente', soThat: 'eu consiga confirmar minha participação', epicId, priority: 'High', businessValue: 5, storyPoints: 5, status: 'Done', acceptanceCriteria: 'Página revisada e formulário testado.', sprintId: null, createdAt: now, updatedAt: now },
      { id: uid(), key: 'DEMO-003', title: 'Planejar divulgação', asA: 'Como responsável pelo projeto', iWant: 'organizar os canais de divulgação', soThat: 'o público seja alcançado', epicId, priority: 'High', businessValue: 4, storyPoints: 5, status: 'In Progress', acceptanceCriteria: 'Canais, mensagens e datas definidos.', sprintId: null, createdAt: now, updatedAt: now },
      { id: uid(), key: 'DEMO-004', title: 'Coletar feedback', asA: 'Como responsável pelo projeto', iWant: 'coletar feedback após o workshop', soThat: 'a próxima edição possa melhorar', epicId, priority: 'Medium', businessValue: 4, storyPoints: 3, status: 'Ready', acceptanceCriteria: 'Questionário preparado e forma de análise definida.', sprintId: null, createdAt: now, updatedAt: now }
    ],
    sprints: [], retrospectives: [], decisions: [], impediments: [],
    evidence: [{ id: uid(), title: 'Primeira estrutura do lançamento', type: 'Learning', summary: 'Exemplo de evidência criada durante o projeto-demo.', outcome: 'Demonstra como registrar contexto e aprendizado.', skills: ['Planning','Prioritization'], reference: '', date: now.slice(0,10), featured: true, createdAt: now, updatedAt: now }],
    caseStudy: { title: 'Projeto Demo — Case Study', role: '', period: '', challenge: '', responsibilities: '', approach: '', results: '', lessons: '', status: 'Draft', selectedEvidence: [] }
  };
  state.projects.push(project);
  state.currentProjectId = project.id;
  addActivity('Projeto demo adicionado', 'Um projeto fictício foi criado para explorar o AgileFlow com segurança.', project.id);
  saveState();
  return project;
}

function renderSettings() {
  const reminder = Number(state.preferences?.backupReminderDays ?? 7);
  const localPath = bridgeStatus.root || 'Documents/AgileFlow';
  const lastBackup = state.preferences?.lastBackupAt ? new Date(state.preferences.lastBackupAt).toLocaleString('pt-BR') : 'Nenhum backup registrado';
  return `
    <div class="page-head"><div><div class="eyebrow">Stable release • Personal workspace</div><h1>Settings</h1><p>Preferências, diagnóstico e segurança do AgileFlow.</p></div><button class="btn btn-soft" data-action="open-help">? Guia rápido</button></div>
    ${renderBackupReminder()}
    <div class="settings-grid">
      <section class="card card-pad settings-panel"><div class="section-title"><div><h2>Perfil e aparência</h2><p>Personalize somente o que aparece neste workspace.</p></div></div>
        <form id="settingsForm" class="form-grid">
          <div class="field full"><label>Nome exibido</label><input name="profileName" maxlength="80" value="${escapeHtml(state.profile?.name || 'Rachel')}" /></div>
          <div class="field"><label>Tema</label><select name="theme"><option value="light" ${state.preferences.theme==='light'?'selected':''}>Claro</option><option value="dark" ${state.preferences.theme==='dark'?'selected':''}>Escuro</option></select></div>
          <div class="field"><label>Lembrete de backup</label><select name="backupReminderDays"><option value="0" ${reminder===0?'selected':''}>Desativado</option>${[3,7,14,30].map(v=>`<option value="${v}" ${reminder===v?'selected':''}>A cada ${v} dias</option>`).join('')}</select></div>
          <div class="form-actions full"><button class="btn btn-primary">Salvar preferências</button></div>
        </form>
      </section>
      <section class="card card-pad settings-panel"><div class="section-title"><div><h2>Local Bridge</h2><p>Diagnóstico da conexão local.</p></div><span class="bridge-status ${bridgeStatus.connected?'online':'offline'}"><i></i>${bridgeStatus.connected?'Conectado':'Não detectado'}</span></div>
        <div class="settings-kv"><span>WebApp</span><strong>AgileFlow ${escapeHtml(APP_VERSION)} Stable</strong><span>Host atual</span><strong>${escapeHtml(hostingProvider())}</strong><span>Origem</span><strong class="path-value">${escapeHtml(hostingOrigin())}</strong><span>Bridge</span><strong>${escapeHtml(bridgeStatus.version || '—')}</strong><span>Plataforma</span><strong>${escapeHtml(bridgeStatus.platform || '—')}</strong><span>Pasta</span><strong class="path-value">${escapeHtml(localPath)}</strong></div>
        <div class="data-actions wrap"><button class="btn btn-primary" data-action="bridge-detect">Verificar Bridge</button><button class="btn btn-ghost" data-action="copy-local-path">Copiar caminho da pasta</button></div>
      </section>
      <section class="card card-pad settings-panel"><div class="section-title"><div><h2>Segurança dos dados</h2><p>Antes de grandes mudanças, gere uma cópia independente.</p></div></div>
        <div class="settings-kv"><span>Último backup</span><strong>${escapeHtml(lastBackup)}</strong><span>Modo</span><strong>${state.preferences.bridgePrimaryEnabled?'Local-first + browser fallback':'Browser storage'}</strong><span>Status atual</span><strong>${escapeHtml(syncPresentation().label)}</strong></div>
        <div class="data-actions wrap"><button class="btn btn-pink" data-action="backup-now">Criar backup agora</button><button class="btn btn-ghost" data-view="data">Abrir Data & Backup</button></div>
      </section>
      <section class="card card-pad settings-panel"><div class="section-title"><div><h2>Ajuda e primeiro uso</h2><p>Reabra o guia ou explore um projeto fictício.</p></div></div>
        <div class="settings-actions"><button class="btn btn-soft" data-action="restart-onboarding">Abrir boas-vindas</button><button class="btn btn-ghost" data-action="add-demo-project">Adicionar projeto-demo</button></div>
      </section>
    </div>`;
}

function renderHelpModal() {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal help-modal" onclick="event.stopPropagation()"><div class="modal-head"><div><div class="wizard-kicker">AgileFlow Guide</div><h2>Como usar no dia a dia</h2><p>Um fluxo simples para transformar trabalho real em aprendizado e portfólio.</p></div><button class="icon-btn" data-action="close-modal">×</button></div><div class="modal-body">
    <div class="help-flow"><span>1. Project</span><b>→</b><span>2. Plan</span><b>→</b><span>3. Work</span><b>→</b><span>4. Review</span><b>→</b><span>5. Evidence</span><b>→</b><span>6. Portfolio</span></div>
    <div class="help-grid">
      <article><strong>Epic</strong><p>Grande área de trabalho que agrupa Stories relacionadas.</p></article><article><strong>Story Points</strong><p>Estimativa relativa de esforço e complexidade; não é nota de produtividade.</p></article><article><strong>WIP</strong><p>Work in Progress: quantidade de trabalho em execução ao mesmo tempo.</p></article><article><strong>Acceptance Criteria</strong><p>Condições objetivas para considerar uma Story concluída.</p></article><article><strong>Retrospective</strong><p>Reflexão sobre o processo para decidir o que manter ou melhorar.</p></article><article><strong>Risk Score</strong><p>Exposição calculada pela combinação de probabilidade e impacto.</p></article>
    </div><div class="safety-note"><strong>Dica de portfólio.</strong><span>Registre decisões, problemas, resultados e aprendizados durante o projeto. Evidência real vale mais do que reconstruir a história no final.</span></div>
    <div class="form-actions"><button class="btn btn-primary" data-action="close-modal">Entendi</button></div></div></div></div>`;
}

function renderOnboardingModal() {
  return `<div class="modal-backdrop onboarding-backdrop"><div class="modal onboarding-modal" onclick="event.stopPropagation()"><div class="onboarding-brand"><div class="brand-mark">AF</div><div><div class="wizard-kicker">Welcome to AgileFlow</div><h2>Projetos hoje. Portfólio amanhã.</h2></div></div><p class="onboarding-lead">Use o AgileFlow para organizar qualquer projeto, registrar decisões e transformar experiências reais em evidências profissionais.</p>
    <div class="onboarding-steps"><article><span>1</span><strong>Crie o projeto</strong><p>Escolha Scrum, Kanban, Hybrid, Simple ou Academic.</p></article><article><span>2</span><strong>Gerencie o trabalho</strong><p>Use backlog, board, goals, risks, Sprints e decisões conforme o contexto.</p></article><article><span>3</span><strong>Registre evidências</strong><p>Marque resultados, decisões e aprendizados relevantes.</p></article><article><span>4</span><strong>Construa o portfólio</strong><p>O histórico alimenta Growth, Portfolio e Case Study.</p></article></div>
    <div class="onboarding-storage"><strong>${bridgeStatus.connected?'✓ Local Bridge conectado':'○ Local Bridge será verificado automaticamente'}</strong><span>Os dados continuam locais; o WebApp não exige banco online.</span></div>
    <div class="onboarding-actions"><button class="btn btn-ghost" data-action="onboarding-demo">Explorar projeto-demo</button><button class="btn btn-primary" data-action="onboarding-finish">Entrar no AgileFlow</button></div>
  </div></div>`;
}

function renderConflictModal() {
  if (!startupConflict) return '';
  const browserNewer = startupConflict.localTs > startupConflict.remoteTs;
  const browserDate = startupConflict.localTs ? new Date(startupConflict.localTs).toLocaleString('pt-BR') : 'sem data';
  const localDate = startupConflict.remoteTs ? new Date(startupConflict.remoteTs).toLocaleString('pt-BR') : 'sem data';
  return `<div class="modal-backdrop"><div class="modal conflict-modal"><div class="modal-head"><div><div class="wizard-kicker">Data safety</div><h2>Duas versões diferentes foram encontradas</h2><p>Escolha conscientemente qual cópia deve continuar como principal. Nenhuma será substituída antes da sua decisão.</p></div></div><div class="modal-body"><div class="conflict-grid"><article class="${browserNewer?'recommended':''}"><small>Navegador</small><strong>${browserNewer?'Mais recente':'Cópia disponível'}</strong><span>${escapeHtml(browserDate)}</span><button class="btn btn-primary" data-action="conflict-use-browser">Usar esta cópia</button></article><article class="${!browserNewer?'recommended':''}"><small>Documents/AgileFlow</small><strong>${!browserNewer?'Mais recente':'Cópia disponível'}</strong><span>${escapeHtml(localDate)}</span><button class="btn btn-primary" data-action="conflict-use-local">Usar esta cópia</button></article></div><div class="safety-note"><strong>Quer segurança extra?</strong><span>“Backup e usar a mais recente” cria um backup local pelo Bridge antes de continuar.</span></div><div class="form-actions"><button class="btn btn-pink" data-action="conflict-backup-newer">Backup e usar a mais recente</button></div></div></div></div>`;
}

function icon(name) {
  const map = {
    dashboard: '◫', projects: '▣', vision: '◎', planning: '◆', backlog: '☷', board: '▤', sprints: '◷',
    retro: '↺', decisions: '◇', impediments: '⚑', evidence: '★', portfolio: '✦', growth: '↗', caseStudy: '▧', data: '⇩', settings: '⚙'
  };
  return map[name] || '•';
}

function render() {
  applyTheme();
  const project = currentProject();
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">AF</div>
          <div class="brand-copy"><strong>AgileFlow</strong><small>Personal workspace</small></div>
        </div>
        <nav class="nav">
          ${navButton('dashboard','Dashboard')}
          ${navButton('projects','Projects')}
          ${projectModuleEnabled(project,'vision') ? navButton('vision','Product Vision') : ''}
          ${projectModuleEnabled(project,'planning') ? navButton('planning','Goals & Risks') : ''}
          ${projectModuleEnabled(project,'backlog') ? navButton('backlog',projectModuleLabel(project,'backlog','Product Backlog')) : ''}
          ${projectModuleEnabled(project,'board') ? navButton('board',projectModuleLabel(project,'board','Kanban Board')) : ''}
          ${projectModuleEnabled(project,'sprints') ? navButton('sprints','Sprints') : ''}
          ${projectModuleEnabled(project,'retro') ? navButton('retro',projectModuleLabel(project,'retro','Retrospectives')) : ''}
          ${projectModuleEnabled(project,'decisions') ? navButton('decisions','Decision Log') : ''}
          ${projectModuleEnabled(project,'impediments') ? navButton('impediments','Impediments') : ''}
          ${projectModuleEnabled(project,'evidence') ? navButton('evidence','Evidence') : ''}
          ${navButton('portfolio','My Portfolio')}
          ${projectModuleEnabled(project,'caseStudy') ? navButton('caseStudy','Case Study Builder') : ''}
          ${navButton('growth','Professional Growth')}
          ${navButton('data','Data & Backup')}
          ${navButton('settings','Settings')}
        </nav>
        <div class="sidebar-foot">
          <strong>1.0 Stable • Ready for daily use</strong>
          <small>Onboarding, segurança de dados, diagnóstico e acabamento para o primeiro lançamento.</small>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div class="project-switcher">
            <button class="mobile-top" id="menuBtn">☰</button>
            <label for="projectSelect" style="font-size:12px;color:var(--muted);font-weight:700">Projeto atual</label>
            <select id="projectSelect" ${state.projects.length ? '' : 'disabled'}>
              ${state.projects.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === state.currentProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="topbar-actions">
            ${(() => { const v = syncPresentation(); return `<div id="syncIndicator" class="sync-indicator ${v.cls}" title="${escapeHtml(syncState.detail || v.label)}"><span class="sync-icon">${v.icon}</span><span>${v.label}</span></div>`; })()}
            <button class="help-button" data-action="open-help" type="button" aria-label="Abrir guia rápido" title="Guia rápido">?</button>
            <button class="theme-toggle" id="themeToggle" type="button" aria-label="Alternar modo claro e escuro" title="Alternar tema"><span class="theme-toggle-icon">${state.preferences.theme === 'dark' ? '☀' : '☾'}</span><span class="theme-toggle-label">${state.preferences.theme === 'dark' ? 'Claro' : 'Escuro'}</span></button>
            <div class="connection"><span class="dot"></span> ${state.preferences.bridgePrimaryEnabled && bridgeStatus.connected ? 'Local files • Connected' : state.preferences.bridgePrimaryEnabled ? 'Local files • Offline fallback' : 'Browser storage • Bridge ready'}</div>
          </div>
        </header>
        <section class="content">${renderView(project)}</section>
      </main>
    </div>
    ${modal ? renderModal() : ''}
  `;
  bindEvents();
}

function navButton(view, label) {
  return `<button class="nav-btn ${activeView === view ? 'active' : ''}" data-view="${view}"><span class="nav-icon">${icon(view)}</span>${label}</button>`;
}

function renderView(project) {
  if (project && !projectModuleEnabled(project, activeView)) activeView = 'dashboard';
  switch(activeView) {
    case 'projects': return renderProjects();
    case 'vision': return renderVision(project);
    case 'planning': return renderPlanning(project);
    case 'backlog': return renderBacklog(project);
    case 'board': return renderBoard(project);
    case 'sprints': return renderSprints(project);
    case 'retro': return renderRetrospectives(project);
    case 'decisions': return renderDecisions(project);
    case 'impediments': return renderImpediments(project);
    case 'evidence': return renderEvidence(project);
    case 'portfolio': return renderPortfolio();
    case 'caseStudy': return renderCaseStudy(project);
    case 'growth': return renderGrowth();
    case 'data': return renderDataBackup(project);
    case 'settings': return renderSettings();
    default: return renderDashboard(project);
  }
}

function renderDashboard(project) {
  const active = state.projects.filter(p => p.status === 'Active').length;
  const completed = state.projects.filter(p => p.status === 'Completed').length;
  const totalStories = state.projects.reduce((sum,p) => sum + (p.stories?.length || 0), 0);
  const totalEvidence = state.projects.reduce((sum,p) => sum + collectPortfolioEvidence(p).length, 0);
  const recent = state.activities.slice(0,6);
  return `
    <div class="page-head">
      <div><div class="eyebrow">Personal project workspace</div><h1>Olá, ${escapeHtml(state.profile.name)}.</h1><p>Organize projetos reais, registre decisões e transforme a prática em material de portfólio.</p></div>
      <button class="btn btn-pink" data-action="new-project">+ Novo projeto</button>
    </div>

    ${renderBackupReminder()}
    <div class="grid stats">
      ${statCard('Projetos ativos', active, 'Em andamento agora', 'blue')}
      ${statCard('Concluídos', completed, 'Histórico profissional', '')}
      ${statCard('User Stories', totalStories, 'Em todos os projetos', 'pink')}
      ${statCard('Evidências', totalEvidence, 'Para o portfólio', '')}
    </div>

    <div class="grid two" style="margin-top:18px">
      <div class="card card-pad">
        <div class="section-title"><div><h2>Projetos</h2><p>Seu trabalho em andamento</p></div><button class="btn btn-soft" data-view="projects">Ver todos</button></div>
        <div class="project-list">
          ${state.projects.length ? state.projects.slice(0,4).map(projectCard).join('') : emptyProjects()}
        </div>
      </div>
      <div class="card card-pad">
        <div class="section-title"><div><h2>Atividade recente</h2><p>Decisões e marcos registrados</p></div></div>
        <div class="activity">
          ${recent.length ? recent.map(a => `<div class="activity-item"><div class="activity-pin"></div><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.detail)} • ${fmtDate(a.at)}</small></div></div>`).join('') : '<div class="empty">Nenhuma atividade ainda.</div>'}
        </div>
      </div>
    </div>

    ${project ? `<div class="card card-pad project-focus">
      <div class="section-title"><div><h2>${escapeHtml(project.name)} • Delivery snapshot</h2><p>Um resumo do backlog do projeto atual.</p></div><button class="btn btn-soft" data-view="backlog">Abrir backlog</button></div>
      ${renderMiniBacklog(project)}
    </div>` : ''}
  `;
}

function renderMiniBacklog(project) {
  const stories = project.stories || [];
  const done = stories.filter(s => s.status === 'Done').length;
  const inFlight = stories.filter(s => ['In Progress','Review'].includes(s.status)).length;
  const ready = stories.filter(s => s.status === 'Ready').length;
  const points = stories.reduce((n,s) => n + (Number(s.storyPoints) || 0), 0);
  return `<div class="mini-stats">
    <div><strong>${stories.length}</strong><span>Stories</span></div>
    <div><strong>${done}</strong><span>Done</span></div>
    <div><strong>${inFlight}</strong><span>In progress</span></div>
    <div><strong>${ready}</strong><span>Ready</span></div>
    <div><strong>${points}</strong><span>Story points</span></div>
  </div>`;
}

function statCard(label, value, hint, flavor='') {
  return `<div class="card stat ${flavor}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
}

function projectCard(p) {
  return `<div class="project-card">
    <div class="project-card-top"><div><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.description || 'Sem descrição.')}</p></div><span class="badge ${p.status === 'Active' ? 'blue' : p.status === 'Completed' ? 'pink' : 'gray'}">${escapeHtml(p.status)}</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,Number(p.progress)||0))}%"></div></div>
    <div class="project-meta"><span class="template-pill">${escapeHtml(projectTemplate(p).icon)} ${escapeHtml(projectTemplate(p).title)}</span><span>${Number(p.progress)||0}%</span><span>${p.stories?.length || 0} itens</span><span>Atualizado ${fmtDate(p.updatedAt)}</span></div>
    ${p.setup?.goal ? `<div class="project-goal"><strong>Goal</strong><span>${escapeHtml(p.setup.goal)}</span></div>` : ''}
    <div><button class="btn btn-ghost" data-open-project="${escapeHtml(p.id)}">Abrir projeto</button></div>
  </div>`;
}

function renderProjects() {
  return `
    <div class="page-head"><div><div class="eyebrow">Workspace</div><h1>Projects</h1><p>Use o AgileFlow para qualquer projeto: profissional, acadêmico, pessoal ou de produto.</p></div><button class="btn btn-pink" data-action="new-project">+ Novo projeto</button></div>
    <div class="card card-pad">
      <div class="project-list">${state.projects.length ? state.projects.map(projectCard).join('') : emptyProjects()}</div>
    </div>
  `;
}

function emptyProjects() {
  return `<div class="empty"><div class="bubble">＋</div><strong>Nenhum projeto criado</strong><span>Crie seu primeiro projeto para começar.</span></div>`;
}

function renderVision(project) {
  if (!project) return renderNoProject();
  const v = project.vision || {};
  const hasContent = Object.values(v).some(Boolean);
  return `
    <div class="page-head"><div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>Product Vision</h1><p>Documente o problema, a direção do produto e como o sucesso será reconhecido.</p></div><button class="btn btn-primary" data-action="edit-vision">${hasContent ? 'Editar visão' : 'Definir visão'}</button></div>
    <div class="template-context card card-pad">
      <div class="template-context-icon">${escapeHtml(projectTemplate(project).icon)}</div>
      <div><span class="badge blue">${escapeHtml(projectTemplate(project).title)}</span><h3>${escapeHtml(project.setup?.goal || 'Project setup')}</h3><p>${escapeHtml(projectTemplate(project).description)}</p></div>
      <div class="template-context-meta"><span><b>Stakeholders</b>${escapeHtml(project.setup?.stakeholders || 'Não definidos')}</span><span><b>Prazo</b>${project.setup?.deadline ? escapeHtml(project.setup.deadline) : 'Flexível'}</span></div>
    </div>
    <div class="card card-pad">
      ${hasContent ? `<div class="vision-stack">
        ${visionItem('Problem', v.problem)}
        ${visionItem('Vision', v.vision)}
        ${visionItem('Objectives', v.objectives)}
        ${visionItem('Success Criteria', v.successCriteria)}
        ${visionItem('Constraints', v.constraints)}
      </div>` : `<div class="empty"><div class="bubble">◎</div><strong>Product Vision ainda não definida</strong><span>Comece registrando o problema e o resultado que este projeto pretende alcançar.</span></div>`}
    </div>
  `;
}

function visionItem(title, text) {
  return `<div class="vision-item"><strong>${title}</strong><p>${escapeHtml(text || '—')}</p></div>`;
}

function planningStatusClass(status) {
  return ({'Planned':'status-ready','In Progress':'status-in-progress','Achieved':'status-done','Dropped':'status-backlog','Upcoming':'status-ready','Completed':'status-done','Missed':'priority high','Open':'status-in-progress','Monitoring':'status-ready','Mitigated':'status-done','Closed':'status-backlog'})[status] || 'status-backlog';
}

function riskScore(item) {
  const scale={Low:1,Medium:2,High:3};
  return (scale[item.probability]||2)*(scale[item.impact]||2);
}

function riskLevel(item) {
  const score=riskScore(item);
  return score>=6?'High':score>=3?'Medium':'Low';
}

function renderPlanning(project) {
  if (!project) return renderNoProject();
  const goals=project.goals||[], milestones=project.milestones||[], risks=project.risks||[];
  const achieved=goals.filter(g=>g.status==='Achieved').length;
  const completedMilestones=milestones.filter(m=>m.status==='Completed').length;
  const openRisks=risks.filter(r=>!['Mitigated','Closed'].includes(r.status));
  const highRisks=openRisks.filter(r=>riskLevel(r)==='High').length;
  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)} • ${escapeHtml(projectTemplate(project).title)}</div><h1>Goals, Milestones & Risks</h1><p>Defina resultados, acompanhe marcos e registre riscos antes que se transformem em impedimentos.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-action="new-goal">+ Goal</button><button class="btn btn-soft" data-action="new-milestone">+ Milestone</button><button class="btn btn-pink" data-action="new-risk">+ Risk</button></div>
    </div>
    <div class="grid planning-stats">
      ${statCard('Goals',goals.length,`${achieved} achieved`,'blue')}
      ${statCard('Milestones',milestones.length,`${completedMilestones} completed`,'')}
      ${statCard('Open risks',openRisks.length,'Active or monitoring','pink')}
      ${statCard('High exposure',highRisks,'Probability × impact','')}
    </div>
    <div class="planning-grid">
      <section class="card card-pad planning-panel">
        <div class="section-title"><div><h2>Goals</h2><p>Resultados que orientam as decisões do projeto.</p></div><button class="btn btn-soft" data-action="new-goal">+ Novo</button></div>
        ${goals.length?`<div class="planning-list">${goals.map(g=>renderGoalCard(g)).join('')}</div>`:`<div class="empty compact"><div class="bubble">◎</div><strong>Nenhum goal ainda</strong><span>Defina o resultado que o projeto precisa produzir.</span></div>`}
      </section>
      <section class="card card-pad planning-panel">
        <div class="section-title"><div><h2>Milestones</h2><p>Marcos verificáveis no caminho para os objetivos.</p></div><button class="btn btn-soft" data-action="new-milestone">+ Novo</button></div>
        ${milestones.length?`<div class="planning-list">${[...milestones].sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999')).map(m=>renderMilestoneCard(m,project)).join('')}</div>`:`<div class="empty compact"><div class="bubble">◇</div><strong>Nenhum milestone ainda</strong><span>Registre entregas ou pontos de validação importantes.</span></div>`}
      </section>
    </div>
    <section class="card card-pad planning-panel risk-panel">
      <div class="section-title"><div><h2>Risk Register</h2><p>Probabilidade × impacto, resposta planejada e mitigação.</p></div><button class="btn btn-pink" data-action="new-risk">+ Novo risco</button></div>
      ${risks.length?`<div class="risk-list">${[...risks].sort((a,b)=>riskScore(b)-riskScore(a)).map(r=>renderRiskCard(r)).join('')}</div>`:`<div class="empty compact"><div class="bubble">⚠</div><strong>Nenhum risco registrado</strong><span>Identifique incertezas antes que elas virem bloqueios reais.</span></div>`}
    </section>`;
}

function renderGoalCard(item) {
  return `<article class="planning-item"><div class="planning-item-main"><div class="planning-title-line"><strong>${escapeHtml(item.title)}</strong><span class="badge ${planningStatusClass(item.status)}">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.description||'Sem descrição.')}</p><small>${item.targetDate?`Target: ${escapeHtml(item.targetDate)}`:'Sem data alvo'}${item.successMeasure?` • Success: ${escapeHtml(item.successMeasure)}`:''}</small></div><button class="btn btn-ghost" data-edit-goal="${escapeHtml(item.id)}">Editar</button></article>`;
}

function renderMilestoneCard(item,project) {
  const goal=(project.goals||[]).find(g=>g.id===item.goalId);
  return `<article class="planning-item"><div class="planning-item-main"><div class="planning-title-line"><strong>${escapeHtml(item.title)}</strong><span class="badge ${planningStatusClass(item.status)}">${escapeHtml(item.status)}</span>${item.includeInPortfolio?'<span class="badge portfolio-badge">★ Portfolio</span>':''}</div><p>${escapeHtml(item.description||'Sem descrição.')}</p><small>${item.dueDate?`Due: ${escapeHtml(item.dueDate)}`:'Sem prazo'}${goal?` • Goal: ${escapeHtml(goal.title)}`:''}</small></div><div class="planning-actions">${item.status!=='Completed'?`<button class="btn btn-primary" data-complete-milestone="${escapeHtml(item.id)}">Concluir</button>`:''}<button class="btn btn-ghost" data-toggle-milestone-portfolio="${escapeHtml(item.id)}">${item.includeInPortfolio?'★':'☆'}</button><button class="btn btn-soft" data-edit-milestone="${escapeHtml(item.id)}">Editar</button></div></article>`;
}

function renderRiskCard(item) {
  const level=riskLevel(item), score=riskScore(item);
  return `<article class="risk-card risk-${level.toLowerCase()}"><div class="risk-score"><strong>${score}</strong><span>${level}</span></div><div class="risk-content"><div class="planning-title-line"><strong>${escapeHtml(item.title)}</strong><span class="badge ${planningStatusClass(item.status)}">${escapeHtml(item.status)}</span>${item.includeInPortfolio?'<span class="badge portfolio-badge">★ Portfolio</span>':''}</div><p>${escapeHtml(item.description||'Sem descrição.')}</p><div class="risk-meta"><span>Probability <b>${escapeHtml(item.probability)}</b></span><span>Impact <b>${escapeHtml(item.impact)}</b></span><span>Response <b>${escapeHtml(item.response)}</b></span></div>${item.mitigation?`<small><b>Mitigation:</b> ${escapeHtml(item.mitigation)}</small>`:''}</div><div class="planning-actions"><button class="btn btn-ghost" data-toggle-risk-portfolio="${escapeHtml(item.id)}">${item.includeInPortfolio?'★':'☆'}</button><button class="btn btn-soft" data-edit-risk="${escapeHtml(item.id)}">Editar</button></div></article>`;
}

function renderBacklog(project) {
  if (!project) return renderNoProject();
  const epics = project.epics || [];
  const stories = project.stories || [];
  const filtered = filterStories(stories);
  const done = stories.filter(s => s.status === 'Done').length;
  const points = stories.reduce((n,s)=>n+(Number(s.storyPoints)||0),0);
  const donePoints = stories.filter(s=>s.status==='Done').reduce((n,s)=>n+(Number(s.storyPoints)||0),0);

  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>${escapeHtml(projectModuleLabel(project,'backlog','Product Backlog'))}</h1><p>${normalizeTemplate(project.template||project.method)==='Simple Project' ? 'Organize o trabalho em itens claros, prioridades e etapas visíveis.' : normalizeTemplate(project.template||project.method)==='Learning / Academic' ? 'Organize entregas, atividades e evidências do projeto acadêmico.' : 'Estruture Epics e User Stories, registre valor e mantenha as prioridades visíveis.'}</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-action="new-epic">+ Epic</button><button class="btn btn-pink" data-action="new-story">+ User Story</button></div>
    </div>

    <div class="grid backlog-stats">
      ${statCard('Stories', stories.length, `${done} concluídas`, 'blue')}
      ${statCard('Epics', epics.length, 'Áreas de trabalho', '')}
      ${statCard('Story Points', points, `${donePoints} concluídos`, 'pink')}
      ${statCard('Backlog health', backlogHealth(stories), 'Stories com contexto mínimo', '')}
    </div>

    <div class="card card-pad epic-panel">
      <div class="section-title"><div><h2>Epics</h2><p>Grandes áreas de valor deste projeto.</p></div><button class="btn btn-ghost" data-action="new-epic">Adicionar Epic</button></div>
      ${epics.length ? `<div class="epic-grid">${epics.map(epic => epicCard(epic, stories)).join('')}</div>` : `<div class="empty compact"><div class="bubble">☷</div><strong>Nenhum Epic ainda</strong><span>Comece agrupando o trabalho em grandes áreas de valor.</span></div>`}
    </div>

    <div class="card card-pad backlog-panel">
      <div class="section-title"><div><h2>${normalizeTemplate(project.template||project.method)==='Simple Project' ? 'Work Items' : normalizeTemplate(project.template||project.method)==='Learning / Academic' ? 'Academic Items' : 'User Stories'}</h2><p>${filtered.length} de ${stories.length} itens visíveis.</p></div></div>
      <div class="filters">
        <input id="backlogSearch" value="${escapeHtml(backlogFilters.search)}" placeholder="Buscar por ID, título ou necessidade…" />
        ${filterSelect('filterStatus','Status', ['All','Backlog','Ready','In Progress','Review','Done'], backlogFilters.status)}
        ${filterSelect('filterPriority','Prioridade', ['All','Critical','High','Medium','Low'], backlogFilters.priority)}
        <select id="filterEpic"><option value="All">Todos os Epics</option>${epics.map(e => `<option value="${escapeHtml(e.id)}" ${backlogFilters.epic===e.id?'selected':''}>${escapeHtml(e.title)}</option>`).join('')}</select>
      </div>
      ${filtered.length ? `<div class="story-list">${filtered.map(story => storyRow(story, project)).join('')}</div>` : `<div class="empty compact"><div class="bubble">⌕</div><strong>Nenhuma Story encontrada</strong><span>Ajuste os filtros ou crie uma nova User Story.</span></div>`}
    </div>
  `;
}

function filterSelect(id, label, options, value) {
  return `<select id="${id}" aria-label="${label}">${options.map(o => `<option ${o===value?'selected':''}>${o}</option>`).join('')}</select>`;
}

function filterStories(stories) {
  const search = backlogFilters.search.toLowerCase().trim();
  return stories
    .filter(s => backlogFilters.status === 'All' || s.status === backlogFilters.status)
    .filter(s => backlogFilters.priority === 'All' || s.priority === backlogFilters.priority)
    .filter(s => backlogFilters.epic === 'All' || s.epicId === backlogFilters.epic)
    .filter(s => !search || [s.key,s.title,s.asA,s.iWant,s.soThat].join(' ').toLowerCase().includes(search))
    .sort((a,b) => priorityRank(a.priority)-priorityRank(b.priority) || statusRank(a.status)-statusRank(b.status) || String(a.key).localeCompare(String(b.key)));
}

function epicCard(epic, stories) {
  const own = stories.filter(s => s.epicId === epic.id);
  const done = own.filter(s => s.status === 'Done').length;
  const pct = own.length ? Math.round((done/own.length)*100) : 0;
  return `<div class="epic-card">
    <div class="epic-mark"></div>
    <div class="epic-body"><strong>${escapeHtml(epic.title)}</strong><p>${escapeHtml(epic.description || 'Sem descrição.')}</p>
      <div class="epic-meta"><span>${own.length} stories</span><span>${done} done</span><span>${pct}%</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
  </div>`;
}

function storyRow(story, project) {
  const epic = (project.epics || []).find(e => e.id === story.epicId);
  return `<article class="story-row">
    <div class="story-id">${escapeHtml(story.key || '—')}</div>
    <div class="story-main">
      <div class="story-title-line"><strong>${escapeHtml(story.title)}</strong><span class="badge status-${slugify(story.status)}">${escapeHtml(story.status)}</span></div>
      <p>${escapeHtml(composeStory(story))}</p>
      <div class="story-meta"><span>${epic ? escapeHtml(epic.title) : 'No Epic'}</span><span class="priority ${String(story.priority).toLowerCase()}">${escapeHtml(story.priority)}</span><span>${Number(story.storyPoints)||0} pts</span><span>BV ${Number(story.businessValue)||0}/5</span></div>
    </div>
    <div class="story-actions"><button class="icon-btn" title="Editar User Story" data-edit-story="${escapeHtml(story.id)}">✎</button></div>
  </article>`;
}

function composeStory(story) {
  const parts = [story.asA, story.iWant, story.soThat].filter(Boolean);
  return parts.join(' · ') || 'User Story ainda sem narrativa.';
}

function backlogHealth(stories) {
  if (!stories.length) return '—';
  const healthy = stories.filter(s => s.title && s.iWant && s.priority && Number(s.storyPoints) > 0).length;
  return `${Math.round((healthy/stories.length)*100)}%`;
}


function renderBoard(project) {
  if (!project) return renderNoProject();
  const epics = project.epics || [];
  const stories = project.stories || [];
  const visible = filterBoardStories(stories);
  const wip = stories.filter(s => ['In Progress','Review'].includes(s.status)).length;
  const done = stories.filter(s => s.status === 'Done').length;
  const donePoints = stories.filter(s => s.status === 'Done').reduce((sum,s)=>sum+(Number(s.storyPoints)||0),0);

  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>${escapeHtml(projectModuleLabel(project,'board','Kanban Board'))}</h1><p>Visualize o fluxo, identifique trabalho em andamento e mova os itens entre os estados.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="backlog">Abrir backlog</button><button class="btn btn-pink" data-action="new-story">+ User Story</button></div>
    </div>

    <div class="grid board-stats">
      ${statCard('Stories', stories.length, `${visible.length} visíveis`, 'blue')}
      ${statCard('WIP', wip, 'In Progress + Review', 'pink')}
      ${statCard('Done', done, `${donePoints} story points`, '')}
      ${statCard('Flow', stories.length ? `${Math.round((done/stories.length)*100)}%` : '—', 'Stories concluídas', '')}
    </div>

    <div class="card card-pad board-toolbar">
      <div class="board-filters">
        <input id="boardSearch" value="${escapeHtml(boardFilters.search)}" placeholder="Buscar Story…" />
        <select id="boardEpicFilter"><option value="All">Todos os Epics</option>${epics.map(e => `<option value="${escapeHtml(e.id)}" ${boardFilters.epic===e.id?'selected':''}>${escapeHtml(e.title)}</option>`).join('')}</select>
      </div>
      <div class="board-help"><span class="drag-dot"></span> Arraste os cards entre colunas. Em telas touch, use o seletor de status do card.</div>
    </div>

    <div class="kanban" aria-label="Kanban Board">
      ${BOARD_STATUSES.map(status => renderKanbanColumn(status, visible, project)).join('')}
    </div>
  `;
}

function filterBoardStories(stories) {
  const search = boardFilters.search.toLowerCase().trim();
  return stories
    .filter(s => boardFilters.epic === 'All' || s.epicId === boardFilters.epic)
    .filter(s => !search || [s.key,s.title,s.asA,s.iWant,s.soThat].join(' ').toLowerCase().includes(search))
    .sort((a,b) => priorityRank(a.priority)-priorityRank(b.priority) || String(a.key).localeCompare(String(b.key)));
}

function renderKanbanColumn(status, stories, project) {
  const items = stories.filter(s => s.status === status);
  const points = items.reduce((sum,s)=>sum+(Number(s.storyPoints)||0),0);
  return `<section class="kanban-column" data-drop-status="${escapeHtml(status)}">
    <header class="kanban-column-head">
      <div><span class="column-status-dot status-${slugify(status)}"></span><strong>${escapeHtml(status)}</strong></div>
      <div class="column-count"><span>${items.length}</span><small>${points} pts</small></div>
    </header>
    <div class="kanban-dropzone" data-drop-status="${escapeHtml(status)}">
      ${items.length ? items.map(story => kanbanCard(story, project)).join('') : `<div class="kanban-empty">Solte uma Story aqui</div>`}
    </div>
  </section>`;
}

function kanbanCard(story, project) {
  const epic = (project.epics || []).find(e => e.id === story.epicId);
  return `<article class="kanban-card" draggable="true" data-drag-story="${escapeHtml(story.id)}">
    <div class="kanban-card-top"><span class="story-id board-id">${escapeHtml(story.key || '—')}</span><button class="card-edit" type="button" title="Editar User Story" data-edit-story="${escapeHtml(story.id)}">✎</button></div>
    <strong class="kanban-card-title">${escapeHtml(story.title)}</strong>
    <p>${escapeHtml(composeStory(story))}</p>
    <div class="kanban-card-tags"><span>${epic ? escapeHtml(epic.title) : 'No Epic'}</span><span class="priority ${String(story.priority).toLowerCase()}">${escapeHtml(story.priority)}</span><span>${Number(story.storyPoints)||0} pts</span></div>
    <select class="board-status-select" data-board-status="${escapeHtml(story.id)}" aria-label="Status de ${escapeHtml(story.key || story.title)}">${BOARD_STATUSES.map(v=>`<option ${story.status===v?'selected':''}>${v}</option>`).join('')}</select>
  </article>`;
}

function moveStory(storyId, nextStatus) {
  if (!BOARD_STATUSES.includes(nextStatus)) return;
  const project = currentProject();
  const story = project?.stories?.find(s => s.id === storyId);
  if (!project || !story || story.status === nextStatus) return;
  const previous = story.status;
  story.status = nextStatus;
  story.updatedAt = new Date().toISOString();
  touchProject(project);
  addActivity('Story movida no Kanban', `${story.key} • ${previous} → ${nextStatus}`, project.id);
  saveState();
  render();
  showToast(`${story.key} movida para ${nextStatus}.`);
}

function priorityRank(value) {
  return ({Critical:0,High:1,Medium:2,Low:3})[value] ?? 9;
}
function statusRank(value) {
  return ({'In Progress':0,Review:1,Ready:2,Backlog:3,Done:4})[value] ?? 9;
}


function renderSprints(project) {
  if (!project) return renderNoProject();
  const sprints = project.sprints || [];
  const stories = project.stories || [];
  const activeSprint = sprints.find(s => s.status === 'Active') || null;
  const planned = sprints.filter(s => s.status === 'Planned').length;
  const completed = sprints.filter(s => s.status === 'Completed').length;
  const activePoints = activeSprint ? sprintLiveMetrics(activeSprint, stories).plannedPoints : 0;

  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>Sprints</h1><p>Planeje ciclos de trabalho com objetivo claro, capacidade e acompanhamento de entrega.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="backlog">Abrir backlog</button><button class="btn btn-pink" data-action="new-sprint">+ Nova Sprint</button></div>
    </div>

    <div class="grid sprint-stats">
      ${statCard('Sprint ativa', activeSprint ? activeSprint.name : '—', activeSprint ? `${activePoints} pts planejados` : 'Nenhuma em andamento', 'blue')}
      ${statCard('Planejadas', planned, 'Próximos ciclos', '')}
      ${statCard('Concluídas', completed, 'Histórico do projeto', 'pink')}
      ${statCard('Total', sprints.length, 'Sprints registradas', '')}
    </div>

    ${activeSprint ? renderActiveSprint(activeSprint, project) : `<div class="card card-pad sprint-empty-active"><div class="section-title"><div><h2>Nenhuma Sprint ativa</h2><p>Crie uma Sprint, selecione Stories e inicie quando o planejamento estiver pronto.</p></div><button class="btn btn-primary" data-action="new-sprint">Planejar Sprint</button></div></div>`}

    <div class="card card-pad sprint-list-panel">
      <div class="section-title"><div><h2>Histórico de Sprints</h2><p>${sprints.length ? `${sprints.length} ciclo(s) registrado(s).` : 'O histórico começa na primeira Sprint.'}</p></div></div>
      ${sprints.length ? `<div class="sprint-list">${[...sprints].sort(sprintSort).map(sprint => renderSprintCard(sprint, project)).join('')}</div>` : `<div class="empty compact"><div class="bubble">◷</div><strong>Nenhuma Sprint ainda</strong><span>Planeje um ciclo e selecione as User Stories que fazem parte dele.</span></div>`}
    </div>
  `;
}

function renderActiveSprint(sprint, project) {
  const metrics = sprintLiveMetrics(sprint, project.stories || []);
  const pct = metrics.plannedPoints ? Math.round((metrics.completedPoints / metrics.plannedPoints) * 100) : 0;
  return `<div class="card card-pad active-sprint-card">
    <div class="section-title sprint-active-head">
      <div><div class="sprint-kicker"><span class="pulse-dot"></span> Sprint ativa</div><h2>${escapeHtml(sprint.name)}</h2><p>${escapeHtml(sprint.goal || 'Sprint Goal ainda não definido.')}</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-edit-sprint="${escapeHtml(sprint.id)}">Gerenciar</button><button class="btn btn-primary" data-complete-sprint="${escapeHtml(sprint.id)}">Concluir Sprint</button></div>
    </div>
    <div class="sprint-metric-grid">
      <div><strong>${metrics.plannedPoints}</strong><span>Planned pts</span></div>
      <div><strong>${metrics.completedPoints}</strong><span>Completed pts</span></div>
      <div><strong>${metrics.carryOverPoints}</strong><span>Open pts</span></div>
      <div><strong>${Number(sprint.capacity)||0}</strong><span>Capacity</span></div>
    </div>
    <div class="sprint-progress-line"><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><span>${pct}% dos pontos concluídos</span></div>
    <div class="sprint-dates"><span>Início: <strong>${formatShortDate(sprint.startDate)}</strong></span><span>Fim: <strong>${formatShortDate(sprint.endDate)}</strong></span><span>${metrics.storyCount} Stories</span></div>
  </div>`;
}

function renderSprintCard(sprint, project) {
  const live = sprint.status === 'Completed' && sprint.snapshot ? sprint.snapshot : sprintLiveMetrics(sprint, project.stories || []);
  const assigned = (project.stories || []).filter(story => story.sprintId === sprint.id);
  const pct = Number(live.plannedPoints) ? Math.round((Number(live.completedPoints || 0) / Number(live.plannedPoints)) * 100) : 0;
  return `<article class="sprint-card">
    <div class="sprint-card-main">
      <div class="sprint-card-title"><strong>${escapeHtml(sprint.name)}</strong><span class="badge sprint-status-${String(sprint.status).toLowerCase()}">${escapeHtml(sprint.status)}</span></div>
      <p>${escapeHtml(sprint.goal || 'Sem Sprint Goal.')}</p>
      <div class="sprint-card-meta"><span>${formatShortDate(sprint.startDate)} → ${formatShortDate(sprint.endDate)}</span><span>${Number(live.storyCount ?? assigned.length)} Stories</span><span>${Number(live.plannedPoints)||0} pts planejados</span><span>${Number(live.completedPoints)||0} pts concluídos</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0,Math.min(100,pct))}%"></div></div>
    </div>
    <div class="sprint-card-actions">
      ${sprint.status !== 'Completed' ? `<button class="btn btn-ghost" data-edit-sprint="${escapeHtml(sprint.id)}">Editar</button>` : ''}
      ${sprint.status === 'Planned' ? `<button class="btn btn-primary" data-start-sprint="${escapeHtml(sprint.id)}">Iniciar</button>` : ''}
      ${sprint.status === 'Active' ? `<button class="btn btn-primary" data-complete-sprint="${escapeHtml(sprint.id)}">Concluir</button>` : ''}
      ${sprint.status === 'Completed' ? `<button class="btn btn-soft" data-retro-sprint="${escapeHtml(sprint.id)}">Retrospectiva</button>` : ''}
    </div>
  </article>`;
}

function sprintLiveMetrics(sprint, stories) {
  const assigned = stories.filter(story => story.sprintId === sprint.id);
  const plannedPoints = assigned.reduce((sum, story) => sum + (Number(story.storyPoints) || 0), 0);
  const completedPoints = assigned.filter(story => story.status === 'Done').reduce((sum, story) => sum + (Number(story.storyPoints) || 0), 0);
  return {
    storyCount: assigned.length,
    plannedPoints,
    completedPoints,
    carryOverPoints: Math.max(0, plannedPoints - completedPoints)
  };
}

function sprintSort(a,b) {
  const rank = {Active:0, Planned:1, Completed:2};
  const statusDiff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (statusDiff) return statusDiff;
  const ad = a.startDate ? new Date(a.startDate).getTime() : 0;
  const bd = b.startDate ? new Date(b.startDate).getTime() : 0;
  return bd - ad;
}

function formatShortDate(value) {
  if (!value) return '—';
  const [y,m,d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return escapeHtml(value);
  return new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(y,m-1,d));
}

function startSprint(sprintId) {
  const project = currentProject();
  const sprint = project?.sprints?.find(s => s.id === sprintId);
  if (!project || !sprint || sprint.status !== 'Planned') return;
  const otherActive = project.sprints.find(s => s.status === 'Active' && s.id !== sprint.id);
  if (otherActive) { showToast(`Conclua ${otherActive.name} antes de iniciar outra Sprint.`); return; }
  const metrics = sprintLiveMetrics(sprint, project.stories || []);
  if (!metrics.storyCount) { showToast('Adicione pelo menos uma User Story antes de iniciar a Sprint.'); return; }
  sprint.status = 'Active';
  sprint.startedAt = new Date().toISOString();
  touchProject(project);
  addActivity('Sprint iniciada', `${sprint.name} • ${metrics.storyCount} Stories • ${metrics.plannedPoints} pts`, project.id);
  saveState(); render(); showToast(`${sprint.name} iniciada.`);
}

function completeSprint(sprintId) {
  const project = currentProject();
  const sprint = project?.sprints?.find(s => s.id === sprintId);
  if (!project || !sprint || sprint.status !== 'Active') return;
  const metrics = sprintLiveMetrics(sprint, project.stories || []);
  const carry = metrics.carryOverPoints;
  const message = carry ? `Concluir ${sprint.name}? ${carry} ponto(s) permanecerão abertos e serão registrados como carry-over.` : `Concluir ${sprint.name}? Todas as Stories planejadas estão Done.`;
  if (!confirm(message)) return;
  sprint.status = 'Completed';
  sprint.completedAt = new Date().toISOString();
  sprint.snapshot = { ...metrics };
  touchProject(project);
  addActivity('Sprint concluída', `${sprint.name} • ${metrics.completedPoints}/${metrics.plannedPoints} pts concluídos • ${carry} carry-over`, project.id);
  saveState(); render(); showToast(`${sprint.name} concluída. Registre a retrospectiva quando estiver pronta.`);
}

function renderRetrospectives(project) {
  if (!project) return renderNoProject();
  const retros = project.retrospectives || [];
  const completedSprints = (project.sprints || []).filter(s => s.status === 'Completed');
  const sprintWithRetro = new Set(retros.filter(r => r.sprintId).map(r => r.sprintId));
  const pendingSprints = completedSprints.filter(s => !sprintWithRetro.has(s.id));
  const allActions = retros.flatMap(r => (r.actionItems || []).map(item => ({...item, retroId:r.id})));
  const openActions = allActions.filter(item => item.status !== 'Done');
  const doneActions = allActions.filter(item => item.status === 'Done');
  const portfolioCount = retros.filter(r => r.includeInPortfolio).length;

  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>${escapeHtml(projectModuleLabel(project,'retro','Retrospectives'))}</h1><p>${normalizeTemplate(project.template||project.method)==='Learning / Academic' ? 'Registre reflexões, aprendizados, dificuldades e próximos passos do processo de aprendizagem.' : 'Transforme experiência em melhoria contínua: registre aprendizados, decisões de processo e ações concretas.'}</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="sprints">Ver Sprints</button><button class="btn btn-pink" data-action="new-retro">+ Nova Retrospectiva</button></div>
    </div>

    <div class="grid retro-stats">
      ${statCard('Retrospectivas', retros.length, 'Ciclos documentados', 'blue')}
      ${statCard('Ações abertas', openActions.length, 'Melhorias a acompanhar', '')}
      ${statCard('Ações concluídas', doneActions.length, 'Mudanças aplicadas', 'pink')}
      ${statCard('Portfolio', portfolioCount, 'Marcadas como evidência', '')}
    </div>

    ${pendingSprints.length ? `<div class="card card-pad retro-pending-panel">
      <div class="section-title"><div><h2>Sprints aguardando retrospectiva</h2><p>Feche o ciclo registrando o que funcionou, o que mudou e o próximo experimento.</p></div></div>
      <div class="retro-pending-list">${pendingSprints.map(sprint => {
        const snap = sprint.snapshot || sprintLiveMetrics(sprint, project.stories || []);
        return `<div class="retro-pending-item"><div><strong>${escapeHtml(sprint.name)}</strong><small>${Number(snap.completedPoints)||0}/${Number(snap.plannedPoints)||0} pts concluídos • ${Number(snap.carryOverPoints)||0} carry-over</small></div><button class="btn btn-primary" data-retro-sprint="${escapeHtml(sprint.id)}">Criar retrospectiva</button></div>`;
      }).join('')}</div>
    </div>` : ''}

    ${openActions.length ? `<div class="card card-pad action-panel">
      <div class="section-title"><div><h2>Action Items em aberto</h2><p>A retrospectiva só gera melhoria quando a ação é acompanhada até o fim.</p></div><span class="badge blue">${openActions.length} open</span></div>
      <div class="action-list">${openActions.map(item => renderActionItem(item, project)).join('')}</div>
    </div>` : ''}

    <div class="card card-pad retro-history-panel">
      <div class="section-title"><div><h2>Histórico</h2><p>${retros.length ? `${retros.length} retrospectiva(s) registrada(s).` : 'Registre a primeira retrospectiva deste projeto.'}</p></div></div>
      ${retros.length ? `<div class="retro-list">${[...retros].sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt)).map(retro => renderRetroCard(retro, project)).join('')}</div>` : `<div class="empty compact"><div class="bubble">↺</div><strong>Nenhuma retrospectiva ainda</strong><span>Você pode registrar uma retrospectiva geral ou vinculá-la a uma Sprint concluída.</span><button class="btn btn-primary" data-action="new-retro">Criar retrospectiva</button></div>`}
    </div>
  `;
}

function renderRetroCard(retro, project) {
  const sprint = retro.sprintId ? (project.sprints || []).find(s => s.id === retro.sprintId) : null;
  const actions = retro.actionItems || [];
  const done = actions.filter(item => item.status === 'Done').length;
  const title = retro.title || sprint?.name || 'Retrospectiva geral';
  return `<article class="retro-card">
    <div class="retro-card-head">
      <div><div class="retro-title-line"><strong>${escapeHtml(title)}</strong>${retro.includeInPortfolio ? '<span class="badge portfolio-badge">★ Portfolio</span>' : ''}</div><small>${sprint ? `Vinculada a ${escapeHtml(sprint.name)}` : 'Retrospectiva geral do projeto'} • ${fmtDate(retro.updatedAt || retro.createdAt)}</small></div>
      <div class="retro-card-actions"><button class="btn btn-ghost" data-toggle-retro-portfolio="${escapeHtml(retro.id)}">${retro.includeInPortfolio ? 'Remover do portfolio' : '★ Add to Portfolio'}</button><button class="btn btn-soft" data-edit-retro="${escapeHtml(retro.id)}">Editar</button></div>
    </div>
    <div class="retro-quadrants">
      ${retroInsight('✓', 'What went well', retro.wentWell, 'good')}
      ${retroInsight('!', "What didn't go well", retro.didntGoWell, 'warn')}
      ${retroInsight('◇', 'What did we learn?', retro.learned, 'learn')}
      ${retroInsight('→', 'What should change?', retro.changeNext, 'change')}
    </div>
    <div class="retro-actions-summary"><strong>Action Items</strong><span>${done}/${actions.length} concluídos</span></div>
    ${actions.length ? `<div class="action-list compact-actions">${actions.map(item => renderActionItem({...item, retroId:retro.id}, project)).join('')}</div>` : '<div class="retro-no-actions">Nenhuma ação registrada para este ciclo.</div>'}
  </article>`;
}

function retroInsight(symbol, label, text, flavor) {
  return `<div class="retro-insight ${flavor}"><div class="retro-insight-label"><span>${symbol}</span><strong>${label}</strong></div><p>${escapeHtml(text || '—')}</p></div>`;
}

function renderActionItem(item, project) {
  const retro = (project.retrospectives || []).find(r => r.id === item.retroId);
  const sprint = retro?.sprintId ? (project.sprints || []).find(s => s.id === retro.sprintId) : null;
  const done = item.status === 'Done';
  return `<div class="action-item ${done ? 'done' : ''}"><button class="action-check" data-toggle-action="${escapeHtml(item.retroId)}::${escapeHtml(item.id)}" title="${done ? 'Reabrir ação' : 'Marcar como concluída'}">${done ? '✓' : ''}</button><div><strong>${escapeHtml(item.text)}</strong><small>${escapeHtml(retro?.title || sprint?.name || 'Retrospectiva')}</small></div><span class="badge ${done ? 'status-done' : 'status-ready'}">${done ? 'Done' : 'Open'}</span></div>`;
}


function renderDecisions(project) {
  if (!project) return renderNoProject();
  const decisions = project.decisions || [];
  const portfolio = decisions.filter(d => d.includeInPortfolio).length;
  const linked = decisions.filter(d => d.sprintId).length;
  const recent = [...decisions].sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>Decision Log</h1><p>Registre o contexto, as alternativas e o raciocínio por trás das decisões relevantes do projeto.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="impediments">Ver impedimentos</button><button class="btn btn-pink" data-action="new-decision">+ Nova decisão</button></div>
    </div>
    <div class="grid decision-stats">
      ${statCard('Decisões', decisions.length, 'Registradas no projeto', 'blue')}
      ${statCard('Ligadas a Sprints', linked, 'Contexto de execução', '')}
      ${statCard('Portfolio', portfolio, 'Marcadas como evidência', 'pink')}
      ${statCard('Sem Sprint', decisions.length-linked, 'Decisões de projeto', '')}
    </div>
    <div class="card card-pad decision-panel">
      <div class="section-title"><div><h2>Histórico de decisões</h2><p>${decisions.length ? `${decisions.length} decisão(ões) documentada(s).` : 'Documente a primeira decisão importante deste projeto.'}</p></div></div>
      ${decisions.length ? `<div class="decision-list">${recent.map(d=>renderDecisionCard(d,project)).join('')}</div>` : `<div class="empty compact"><div class="bubble">◇</div><strong>Nenhuma decisão registrada</strong><span>Use o Decision Log para preservar contexto, alternativas e impacto — material valioso para retrospectivas e portfólio.</span><button class="btn btn-primary" data-action="new-decision">Registrar decisão</button></div>`}
    </div>`;
}

function renderDecisionCard(item, project) {
  const sprint=item.sprintId ? (project.sprints||[]).find(s=>s.id===item.sprintId) : null;
  return `<article class="decision-card">
    <div class="decision-card-head"><div><div class="decision-title-line"><strong>${escapeHtml(item.title || 'Decisão sem título')}</strong>${item.includeInPortfolio?'<span class="badge portfolio-badge">★ Portfolio</span>':''}</div><small>${sprint?`Vinculada a ${escapeHtml(sprint.name)}`:'Decisão de projeto'} • ${fmtDate(item.updatedAt||item.createdAt)}</small></div><div class="decision-card-actions"><button class="btn btn-ghost" data-toggle-decision-portfolio="${escapeHtml(item.id)}">${item.includeInPortfolio?'Remover do portfolio':'★ Add to Portfolio'}</button><button class="btn btn-soft" data-edit-decision="${escapeHtml(item.id)}">Editar</button></div></div>
    <div class="decision-grid">
      ${decisionSection('Contexto',item.context)}
      ${decisionSection('Alternativas consideradas',item.alternatives)}
      ${decisionSection('Decisão',item.decision,'accent')}
      ${decisionSection('Justificativa',item.reason)}
      ${decisionSection('Impacto esperado / observado',item.impact,'wide')}
    </div>
  </article>`;
}

function decisionSection(label,text,flavor='') {
  return `<div class="decision-section ${flavor}"><strong>${label}</strong><p>${escapeHtml(text||'—')}</p></div>`;
}

function renderImpediments(project) {
  if (!project) return renderNoProject();
  const items=project.impediments||[];
  const active=items.filter(i=>i.status==='Active');
  const resolved=items.filter(i=>i.status==='Resolved');
  const critical=active.filter(i=>i.severity==='Critical').length;
  const portfolio=items.filter(i=>i.includeInPortfolio).length;
  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>Impediments</h1><p>Registre bloqueios, impacto, próximo passo e como cada impedimento foi resolvido.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="decisions">Decision Log</button><button class="btn btn-pink" data-action="new-impediment">+ Novo impedimento</button></div>
    </div>
    <div class="grid impediment-stats">
      ${statCard('Ativos',active.length,'Bloqueios em acompanhamento','blue')}
      ${statCard('Críticos',critical,'Exigem atenção imediata','')}
      ${statCard('Resolvidos',resolved.length,'Aprendizados preservados','pink')}
      ${statCard('Portfolio',portfolio,'Marcados como evidência','')}
    </div>
    ${active.length?`<div class="card card-pad impediment-panel"><div class="section-title"><div><h2>Impedimentos ativos</h2><p>Acompanhe o próximo passo até a resolução.</p></div><span class="badge status-in-progress">${active.length} active</span></div><div class="impediment-list">${active.map(i=>renderImpedimentCard(i,project)).join('')}</div></div>`:''}
    <div class="card card-pad impediment-panel"><div class="section-title"><div><h2>Histórico</h2><p>${resolved.length ? `${resolved.length} impedimento(s) resolvido(s).` : 'Os impedimentos resolvidos ficarão registrados aqui.'}</p></div></div>${resolved.length?`<div class="impediment-list">${[...resolved].sort((a,b)=>new Date(b.resolvedAt||b.updatedAt)-new Date(a.resolvedAt||a.updatedAt)).map(i=>renderImpedimentCard(i,project)).join('')}</div>`:`<div class="empty compact"><div class="bubble">⚑</div><strong>Nenhum impedimento resolvido ainda</strong><span>Quando um bloqueio for resolvido, registre a solução para preservar o aprendizado.</span></div>`}</div>`;
}

function renderImpedimentCard(item, project) {
  const sprint=item.sprintId ? (project.sprints||[]).find(s=>s.id===item.sprintId) : null;
  const sev=String(item.severity||'Medium').toLowerCase();
  return `<article class="impediment-card ${item.status==='Resolved'?'resolved':''}">
    <div class="impediment-card-head"><div><div class="impediment-title-line"><strong>${escapeHtml(item.title)}</strong><span class="badge priority ${sev}">${escapeHtml(item.severity)}</span><span class="badge ${item.status==='Resolved'?'status-done':'status-in-progress'}">${item.status}</span>${item.includeInPortfolio?'<span class="badge portfolio-badge">★ Portfolio</span>':''}</div><small>${sprint?`Vinculado a ${escapeHtml(sprint.name)}`:'Impedimento de projeto'} • aberto em ${fmtDate(item.createdAt)}${item.resolvedAt?` • resolvido em ${fmtDate(item.resolvedAt)}`:''}</small></div><div class="decision-card-actions"><button class="btn btn-ghost" data-toggle-impediment-portfolio="${escapeHtml(item.id)}">${item.includeInPortfolio?'Remover do portfolio':'★ Portfolio'}</button>${item.status==='Active'?`<button class="btn btn-primary" data-resolve-impediment="${escapeHtml(item.id)}">Resolver</button>`:''}<button class="btn btn-soft" data-edit-impediment="${escapeHtml(item.id)}">Editar</button></div></div>
    <div class="impediment-body"><div><strong>Descrição</strong><p>${escapeHtml(item.description||'—')}</p></div><div><strong>Impacto</strong><p>${escapeHtml(item.impact||'—')}</p></div><div><strong>${item.status==='Resolved'?'Resolução':'Próximo passo'}</strong><p>${escapeHtml((item.status==='Resolved'?item.resolution:item.nextStep)||'—')}</p></div></div>
  </article>`;
}

function collectPortfolioEvidence(project) {
  if (!project) return [];
  const sprintName = id => (project.sprints || []).find(s => s.id === id)?.name || '';
  const generated = [];

  (project.retrospectives || []).filter(r => r.includeInPortfolio).forEach(r => {
    const open = (r.actionItems || []).filter(a => a.status !== 'Done').length;
    const done = (r.actionItems || []).filter(a => a.status === 'Done').length;
    generated.push({
      id:`retro:${r.id}`, source:'Retrospective', sourceId:r.id, type:'Continuous Improvement',
      title:r.title || sprintName(r.sprintId) || 'Retrospectiva do projeto',
      summary:r.learned || r.changeNext || r.wentWell || 'Retrospectiva marcada como evidência.',
      outcome:r.changeNext || `${done} Action Item(s) concluído(s) • ${open} aberto(s)`,
      skills:['Continuous Improvement','Retrospective'], date:r.updatedAt || r.createdAt, reference:'', featured:false
    });
  });

  (project.decisions || []).filter(d => d.includeInPortfolio).forEach(d => generated.push({
    id:`decision:${d.id}`, source:'Decision', sourceId:d.id, type:'Decision Making', title:d.title || 'Decisão de projeto',
    summary:d.decision || d.context || 'Decisão marcada como evidência.', outcome:d.impact || d.reason || '',
    skills:['Decision Making','Analysis'], date:d.updatedAt || d.createdAt, reference:sprintName(d.sprintId), featured:false
  }));

  (project.impediments || []).filter(i => i.includeInPortfolio).forEach(i => generated.push({
    id:`impediment:${i.id}`, source:'Impediment', sourceId:i.id, type:'Problem Solving', title:i.title || 'Impedimento',
    summary:i.description || i.impact || 'Impedimento marcado como evidência.',
    outcome:i.status === 'Resolved' ? (i.resolution || 'Impedimento resolvido.') : (i.nextStep || 'Em acompanhamento.'),
    skills:['Problem Solving','Risk & Impediment Management'], date:i.resolvedAt || i.updatedAt || i.createdAt, reference:sprintName(i.sprintId), featured:false
  }));

  (project.milestones || []).filter(m => m.includeInPortfolio).forEach(m => generated.push({
    id:`milestone:${m.id}`, source:'Milestone', sourceId:m.id, type:'Milestone', title:m.title || 'Milestone',
    summary:m.description || 'Marco do projeto marcado como evidência.',
    outcome:m.status === 'Completed' ? 'Milestone completed.' : `Status: ${m.status}`,
    skills:['Planning','Delivery Management'], date:m.completedAt || m.updatedAt || m.createdAt, reference:m.dueDate || '', featured:false
  }));

  (project.risks || []).filter(r => r.includeInPortfolio).forEach(r => generated.push({
    id:`risk:${r.id}`, source:'Risk', sourceId:r.id, type:'Risk Management', title:r.title || 'Project risk',
    summary:r.description || 'Risco do projeto marcado como evidência.',
    outcome:r.mitigation || `${r.response} response • ${r.status}`,
    skills:['Risk Management','Analysis'], date:r.updatedAt || r.createdAt, reference:`${r.probability} probability • ${r.impact} impact`, featured:false
  }));

  (project.evidence || []).forEach(e => generated.push({
    id:`manual:${e.id}`, source:'Manual', sourceId:e.id, type:e.type || 'Other', title:e.title || 'Evidência',
    summary:e.summary || '', outcome:e.outcome || '', skills:e.skills || [], date:e.date || e.updatedAt || e.createdAt,
    reference:e.reference || '', featured:Boolean(e.featured)
  }));

  return generated.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
}

function evidenceSourceLabel(source) {
  return ({Retrospective:'Retrospective',Decision:'Decision Log',Impediment:'Impediment',Milestone:'Milestone',Risk:'Risk Register',Manual:'Manual Evidence'})[source] || source;
}

function renderEvidence(project) {
  if (!project) return renderNoProject();
  const all = collectPortfolioEvidence(project);
  const sourceCounts = {
    Retrospective: all.filter(e=>e.source==='Retrospective').length,
    Decision: all.filter(e=>e.source==='Decision').length,
    Impediment: all.filter(e=>e.source==='Impediment').length,
    Milestone: all.filter(e=>e.source==='Milestone').length,
    Risk: all.filter(e=>e.source==='Risk').length,
    Manual: all.filter(e=>e.source==='Manual').length
  };
  const q=evidenceFilters.search.trim().toLowerCase();
  const visible=all.filter(e => (evidenceFilters.source==='All' || e.source===evidenceFilters.source) && (!q || [e.title,e.summary,e.outcome,e.type,...(e.skills||[])].join(' ').toLowerCase().includes(q)));
  const skillMap = new Map();
  all.forEach(e => (e.skills||[]).forEach(skill => skillMap.set(skill,(skillMap.get(skill)||0)+1)));
  const skills=[...skillMap.entries()].sort((a,b)=>b[1]-a[1]);
  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">${escapeHtml(project.name)}</div><h1>Evidence Hub</h1><p>Reúna decisões, aprendizados, resolução de problemas e resultados reais em uma base reutilizável para case studies e portfólio.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="portfolio">My Portfolio</button><button class="btn btn-pink" data-action="new-evidence">+ Nova evidência</button></div>
    </div>
    <div class="grid evidence-stats">
      ${statCard('Evidências',all.length,'Selecionadas neste projeto','blue')}
      ${statCard('Decisões',sourceCounts.Decision,'Tomada de decisão','')}
      ${statCard('Melhoria contínua',sourceCounts.Retrospective,'Retrospectivas marcadas','pink')}
      ${statCard('Riscos & resultados',sourceCounts.Impediment + sourceCounts.Risk + sourceCounts.Milestone + sourceCounts.Manual,'Gestão de risco, marcos e resultados','')}
    </div>
    <div class="grid evidence-layout">
      <div class="card card-pad evidence-main">
        <div class="section-title"><div><h2>Portfolio Evidence</h2><p>${all.length ? `${visible.length} de ${all.length} evidência(s) exibida(s).` : 'Marque itens nos módulos ou registre uma evidência manual.'}</p></div></div>
        <div class="evidence-filters">
          <input id="evidenceSearch" value="${escapeHtml(evidenceFilters.search)}" placeholder="Buscar por título, habilidade ou resultado…" />
          <select id="evidenceSourceFilter">
            <option value="All" ${evidenceFilters.source==='All'?'selected':''}>Todas as fontes</option>
            <option value="Retrospective" ${evidenceFilters.source==='Retrospective'?'selected':''}>Retrospectives (${sourceCounts.Retrospective})</option>
            <option value="Decision" ${evidenceFilters.source==='Decision'?'selected':''}>Decisions (${sourceCounts.Decision})</option>
            <option value="Impediment" ${evidenceFilters.source==='Impediment'?'selected':''}>Impediments (${sourceCounts.Impediment})</option>
            <option value="Milestone" ${evidenceFilters.source==='Milestone'?'selected':''}>Milestones (${sourceCounts.Milestone})</option>
            <option value="Risk" ${evidenceFilters.source==='Risk'?'selected':''}>Risks (${sourceCounts.Risk})</option>
            <option value="Manual" ${evidenceFilters.source==='Manual'?'selected':''}>Manual (${sourceCounts.Manual})</option>
          </select>
        </div>
        ${visible.length ? `<div class="evidence-list">${visible.map(e=>renderEvidenceCard(e,project)).join('')}</div>` : `<div class="empty compact"><div class="bubble">★</div><strong>${all.length?'Nenhum resultado para o filtro':'Nenhuma evidência ainda'}</strong><span>${all.length?'Ajuste a busca ou fonte.':'Use ★ Portfolio em Retrospectives, Decisions, Impediments, Milestones e Risks, ou registre um resultado manual.'}</span>${all.length?'':'<button class="btn btn-primary" data-action="new-evidence">Registrar evidência</button>'}</div>`}
      </div>
      <aside class="evidence-side">
        <div class="card card-pad"><div class="section-title"><div><h2>Competências demonstradas</h2><p>Contagem de evidências, não uma nota.</p></div></div>
          ${skills.length ? `<div class="skill-evidence-list">${skills.map(([skill,count])=>`<div class="skill-evidence-row"><span>${escapeHtml(skill)}</span><strong>${count}</strong></div>`).join('')}</div>` : `<div class="empty compact"><span>As competências aparecerão conforme as evidências forem registradas.</span></div>`}
        </div>
        <div class="card card-pad evidence-guide"><div class="section-title"><div><h2>Boa evidência responde</h2><p>Use isso como referência.</p></div></div>
          <div class="evidence-guide-list"><span><b>1.</b> Qual era o contexto?</span><span><b>2.</b> O que você fez ou decidiu?</span><span><b>3.</b> Qual foi o resultado?</span><span><b>4.</b> O que isso demonstra?</span></div>
        </div>
      </aside>
    </div>`;
}

function renderEvidenceCard(item, project) {
  const skills=(item.skills||[]).map(skill=>`<span class="evidence-skill">${escapeHtml(skill)}</span>`).join('');
  const sourceClass=item.source.toLowerCase();
  const sourceActions = item.source==='Manual'
    ? `<button class="btn btn-soft" data-edit-evidence="${escapeHtml(item.sourceId)}">Editar</button>`
    : `<button class="btn btn-ghost" data-remove-evidence="${escapeHtml(item.id)}">Remover do portfolio</button>`;
  return `<article class="evidence-card ${item.featured?'featured':''}">
    <div class="evidence-card-head"><div><div class="evidence-title-line"><span class="evidence-source ${sourceClass}">${escapeHtml(evidenceSourceLabel(item.source))}</span>${item.featured?'<span class="badge portfolio-badge">★ Featured</span>':''}</div><h3>${escapeHtml(item.title)}</h3><small>${escapeHtml(item.type)} • ${fmtDate(item.date)}${item.reference?` • ${escapeHtml(item.reference)}`:''}</small></div><div class="evidence-card-actions">${sourceActions}</div></div>
    <div class="evidence-copy"><div><strong>Context / Evidence</strong><p>${escapeHtml(item.summary||'—')}</p></div><div class="evidence-outcome"><strong>Outcome / Learning</strong><p>${escapeHtml(item.outcome||'—')}</p></div></div>
    ${skills?`<div class="evidence-skills">${skills}</div>`:''}
  </article>`;
}


function collectAllPortfolioEvidence() {
  return state.projects.flatMap(project => collectPortfolioEvidence(project).map(item => ({
    ...item,
    projectId: project.id,
    projectName: project.name,
    projectMethod: project.method,
    projectStatus: project.status
  }))).sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
}


function monthKey(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function monthLabel(key) {
  if (!key || key === 'unknown') return 'Data não informada';
  const [year,month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(new Date(year,month-1,1));
}

function collectGrowthEvents() {
  const events = [];
  state.projects.forEach(project => {
    if (project.createdAt) events.push({
      id:`project:${project.id}`, kind:'Project', projectId:project.id, projectName:project.name,
      title:`${project.name} iniciado`, summary:project.description || 'Novo projeto adicionado ao workspace.',
      outcome:`Método: ${project.method || 'Hybrid'}`, skills:['Project Initiation'], date:project.createdAt, featured:false
    });
    (project.sprints || []).filter(s=>s.status==='Completed').forEach(sprint => {
      const snap=sprint.snapshot || {};
      events.push({
        id:`sprint:${project.id}:${sprint.id}`, kind:'Sprint', projectId:project.id, projectName:project.name,
        title:`${sprint.name} concluída`, summary:sprint.goal || 'Sprint concluída.',
        outcome:`${Number(snap.completedPoints||0)} de ${Number(snap.plannedPoints||0)} pts concluídos${Number(snap.carryOverPoints||0)?` • ${Number(snap.carryOverPoints)} pts carry-over`:''}`,
        skills:['Sprint Planning','Delivery'], date:sprint.completedAt || sprint.endDate || sprint.createdAt, featured:false
      });
    });
    collectPortfolioEvidence(project).forEach(item => events.push({
      ...item, id:`evidence:${project.id}:${item.id}`, kind:'Evidence', projectId:project.id, projectName:project.name
    }));
  });
  return events.filter(e=>e.date).sort((a,b)=>new Date(b.date)-new Date(a.date));
}

function renderGrowth() {
  const all=collectGrowthEvents();
  const skillMap=new Map();
  all.forEach(e=>(e.skills||[]).forEach(skill=>{
    const row=skillMap.get(skill)||{count:0,projects:new Set(),first:null,last:null};
    row.count++; row.projects.add(e.projectId);
    const d=new Date(e.date);
    if(!row.first||d<row.first) row.first=d;
    if(!row.last||d>row.last) row.last=d;
    skillMap.set(skill,row);
  }));
  const skills=[...skillMap.entries()].map(([name,row])=>({name,count:row.count,projects:row.projects.size,first:row.first,last:row.last})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
  const years=[...new Set(all.map(e=>new Date(e.date).getFullYear()).filter(Boolean))].sort((a,b)=>b-a);
  const qProject=growthFilters.project, qSkill=growthFilters.skill, qYear=growthFilters.year;
  const visible=all.filter(e=>{
    if(qProject!=='All'&&e.projectId!==qProject) return false;
    if(qSkill!=='All'&&!(e.skills||[]).includes(qSkill)) return false;
    if(qYear!=='All'&&String(new Date(e.date).getFullYear())!==String(qYear)) return false;
    return true;
  });
  const buckets=new Map();
  visible.forEach(e=>{const k=monthKey(e.date); if(!buckets.has(k)) buckets.set(k,[]); buckets.get(k).push(e);});
  const months=[...buckets.keys()].sort().reverse();
  const activeMonths=new Set(all.map(e=>monthKey(e.date)).filter(k=>k!=='unknown')).size;
  const contributingProjects=new Set(all.filter(e=>e.kind!=='Project').map(e=>e.projectId)).size;
  const repeatSkills=skills.filter(s=>s.projects>1).length;
  const latest=all[0];
  const projectOptions=state.projects.map(p=>`<option value="${escapeHtml(p.id)}" ${growthFilters.project===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  const skillOptions=skills.map(s=>`<option value="${escapeHtml(s.name)}" ${growthFilters.skill===s.name?'selected':''}>${escapeHtml(s.name)} (${s.count})</option>`).join('');
  const yearOptions=years.map(y=>`<option value="${y}" ${String(growthFilters.year)===String(y)?'selected':''}>${y}</option>`).join('');
  return `
    <div class="page-head backlog-head">
      <div><div class="eyebrow">Professional development history</div><h1>Professional Growth</h1><p>Acompanhe como projetos, entregas, decisões e aprendizados estão construindo experiência profissional ao longo do tempo.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="portfolio">My Portfolio</button><button class="btn btn-pink" data-view="projects">Projetos</button></div>
    </div>
    <div class="grid growth-stats">
      ${statCard('Experiências',all.length,'Marcos e evidências registradas','blue')}
      ${statCard('Meses ativos',activeMonths,'Meses com atividade documentada','')}
      ${statCard('Projetos com evidência',contributingProjects,'Contextos profissionais demonstrados','pink')}
      ${statCard('Competências recorrentes',repeatSkills,'Aparecem em mais de um projeto','')}
    </div>
    <div class="card card-pad growth-summary">
      <div class="growth-summary-main"><div class="eyebrow">Growth snapshot</div><h2>${latest?escapeHtml(latest.title):'Sua jornada começa com o primeiro projeto'}</h2><p>${latest?escapeHtml(latest.outcome||latest.summary||'Última experiência registrada.'):'Registre projetos e evidências para construir esta linha do tempo.'}</p></div>
      <div class="growth-summary-meta"><span><b>${skills.length}</b> competências documentadas</span><span><b>${state.projects.length}</b> projetos no workspace</span><span><b>${all.filter(e=>e.featured).length}</b> evidências em destaque</span></div>
    </div>
    <div class="growth-layout">
      <section class="card card-pad growth-timeline-panel">
        <div class="section-title"><div><h2>Growth Timeline</h2><p>${visible.length} experiência(s) dentro dos filtros atuais.</p></div></div>
        <div class="growth-filters">
          <select id="growthProjectFilter"><option value="All">Todos os projetos</option>${projectOptions}</select>
          <select id="growthSkillFilter"><option value="All">Todas as competências</option>${skillOptions}</select>
          <select id="growthYearFilter"><option value="All">Todos os anos</option>${yearOptions}</select>
        </div>
        ${months.length?`<div class="growth-timeline">${months.map(key=>`<div class="growth-month"><div class="growth-month-label"><span>${escapeHtml(monthLabel(key))}</span><small>${buckets.get(key).length} registro(s)</small></div><div class="growth-month-events">${buckets.get(key).map(renderGrowthEvent).join('')}</div></div>`).join('')}</div>`:`<div class="empty compact"><div class="bubble">↗</div><strong>Nenhum registro para estes filtros</strong><span>Altere projeto, competência ou ano para visualizar outra parte da jornada.</span></div>`}
      </section>
      <aside class="growth-side">
        <div class="card card-pad"><div class="section-title"><div><h2>Skill Journey</h2><p>Experiência observada em projetos, não uma nota.</p></div></div>
          ${skills.length?`<div class="growth-skill-list">${skills.slice(0,12).map(s=>`<button class="growth-skill-card" data-growth-skill="${escapeHtml(s.name)}"><span><strong>${escapeHtml(s.name)}</strong><small>${s.projects} projeto(s) • ${s.count} evidência(s)</small></span><b>${s.count}</b></button>`).join('')}</div>`:`<div class="empty compact"><span>As competências aparecerão conforme evidências forem registradas.</span></div>`}
        </div>
        <div class="card card-pad growth-principle"><div class="section-title"><div><h2>O que esta tela demonstra</h2><p>Portfólio baseado em prática.</p></div></div><div class="growth-principle-list"><span>Experiência em diferentes contextos.</span><span>Continuidade de aprendizado ao longo do tempo.</span><span>Competências sustentadas por evidências reais.</span><span>Decisões, resultados e melhoria contínua.</span></div></div>
      </aside>
    </div>`;
}

function renderGrowthEvent(item) {
  const skills=(item.skills||[]).slice(0,4).map(skill=>`<span>${escapeHtml(skill)}</span>`).join('');
  const kindClass=String(item.kind||item.source||'event').toLowerCase();
  return `<article class="growth-event"><div class="growth-event-marker ${kindClass}"></div><div class="growth-event-body"><div class="growth-event-top"><div><span class="growth-kind">${escapeHtml(item.kind==='Evidence'?(evidenceSourceLabel(item.source)||'Evidence'):item.kind)}</span><h3>${escapeHtml(item.title)}</h3><small>${fmtDate(item.date)} • ${escapeHtml(item.projectName)}</small></div><button class="text-button" data-growth-project="${escapeHtml(item.projectId)}">Abrir projeto</button></div><p>${escapeHtml(item.outcome||item.summary||'')}</p>${skills?`<div class="growth-event-skills">${skills}</div>`:''}</div></article>`;
}
function renderPortfolio() {
  const all = collectAllPortfolioEvidence();
  const contributingProjects = state.projects.filter(p => collectPortfolioEvidence(p).length > 0);
  const featured = all.filter(e => e.featured);
  const skillMap = new Map();
  all.forEach(e => (e.skills || []).forEach(skill => {
    const row = skillMap.get(skill) || { evidence:0, projects:new Set() };
    row.evidence += 1;
    row.projects.add(e.projectId);
    skillMap.set(skill,row);
  }));
  const skills=[...skillMap.entries()].map(([name,row])=>({name,evidence:row.evidence,projects:row.projects.size})).sort((a,b)=>b.evidence-a.evidence || a.name.localeCompare(b.name));
  const projectOptions = state.projects.filter(p => collectPortfolioEvidence(p).length).map(p=>`<option value="${escapeHtml(p.id)}" ${portfolioFilters.project===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  const skillOptions = skills.map(s=>`<option value="${escapeHtml(s.name)}" ${portfolioFilters.skill===s.name?'selected':''}>${escapeHtml(s.name)} (${s.evidence})</option>`).join('');
  const q=portfolioFilters.search.trim().toLowerCase();
  const visible=all.filter(e => {
    if (portfolioFilters.project!=='All' && e.projectId!==portfolioFilters.project) return false;
    if (portfolioFilters.skill!=='All' && !(e.skills||[]).includes(portfolioFilters.skill)) return false;
    if (q && ![e.projectName,e.title,e.summary,e.outcome,e.type,e.source,...(e.skills||[])].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  const highlighted=(featured.length ? featured : all).slice(0,4);
  return `
    <div class="page-head portfolio-head">
      <div><div class="eyebrow">Professional portfolio workspace</div><h1>My Portfolio</h1><p>Uma visão consolidada das experiências, decisões, resultados e competências demonstradas em todos os seus projetos.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-view="projects">Ver projetos</button><button class="btn btn-soft" data-view="caseStudy">Case Study atual</button><button class="btn btn-pink" data-view="evidence">Evidence Hub atual</button></div>
    </div>

    <div class="grid portfolio-stats">
      ${statCard('Projetos com evidência',contributingProjects.length,'Projetos contribuindo para o portfólio','blue')}
      ${statCard('Evidências',all.length,'Across all projects','')}
      ${statCard('Competências',skills.length,'Demonstradas por evidências','pink')}
      ${statCard('Featured',featured.length,'Destaques selecionados','')}
    </div>

    <div class="grid portfolio-overview">
      <section class="card card-pad">
        <div class="section-title"><div><h2>Projetos no portfólio</h2><p>Cada projeto contribui com evidências próprias.</p></div></div>
        ${contributingProjects.length ? `<div class="portfolio-project-grid">${contributingProjects.map(renderPortfolioProjectCard).join('')}</div>` : `<div class="empty compact"><div class="bubble">✦</div><strong>Seu portfólio ainda está vazio</strong><span>Marque decisões, retrospectivas e impedimentos como portfolio ou registre evidências manuais dentro dos projetos.</span></div>`}
      </section>
      <aside class="card card-pad portfolio-skills-panel">
        <div class="section-title"><div><h2>Competências demonstradas</h2><p>Evidências reais em diferentes contextos.</p></div></div>
        ${skills.length ? `<div class="portfolio-skill-list">${skills.slice(0,10).map((skill,index)=>renderPortfolioSkill(skill,skills[0]?.evidence||1,index)).join('')}</div>` : `<div class="empty compact"><span>As competências aparecerão quando houver evidências.</span></div>`}
      </aside>
    </div>

    ${highlighted.length ? `<section class="card card-pad portfolio-featured">
      <div class="section-title"><div><h2>${featured.length?'Featured Evidence':'Evidências recentes'}</h2><p>${featured.length?'Registros selecionados para ganhar destaque no portfólio.':'Marque evidências manuais como Featured para controlar esta seleção.'}</p></div></div>
      <div class="portfolio-highlight-grid">${highlighted.map(renderPortfolioHighlight).join('')}</div>
    </section>` : ''}

    <section class="card card-pad portfolio-library">
      <div class="section-title"><div><h2>Portfolio Library</h2><p>${all.length ? `${visible.length} de ${all.length} evidência(s) exibida(s).` : 'Todas as evidências dos seus projetos aparecerão aqui.'}</p></div></div>
      <div class="portfolio-filters">
        <input id="portfolioSearch" value="${escapeHtml(portfolioFilters.search)}" placeholder="Buscar projeto, evidência, habilidade ou resultado…" />
        <select id="portfolioProjectFilter"><option value="All">Todos os projetos</option>${projectOptions}</select>
        <select id="portfolioSkillFilter"><option value="All">Todas as competências</option>${skillOptions}</select>
      </div>
      ${visible.length ? `<div class="portfolio-library-list">${visible.map(renderPortfolioLibraryItem).join('')}</div>` : `<div class="empty compact"><div class="bubble">⌕</div><strong>${all.length?'Nenhuma evidência corresponde aos filtros':'Nenhuma evidência ainda'}</strong><span>${all.length?'Tente limpar ou alterar os filtros.':'Comece registrando evidências dentro dos projetos.'}</span></div>`}
    </section>`;
}

function renderPortfolioProjectCard(project) {
  const evidence=collectPortfolioEvidence(project);
  const skills=new Set(evidence.flatMap(e=>e.skills||[]));
  const featured=evidence.filter(e=>e.featured).length;
  const latest=evidence[0];
  return `<article class="portfolio-project-card">
    <div class="portfolio-project-accent"></div>
    <div class="portfolio-project-body">
      <div class="portfolio-project-head"><div><span class="badge ${project.status==='Active'?'blue':project.status==='Completed'?'pink':'gray'}">${escapeHtml(project.status)}</span><h3>${escapeHtml(project.name)}</h3><small>${escapeHtml(project.method)}${latest?` • última evidência ${fmtDate(latest.date)}`:''}</small></div><strong class="portfolio-project-count">${evidence.length}</strong></div>
      <p>${escapeHtml(project.description || 'Projeto sem descrição.')}</p>
      <div class="portfolio-project-metrics"><span><b>${skills.size}</b> skills</span><span><b>${featured}</b> featured</span><span><b>${(project.sprints||[]).filter(s=>s.status==='Completed').length}</b> sprints concluídas</span></div>
      <div class="portfolio-project-actions"><button class="btn btn-ghost" data-portfolio-project="${escapeHtml(project.id)}">Evidence Hub</button><button class="btn btn-soft" data-case-project="${escapeHtml(project.id)}">Case Study</button></div>
    </div>
  </article>`;
}

function renderPortfolioSkill(skill,maxEvidence,index) {
  const width=Math.max(12,Math.round((skill.evidence/maxEvidence)*100));
  return `<button class="portfolio-skill-row" data-portfolio-skill="${escapeHtml(skill.name)}" title="Filtrar portfolio por ${escapeHtml(skill.name)}">
    <div class="portfolio-skill-label"><span>${escapeHtml(skill.name)}</span><strong>${skill.evidence}</strong></div>
    <div class="portfolio-skill-bar"><i style="width:${width}%"></i></div>
    <small>${skill.projects} projeto(s) com evidência</small>
  </button>`;
}

function renderPortfolioHighlight(item) {
  return `<article class="portfolio-highlight-card">
    <div class="portfolio-highlight-top"><span class="evidence-source ${item.source.toLowerCase()}">${escapeHtml(evidenceSourceLabel(item.source))}</span>${item.featured?'<span class="badge portfolio-badge">★ Featured</span>':''}</div>
    <h3>${escapeHtml(item.title)}</h3>
    <div class="portfolio-project-pill">${escapeHtml(item.projectName)}</div>
    <p>${escapeHtml(item.outcome || item.summary || 'Evidência registrada.')}</p>
    <div class="portfolio-highlight-foot"><span>${fmtDate(item.date)}</span><button class="text-button" data-portfolio-project="${escapeHtml(item.projectId)}">Ver projeto →</button></div>
  </article>`;
}

function renderPortfolioLibraryItem(item) {
  const skills=(item.skills||[]).slice(0,5).map(s=>`<span class="evidence-skill">${escapeHtml(s)}</span>`).join('');
  return `<article class="portfolio-library-item">
    <div class="portfolio-library-date">${fmtDate(item.date)}</div>
    <div class="portfolio-library-copy">
      <div class="portfolio-library-title"><span class="evidence-source ${item.source.toLowerCase()}">${escapeHtml(evidenceSourceLabel(item.source))}</span>${item.featured?'<span class="badge portfolio-badge">★ Featured</span>':''}<strong>${escapeHtml(item.title)}</strong></div>
      <small>${escapeHtml(item.projectName)} • ${escapeHtml(item.type)}</small>
      <p>${escapeHtml(item.outcome || item.summary || '—')}</p>
      ${skills?`<div class="evidence-skills">${skills}</div>`:''}
    </div>
    <button class="btn btn-ghost" data-portfolio-project="${escapeHtml(item.projectId)}">Abrir</button>
  </article>`;
}


function caseStudyMetrics(project) {
  const completed=(project.sprints||[]).filter(s=>s.status==='Completed');
  const points=completed.reduce((acc,s)=>{
    const snap=s.snapshot||{};
    acc.planned += Number(snap.plannedPoints||0);
    acc.completed += Number(snap.completedPoints||0);
    acc.carry += Number(snap.carryOverPoints||0);
    return acc;
  },{planned:0,completed:0,carry:0});
  return { completedSprints:completed.length, ...points, evidence:collectPortfolioEvidence(project).length, decisions:(project.decisions||[]).length, retros:(project.retrospectives||[]).length };
}

function caseStudySelectedEvidence(project) {
  const all=collectPortfolioEvidence(project);
  const ids=project.caseStudy?.selectedEvidence||[];
  if (!ids.length) {
    const featured=all.filter(e=>e.featured);
    return (featured.length ? featured : all).slice(0,8);
  }
  return all.filter(e=>ids.includes(e.id));
}

function caseStudyCompleteness(project) {
  const cs=project.caseStudy||{};
  const fields=['title','role','challenge','responsibilities','approach','results','lessons'];
  const filled=fields.filter(k=>String(cs[k]||'').trim()).length;
  return Math.round((filled/fields.length)*100);
}

function caseStudyAutoDraft(project) {
  const evidence=collectPortfolioEvidence(project);
  const metrics=caseStudyMetrics(project);
  const retros=(project.retrospectives||[]).slice().sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
  const responsibilities=[];
  if (project.vision?.vision || project.vision?.problem) responsibilities.push('Product vision and problem framing');
  if ((project.goals||[]).length || (project.milestones||[]).length) responsibilities.push('Goals and milestone planning');
  if ((project.risks||[]).length) responsibilities.push('Risk identification and response planning');
  if ((project.epics||[]).length || (project.stories||[]).length) responsibilities.push('Backlog structuring and prioritization');
  if ((project.sprints||[]).length) responsibilities.push('Sprint planning and delivery tracking');
  if ((project.decisions||[]).length) responsibilities.push('Decision documentation and trade-off analysis');
  if ((project.retrospectives||[]).length) responsibilities.push('Retrospectives and continuous improvement');
  if ((project.impediments||[]).length) responsibilities.push('Impediment and risk management');
  const outcomes=evidence.map(e=>e.outcome).filter(Boolean).slice(0,4);
  const learnings=retros.map(r=>r.learned||r.changeNext).filter(Boolean).slice(0,3);
  const dates=[project.createdAt,project.updatedAt].filter(Boolean).map(d=>new Date(d)).filter(d=>!Number.isNaN(+d));
  const period=dates.length ? dates.map(d=>new Intl.DateTimeFormat('pt-BR',{month:'short',year:'numeric'}).format(d)).join(' — ') : '';
  return {
    title: project.caseStudy?.title || `${project.name} — Case Study`,
    role: project.caseStudy?.role || 'Product / Project Management',
    period: project.caseStudy?.period || period,
    challenge: project.caseStudy?.challenge || project.vision?.problem || project.description || '',
    responsibilities: project.caseStudy?.responsibilities || responsibilities.join('\n'),
    approach: project.caseStudy?.approach || [project.vision?.objectives, `Management approach: ${project.method||'Hybrid'}.`, (project.stories||[]).length?`${(project.stories||[]).length} User Stories structured in the backlog.`:'', (project.sprints||[]).length?`${(project.sprints||[]).length} Sprint(s) registered.`:''].filter(Boolean).join('\n'),
    results: project.caseStudy?.results || [metrics.completedSprints?`${metrics.completedSprints} Sprint(s) completed with ${metrics.completed} of ${metrics.planned} planned points delivered.`:'', ...outcomes].filter(Boolean).join('\n'),
    lessons: project.caseStudy?.lessons || learnings.join('\n')
  };
}

function renderCaseStudy(project) {
  if (!project) return renderNoProject();
  const cs=project.caseStudy||{};
  const draft=caseStudyAutoDraft(project);
  const all=collectPortfolioEvidence(project);
  const selected=caseStudySelectedEvidence(project);
  const selectedIds=new Set((cs.selectedEvidence||[]).length ? cs.selectedEvidence : selected.map(e=>e.id));
  const metrics=caseStudyMetrics(project);
  const completeness=caseStudyCompleteness(project);
  const skillSet=[...new Set(selected.flatMap(e=>e.skills||[]))];
  return `
    <div class="page-head backlog-head no-print">
      <div><div class="eyebrow">Portfolio-ready project narrative</div><h1>Case Study Builder</h1><p>Transforme os dados reais de ${escapeHtml(project.name)} em uma narrativa profissional estruturada, pronta para revisão, exportação e PDF.</p></div>
      <div class="head-actions"><button class="btn btn-soft" data-action="case-autofill">Gerar rascunho</button><button class="btn btn-primary" data-action="edit-case-study">Editar narrativa</button><button class="btn btn-pink" data-action="case-print">Imprimir / PDF</button></div>
    </div>
    <div class="grid case-study-stats no-print">
      ${statCard('Completude',`${completeness}%`,'Campos narrativos preenchidos','blue')}
      ${statCard('Evidências',selected.length,`${all.length} disponíveis no projeto`,'')}
      ${statCard('Sprints concluídas',metrics.completedSprints,'Histórico de execução','pink')}
      ${statCard('Status',cs.status||'Draft','Case Study profissional','')}
    </div>
    <div class="case-study-layout">
      <aside class="card card-pad case-study-controls no-print">
        <div class="section-title"><div><h2>Evidence selection</h2><p>Escolha os registros que sustentam este case.</p></div><span class="badge portfolio-badge">${selected.length} selected</span></div>
        ${all.length ? `<div class="case-evidence-list">${all.map(e=>`<label class="case-evidence-item"><input type="checkbox" data-case-evidence="${escapeHtml(e.id)}" ${selectedIds.has(e.id)?'checked':''}><span><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml(evidenceSourceLabel(e.source))} • ${fmtDate(e.date)}</small></span></label>`).join('')}</div>` : `<div class="empty compact"><span>Adicione evidências no Evidence Hub para fortalecer este case.</span></div>`}
        <div class="case-export-actions"><button class="btn btn-soft" data-action="case-export-json">Exportar JSON</button><button class="btn btn-soft" data-action="case-export-md">Exportar Markdown</button></div>
        <div class="case-note"><strong>Local-first</strong><span>As exportações são geradas no navegador. Nenhum dado do projeto é enviado para um backend.</span></div>
      </aside>
      <article class="card case-study-preview" id="caseStudyPrintable">
        <div class="case-cover">
          <div><span class="case-kicker">AGILEFLOW • CASE STUDY</span><h2>${escapeHtml(draft.title)}</h2><p>${escapeHtml(project.description||'Professional project case study')}</p></div>
          <div class="case-cover-meta"><span><b>Role</b>${escapeHtml(draft.role||'—')}</span><span><b>Period</b>${escapeHtml(draft.period||'—')}</span><span><b>Method</b>${escapeHtml(project.method||'—')}</span><span><b>Status</b>${escapeHtml(cs.status||'Draft')}</span></div>
        </div>
        <div class="case-body">
          ${caseNarrativeSection('01','The Challenge',draft.challenge)}
          ${caseNarrativeSection('02','My Responsibilities',draft.responsibilities)}
          ${caseNarrativeSection('03','Approach & Process',draft.approach)}
          <section class="case-section"><div class="case-section-index">04</div><div><h3>Delivery Snapshot</h3><div class="case-metric-grid"><div><b>${metrics.completedSprints}</b><span>Completed Sprints</span></div><div><b>${metrics.completed}</b><span>Completed Points</span></div><div><b>${metrics.evidence}</b><span>Portfolio Evidence</span></div><div><b>${(project.stories||[]).filter(s=>s.status==='Done').length}</b><span>Stories Done</span></div></div></div></section>
          ${caseNarrativeSection('05','Results & Impact',draft.results)}
          ${selected.length?`<section class="case-section"><div class="case-section-index">06</div><div><h3>Selected Evidence</h3><div class="case-preview-evidence">${selected.map(e=>`<div><span>${escapeHtml(evidenceSourceLabel(e.source))}</span><strong>${escapeHtml(e.title)}</strong><p>${escapeHtml(e.outcome||e.summary||'')}</p></div>`).join('')}</div></div></section>`:''}
          ${caseNarrativeSection(selected.length?'07':'06','Lessons Learned',draft.lessons)}
          ${skillSet.length?`<section class="case-section case-skills"><div class="case-section-index">${selected.length?'08':'07'}</div><div><h3>Competencies Demonstrated</h3><div class="case-skill-cloud">${skillSet.map(s=>`<span>${escapeHtml(s)}</span>`).join('')}</div></div></section>`:''}
        </div>
        <footer class="case-footer"><strong>AgileFlow</strong><span>Generated from documented project evidence • ${new Date().toLocaleDateString('pt-BR')}</span></footer>
      </article>
    </div>`;
}

function caseNarrativeSection(index,title,text) {
  const paragraphs=String(text||'').split(/\n+/).map(v=>v.trim()).filter(Boolean);
  return `<section class="case-section"><div class="case-section-index">${index}</div><div><h3>${escapeHtml(title)}</h3>${paragraphs.length?paragraphs.map(p=>`<p>${escapeHtml(p)}</p>`).join(''):'<p class="case-empty-text">Complete esta seção em “Editar narrativa”.</p>'}</div></section>`;
}

function buildCaseStudyExport(project) {
  const draft=caseStudyAutoDraft(project);
  return {
    agileFlowVersion:APP_VERSION, generatedAt:new Date().toISOString(),
    project:{id:project.id,name:project.name,description:project.description,method:project.method,status:project.status,createdAt:project.createdAt,updatedAt:project.updatedAt},
    caseStudy:{...project.caseStudy,...draft},
    metrics:caseStudyMetrics(project),
    evidence:caseStudySelectedEvidence(project).map(({id,source,type,title,summary,outcome,skills,date,reference,featured})=>({id,source,type,title,summary,outcome,skills,date,reference,featured}))
  };
}

function downloadTextFile(filename,textValue,mime='text/plain;charset=utf-8') {
  const blob=new Blob([textValue],{type:mime});
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function caseStudyMarkdown(project) {
  const data=buildCaseStudyExport(project); const c=data.caseStudy; const m=data.metrics;
  const evidence=data.evidence.map(e=>`### ${e.title}\n**Source:** ${e.source}${e.date?` • ${e.date}`:''}\n\n${e.summary||''}\n\n**Outcome:** ${e.outcome||'—'}\n\n${(e.skills||[]).length?`**Skills:** ${(e.skills||[]).join(', ')}\n`:''}`).join('\n---\n\n');
  return `# ${c.title}\n\n**Project:** ${data.project.name}  \n**Role:** ${c.role||'—'}  \n**Period:** ${c.period||'—'}  \n**Method:** ${data.project.method||'—'}  \n**Status:** ${c.status||'Draft'}\n\n## The Challenge\n${c.challenge||'—'}\n\n## My Responsibilities\n${c.responsibilities||'—'}\n\n## Approach & Process\n${c.approach||'—'}\n\n## Delivery Snapshot\n- Completed Sprints: ${m.completedSprints}\n- Completed Points: ${m.completed}\n- Planned Points: ${m.planned}\n- Portfolio Evidence: ${m.evidence}\n\n## Results & Impact\n${c.results||'—'}\n\n## Selected Evidence\n${evidence||'No evidence selected.'}\n\n## Lessons Learned\n${c.lessons||'—'}\n`;
}


function workspaceBackupPayload() {
  return {
    format: 'agileflow-workspace-backup',
    formatVersion: 1,
    agileFlowVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    state
  };
}

function projectExportPayload(project) {
  return {
    format: 'agileflow-project',
    formatVersion: 1,
    agileFlowVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    project,
    activities: state.activities.filter(item => item.projectId === project.id)
  };
}

function renderDataBackup(project) {
  const lastBackup = state.preferences?.lastBackupAt ? fmtDate(state.preferences.lastBackupAt) : 'Nenhum backup registrado';
  const projectCount = state.projects.length;
  const activities = state.activities.length;
  const approxKb = Math.max(1, Math.round(new Blob([JSON.stringify(state)]).size / 1024));
  return `
    <div class="page-head">
      <div><div class="eyebrow">Local-first • Data safety</div><h1>Data & Backup</h1><p>Proteja o workspace, mova projetos entre Windows e macOS e conecte o WebApp ao Local Bridge sem banco online.</p></div>
      <button class="btn btn-pink" data-action="export-workspace">⇩ Backup completo</button>
    </div>
    <div class="grid stats">
      ${statCard('Projetos', projectCount, 'Incluídos no backup', 'blue')}
      ${statCard('Atividades', activities, 'Histórico preservado', '')}
      ${statCard('Tamanho local', `~${approxKb} KB`, 'Estimativa do JSON atual', 'pink')}
      ${statCard('Último backup', lastBackup, 'Registrado neste navegador', '')}
    </div>

    <div class="data-grid">
      <section class="card card-pad data-panel">
        <div class="section-title"><div><h2>Workspace completo</h2><p>Todos os projetos, preferências e histórico.</p></div><span class="badge blue">.json</span></div>
        <p class="data-copy">Use este arquivo para recuperar o AgileFlow neste ou em outro computador. A restauração substitui o workspace atual somente após sua confirmação.</p>
        <div class="data-actions"><button class="btn btn-primary" data-action="export-workspace">Exportar backup</button><button class="btn btn-ghost" data-action="choose-workspace-import">Importar backup</button></div>
        <input class="file-input" id="workspaceImportFile" type="file" accept="application/json,.json,.agileflow" />
      </section>

      <section class="card card-pad data-panel">
        <div class="section-title"><div><h2>Projeto atual</h2><p>${project ? escapeHtml(project.name) : 'Nenhum projeto selecionado'}</p></div><span class="badge pink">Portable</span></div>
        <p class="data-copy">Exporte somente um projeto para levar entre Windows e macOS, arquivar ou compartilhar uma cópia sem expor os demais dados do workspace.</p>
        <div class="data-actions"><button class="btn btn-primary" data-action="export-project" ${project?'':'disabled'}>Exportar projeto</button><button class="btn btn-ghost" data-action="choose-project-import">Importar projeto</button></div>
        <input class="file-input" id="projectImportFile" type="file" accept="application/json,.json,.agileproject" />
      </section>

      <section class="card card-pad data-panel project-files-panel">
        <div class="section-title"><div><h2>Arquivos do projeto</h2><p>${project ? escapeHtml(project.name) : 'Nenhum projeto selecionado'}</p></div><span class="badge blue">Local files</span></div>
        ${project ? `
          <p class="data-copy">Quando o modo Local-first está ativo, o Bridge materializa este projeto em arquivos legíveis dentro de <code>Documents/AgileFlow/projects/${escapeHtml(slugify(project.name))}/</code>.</p>
          <div class="file-tree"><code>project.json</code><code>backlog/epics.json</code><code>backlog/stories.json</code><code>sprints/</code><code>retrospectives/</code><code>decisions/</code><code>impediments/</code><code>evidence/</code><code>case-study.json</code></div>
          <div class="safety-note"><strong>Portável e legível.</strong><span>O workspace completo continua em <code>workspace.json</code>, enquanto esses arquivos separados facilitam backup, inspeção e recuperação por projeto.</span></div>
        ` : '<p class="data-copy">Crie ou selecione um projeto para visualizar sua estrutura local.</p>'}
      </section>

      <section class="card card-pad data-panel bridge-panel">
        <div class="section-title"><div><h2>Local Bridge</h2><p>Conexão entre o WebApp e as pastas deste computador.</p></div><span class="bridge-status ${bridgeStatus.connected ? 'online' : bridgeStatus.state === 'checking' ? 'checking' : 'offline'}"><i></i>${bridgeStatus.connected ? 'Conectado' : bridgeStatus.state === 'checking' ? 'Verificando' : 'Não detectado'}</span></div>
        <div class="bridge-flow"><span>AgileFlow WebApp</span><b>→</b><span>Local Bridge</span><b>→</b><span class="active-store">Documents/AgileFlow</span></div>
        ${bridgeStatus.connected ? `
          <div class="bridge-details">
            <div><small>Versão</small><strong>${escapeHtml(bridgeStatus.version || '—')}</strong></div>
            <div><small>Plataforma</small><strong>${escapeHtml(bridgeStatus.platform || '—')}</strong></div>
            <div class="wide"><small>Pasta local</small><strong>${escapeHtml(bridgeStatus.root || '—')}</strong></div>
            <div><small>Workspace local</small><strong>${bridgeStatus.workspaceExists ? 'Encontrado' : 'Ainda vazio'}</strong></div>
            <div><small>Modo de dados</small><strong>${state.preferences.bridgePrimaryEnabled ? 'Local-first' : 'Browser only'}</strong></div>
            <div><small>Última sincronização</small><strong>${state.preferences.lastBridgeSyncAt ? fmtDate(state.preferences.lastBridgeSyncAt) : '—'}</strong></div>
          </div>
          <div class="data-actions wrap">
            <button class="btn btn-primary" data-action="bridge-enable-mirror">${state.preferences.bridgePrimaryEnabled ? 'Sincronizar agora' : 'Ativar Local-first'}</button>
            ${bridgeStatus.workspaceExists ? '<button class="btn btn-ghost" data-action="bridge-load">Recarregar dos arquivos locais</button>' : ''}
            <button class="btn btn-ghost" data-action="bridge-backup">Criar backup local</button>
            ${state.preferences.bridgePrimaryEnabled ? '<button class="btn btn-ghost" data-action="bridge-disable-mirror">Usar somente navegador</button>' : ''}
          </div>
        ` : `
          <p class="data-copy">O AgileFlow continua usando o navegador normalmente. Quando o Bridge estiver instalado e executando, esta página o detectará em <code>127.0.0.1:43127</code> e poderá espelhar os dados para arquivos locais.</p>
          <div class="data-actions"><button class="btn btn-primary" data-action="bridge-detect">Detectar novamente</button></div>
        `}
        <div class="safety-note"><strong>Local-first com fallback.</strong><span>Quando o Bridge está conectado, Documents/AgileFlow é a fonte principal. Se ele estiver fechado, o AgileFlow continua funcionando pelo cache do navegador e sincroniza a cópia mais recente quando o Bridge voltar.</span></div>
      </section>
    </div>`;
}

async function readJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}

function exportWorkspaceBackup() {
  const payload = workspaceBackupPayload();
  downloadTextFile(`agileflow-workspace-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(payload,null,2), 'application/json;charset=utf-8');
  state.preferences.lastBackupAt = new Date().toISOString();
  addActivity('Backup completo exportado', `${state.projects.length} projeto(s) incluído(s).`, state.currentProjectId);
  saveState(); render(); showToast('Backup completo exportado.');
}

function exportCurrentProject() {
  const project=currentProject(); if(!project) return;
  const payload=projectExportPayload(project);
  downloadTextFile(`${slugify(project.name)}.agileproject.json`, JSON.stringify(payload,null,2), 'application/json;charset=utf-8');
  addActivity('Projeto exportado', `${project.name} foi exportado como arquivo portátil.`, project.id);
  saveState(); render(); showToast('Projeto exportado.');
}

async function importWorkspaceBackup(file) {
  try {
    const payload=await readJsonFile(file);
    const candidate=payload?.format==='agileflow-workspace-backup' ? payload.state : payload;
    if(!candidate || !Array.isArray(candidate.projects)) throw new Error('Formato inválido');
    if(!confirm(`Restaurar este backup com ${candidate.projects.length} projeto(s)? O workspace atual deste navegador será substituído.`)) return;
    state=normalizeState(candidate);
    saveState(); activeView='dashboard'; render(); showToast('Backup restaurado com sucesso.');
  } catch (error) {
    console.error(error); showToast('Não foi possível importar este backup.');
  }
}

async function importProjectFile(file) {
  try {
    const payload=await readJsonFile(file);
    const incoming=payload?.format==='agileflow-project' ? payload.project : payload?.project || payload;
    if(!incoming || typeof incoming!=='object' || !incoming.name) throw new Error('Formato inválido');
    const copy=JSON.parse(JSON.stringify(incoming));
    const existingIndex=state.projects.findIndex(p=>p.id===copy.id);
    if(existingIndex>=0) {
      const replace=confirm(`Já existe um projeto com o identificador “${copy.id}”. OK para substituir; Cancelar para importar como cópia.`);
      if(replace) state.projects[existingIndex]=copy;
      else { copy.id=uid(); copy.name=`${copy.name} (Importado)`; state.projects.push(copy); }
    } else state.projects.push(copy);
    const importedProject=normalizeState({...state,projects:state.projects}).projects.find(p=>p.id===copy.id) || copy;
    state.currentProjectId=importedProject.id;
    const importedActivities=Array.isArray(payload?.activities)?payload.activities:[];
    const existingActivityIds=new Set(state.activities.map(a=>a.id));
    importedActivities.forEach(a=>{ if(!existingActivityIds.has(a.id)) state.activities.push(a); });
    addActivity('Projeto importado', `${importedProject.name} foi adicionado ao workspace.`, importedProject.id);
    saveState(); activeView='dashboard'; render(); showToast('Projeto importado com sucesso.');
  } catch(error) {
    console.error(error); showToast('Não foi possível importar este projeto.');
  }
}

function renderComingSoon(title, subtitle) {
  return `<div class="page-head"><div><div class="eyebrow">Roadmap</div><h1>${title}</h1><p>${subtitle}</p></div></div>
  <div class="card"><div class="empty"><div class="bubble">${icon(activeView)}</div><strong>Próximo incremento</strong><span>Esta área já está prevista na arquitetura e será ligada aos mesmos dados do projeto.</span></div></div>`;
}

function renderNoProject() {
  return `<div class="card"><div class="empty"><div class="bubble">▣</div><strong>Crie um projeto primeiro</strong><span>O AgileFlow precisa de um projeto ativo para abrir esta área.</span></div></div>`;
}

function renderModal() {
  if (modal === 'onboarding') return renderOnboardingModal();
  if (modal === 'help') return renderHelpModal();
  if (modal && modal.type === 'sync-conflict') return renderConflictModal();
  if (modal === 'new-project') {
    const templates = Object.values(PROJECT_TEMPLATES);
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-project-wizard" onclick="event.stopPropagation()">
      <div class="modal-head"><div><div class="wizard-kicker">Guided Project Setup</div><h2>Novo projeto</h2><p>Defina o contexto primeiro. O AgileFlow monta o workspace de acordo com a forma de trabalho escolhida.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="newProjectForm">
        <section class="wizard-section">
          <div class="wizard-step"><span>1</span><div><strong>Escolha a abordagem</strong><small>Isso controla quais módulos aparecem no projeto.</small></div></div>
          <div class="template-picker">
            ${templates.map((t,i)=>`<label class="template-option"><input type="radio" name="method" value="${escapeHtml(t.key)}" ${t.key==='Hybrid'?'checked':''}><span class="template-option-card"><span class="template-option-icon">${escapeHtml(t.icon)}</span><span><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.description)}</small><em>${escapeHtml(t.bestFor)}</em></span></span></label>`).join('')}
          </div>
          <div id="templatePreview" class="template-preview"></div>
        </section>

        <section class="wizard-section">
          <div class="wizard-step"><span>2</span><div><strong>Defina o projeto</strong><small>Dê contexto suficiente para o trabalho começar com direção clara.</small></div></div>
          <div class="form-grid">
            <div class="field"><label>Nome do projeto</label><input name="name" required maxlength="80" placeholder="Ex.: Redesenho do processo de matrícula" /></div>
            <div class="field"><label>Status inicial</label><select name="status"><option selected>Planning</option><option>Active</option><option>Paused</option></select></div>
            <div class="field full"><label>Contexto / descrição</label><textarea name="description" maxlength="420" placeholder="O que é este projeto e por que ele existe?"></textarea></div>
            <div class="field full"><label>Problema ou desafio</label><textarea name="challenge" maxlength="600" placeholder="Qual problema, oportunidade ou necessidade deu origem ao projeto?"></textarea></div>
            <div class="field full"><label>Objetivo principal</label><textarea name="goal" maxlength="500" placeholder="Que resultado queremos alcançar?"></textarea></div>
          </div>
        </section>

        <section class="wizard-section">
          <div class="wizard-step"><span>3</span><div><strong>Contexto de gestão</strong><small>Essas informações já alimentam a Product Vision e o futuro Case Study.</small></div></div>
          <div class="form-grid">
            <div class="field"><label>Stakeholders</label><input name="stakeholders" maxlength="320" placeholder="Ex.: Rachel, diretoria, alunos" /></div>
            <div class="field"><label>Prazo / horizonte</label><input name="deadline" maxlength="120" placeholder="Ex.: Dez/2026, 8 semanas, contínuo" /></div>
            <div class="field full"><label>Critérios de sucesso</label><textarea name="successCriteria" maxlength="600" placeholder="Como saberemos que o projeto atingiu um resultado satisfatório?"></textarea></div>
            <div class="field full"><label>Restrições conhecidas</label><textarea name="constraints" maxlength="500" placeholder="Ex.: orçamento zero, prazo acadêmico, hardware antigo, disponibilidade limitada"></textarea></div>
          </div>
        </section>
        <div class="wizard-note"><strong>Você poderá ajustar tudo depois.</strong><span>O template não prende o projeto a uma metodologia; ele apenas reduz ruído e mostra inicialmente as ferramentas mais relevantes.</span></div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button class="btn btn-pink">Criar workspace do projeto</button></div>
      </form>
    </div></div>`;
  }

  if (modal && modal.type === 'goal') {
    const p=currentProject(); const existing=modal.id?(p?.goals||[]).find(x=>x.id===modal.id):null; const x=existing||{title:'',description:'',status:'Planned',targetDate:'',successMeasure:''};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-small" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>${existing?'Editar Goal':'Novo Goal'}</h2><p>Defina um resultado claro e como ele será reconhecido.</p></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="modal-body" id="goalForm" data-id="${escapeHtml(existing?.id||'')}"><div class="form-grid"><div class="field full"><label>Título</label><input name="title" required maxlength="100" value="${escapeHtml(x.title)}"></div><div class="field full"><label>Descrição</label><textarea name="description" maxlength="500">${escapeHtml(x.description)}</textarea></div><div class="field"><label>Status</label><select name="status">${['Planned','In Progress','Achieved','Dropped'].map(v=>`<option ${x.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Data alvo</label><input type="date" name="targetDate" value="${escapeHtml(x.targetDate)}"></div><div class="field full"><label>Success measure</label><input name="successMeasure" maxlength="300" value="${escapeHtml(x.successMeasure)}" placeholder="Como saberemos que este goal foi atingido?"></div></div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-goal">Excluir</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">Salvar</button></div></div></form></div></div>`;
  }

  if (modal && modal.type === 'milestone') {
    const p=currentProject(); const existing=modal.id?(p?.milestones||[]).find(x=>x.id===modal.id):null; const x=existing||{title:'',description:'',status:'Upcoming',dueDate:'',goalId:'',includeInPortfolio:false};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-small" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>${existing?'Editar Milestone':'Novo Milestone'}</h2><p>Registre um ponto de validação ou entrega relevante.</p></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="modal-body" id="milestoneForm" data-id="${escapeHtml(existing?.id||'')}"><div class="form-grid"><div class="field full"><label>Título</label><input name="title" required maxlength="100" value="${escapeHtml(x.title)}"></div><div class="field full"><label>Descrição</label><textarea name="description" maxlength="500">${escapeHtml(x.description)}</textarea></div><div class="field"><label>Status</label><select name="status">${['Upcoming','In Progress','Completed','Missed'].map(v=>`<option ${x.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Due date</label><input type="date" name="dueDate" value="${escapeHtml(x.dueDate)}"></div><div class="field full"><label>Goal relacionado</label><select name="goalId"><option value="">Nenhum</option>${(p?.goals||[]).map(g=>`<option value="${escapeHtml(g.id)}" ${x.goalId===g.id?'selected':''}>${escapeHtml(g.title)}</option>`).join('')}</select></div><label class="check-row full"><input type="checkbox" name="includeInPortfolio" ${x.includeInPortfolio?'checked':''}><span>★ Usar como evidência no portfólio</span></label></div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-milestone">Excluir</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">Salvar</button></div></div></form></div></div>`;
  }

  if (modal && modal.type === 'risk') {
    const p=currentProject(); const existing=modal.id?(p?.risks||[]).find(x=>x.id===modal.id):null; const x=existing||{title:'',description:'',probability:'Medium',impact:'Medium',response:'Reduce',mitigation:'',status:'Open',includeInPortfolio:false};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>${existing?'Editar Risk':'Novo Risk'}</h2><p>Registre exposição, resposta e mitigação antes de o risco virar um problema real.</p></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="modal-body" id="riskForm" data-id="${escapeHtml(existing?.id||'')}"><div class="form-grid"><div class="field full"><label>Título</label><input name="title" required maxlength="100" value="${escapeHtml(x.title)}"></div><div class="field full"><label>Descrição</label><textarea name="description" maxlength="600">${escapeHtml(x.description)}</textarea></div><div class="field"><label>Probability</label><select name="probability">${['Low','Medium','High'].map(v=>`<option ${x.probability===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Impact</label><select name="impact">${['Low','Medium','High'].map(v=>`<option ${x.impact===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Response</label><select name="response">${['Avoid','Reduce','Transfer','Accept'].map(v=>`<option ${x.response===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label>Status</label><select name="status">${['Open','Monitoring','Mitigated','Closed'].map(v=>`<option ${x.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field full"><label>Mitigation / response plan</label><textarea name="mitigation" maxlength="700">${escapeHtml(x.mitigation)}</textarea></div><label class="check-row full"><input type="checkbox" name="includeInPortfolio" ${x.includeInPortfolio?'checked':''}><span>★ Usar como evidência de Risk Management no portfólio</span></label></div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-risk">Excluir</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">Salvar</button></div></div></form></div></div>`;
  }

  if (modal === 'edit-vision') {
    const p = currentProject(); const v = p?.vision || {};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>Product Vision</h2><p>${escapeHtml(p?.name || '')}</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="visionForm">
        <div class="form-grid">
          ${textareaField('problem','Problem','Qual problema este projeto resolve?',v.problem)}
          ${textareaField('vision','Vision','Que futuro desejamos criar?',v.vision)}
          ${textareaField('objectives','Objectives','Quais objetivos principais devem ser alcançados?',v.objectives)}
          ${textareaField('successCriteria','Success Criteria','Como saberemos que o projeto teve sucesso?',v.successCriteria)}
          ${textareaField('constraints','Constraints','Quais restrições precisam ser respeitadas?',v.constraints)}
        </div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button class="btn btn-primary">Salvar visão</button></div>
      </form>
    </div></div>`;
  }

  if (modal === 'new-epic') {
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-small" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>Novo Epic</h2><p>Crie uma grande área de valor para organizar o backlog.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="epicForm">
        <div class="form-grid"><div class="field full"><label>Nome do Epic</label><input name="title" required maxlength="90" placeholder="Ex.: Portfolio & Growth" /></div>
        <div class="field full"><label>Descrição</label><textarea name="description" maxlength="300" placeholder="Que resultado ou área este Epic representa?"></textarea></div></div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button class="btn btn-pink">Criar Epic</button></div>
      </form>
    </div></div>`;
  }


  if (modal && modal.type === 'sprint') {
    const p = currentProject();
    const existing = modal.id ? (p?.sprints || []).find(s => s.id === modal.id) : null;
    const s = existing || { name:`Sprint ${(p?.sprints?.length || 0) + 1}`, goal:'', startDate:'', endDate:'', capacity:0, status:'Planned' };
    const selectableStories = (p?.stories || []).filter(story => story.status !== 'Done' || story.sprintId === existing?.id);
    const selectedIds = new Set((p?.stories || []).filter(story => story.sprintId === existing?.id).map(story => story.id));
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing ? `Editar ${escapeHtml(existing.name)}` : 'Nova Sprint'}</h2><p>Defina objetivo, período, capacidade e selecione o trabalho do ciclo.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="sprintForm" data-sprint-id="${escapeHtml(existing?.id || '')}">
        <div class="form-grid">
          <div class="field"><label>Nome</label><input name="name" required maxlength="80" value="${escapeHtml(s.name || '')}" placeholder="Sprint 1" /></div>
          <div class="field"><label>Capacidade (Story Points)</label><input name="capacity" type="number" min="0" max="999" value="${Number(s.capacity)||0}" /></div>
          <div class="field"><label>Data inicial</label><input name="startDate" type="date" value="${escapeHtml(s.startDate || '')}" /></div>
          <div class="field"><label>Data final</label><input name="endDate" type="date" value="${escapeHtml(s.endDate || '')}" /></div>
          <div class="field full"><label>Sprint Goal</label><textarea name="goal" maxlength="500" placeholder="Qual resultado queremos alcançar nesta Sprint?">${escapeHtml(s.goal || '')}</textarea></div>
          <div class="field full"><label>User Stories</label>
            <div class="sprint-story-picker">
              ${selectableStories.length ? selectableStories.map(story => {
                const anotherSprint = story.sprintId && story.sprintId !== existing?.id ? (p?.sprints||[]).find(sp=>sp.id===story.sprintId) : null;
                return `<label class="sprint-story-option"><input type="checkbox" name="storyIds" value="${escapeHtml(story.id)}" ${selectedIds.has(story.id)?'checked':''} /><span class="story-id">${escapeHtml(story.key)}</span><span class="sprint-picker-copy"><strong>${escapeHtml(story.title)}</strong><small>${Number(story.storyPoints)||0} pts • ${escapeHtml(story.status)}${anotherSprint ? ` • atualmente em ${escapeHtml(anotherSprint.name)}` : ''}</small></span></label>`;
              }).join('') : `<div class="empty compact"><strong>Nenhuma Story disponível</strong><span>Crie User Stories no Product Backlog primeiro.</span></div>`}
            </div>
          </div>
        </div>
        <div class="form-actions between">${existing && existing.status==='Planned' ? '<button type="button" class="btn btn-danger" data-action="delete-sprint">Excluir Sprint</button>' : '<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar Sprint':'Criar Sprint'}</button></div></div>
      </form>
    </div></div>`;
  }

  if (modal && modal.type === 'retro') {
    const p = currentProject();
    const existing = modal.id ? (p?.retrospectives || []).find(r => r.id === modal.id) : null;
    const completedSprints = (p?.sprints || []).filter(s => s.status === 'Completed');
    const usedSprintIds = new Set((p?.retrospectives || []).filter(r => r.id !== existing?.id && r.sprintId).map(r => r.sprintId));
    const availableSprints = completedSprints.filter(s => !usedSprintIds.has(s.id));
    const r = existing || { sprintId: modal.sprintId || null, title:'', wentWell:'', didntGoWell:'', learned:'', changeNext:'', includeInPortfolio:false, actionItems:[] };
    const actionText = (r.actionItems || []).map(item => item.text).join('\n');
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing ? 'Editar Retrospectiva' : 'Nova Retrospectiva'}</h2><p>Registre aprendizado e transforme observações em ações concretas.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="retroForm" data-retro-id="${escapeHtml(existing?.id || '')}">
        <div class="form-grid">
          <div class="field"><label>Ciclo / Sprint</label><select name="sprintId"><option value="">Retrospectiva geral</option>${availableSprints.map(s=>`<option value="${escapeHtml(s.id)}" ${r.sprintId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Título opcional</label><input name="title" maxlength="120" value="${escapeHtml(r.title || '')}" placeholder="Ex.: Aprendizados do primeiro MVP" /></div>
          ${textareaField('wentWell','What went well?','O que funcionou bem e merece ser mantido?',r.wentWell)}
          ${textareaField('didntGoWell',"What didn't go well?",'O que dificultou o trabalho ou não gerou o resultado esperado?',r.didntGoWell)}
          ${textareaField('learned','What did we learn?','Que aprendizado este ciclo gerou?',r.learned)}
          ${textareaField('changeNext','What should change?','O que será feito de forma diferente no próximo ciclo?',r.changeNext)}
          <div class="field full"><label>Action Items <span class="field-hint">um por linha</span></label><textarea name="actionItems" placeholder="Quebrar Stories acima de 8 pts antes do Planning\nRevisar critérios de aceite antes de iniciar desenvolvimento">${escapeHtml(actionText)}</textarea></div>
          <label class="portfolio-check field full"><input type="checkbox" name="includeInPortfolio" ${r.includeInPortfolio?'checked':''} /><span><strong>★ Add to Portfolio</strong><small>Marcar esta retrospectiva como evidência profissional para o futuro Case Study Builder.</small></span></label>
        </div>
        <div class="form-actions between">${existing ? '<button type="button" class="btn btn-danger" data-action="delete-retro">Excluir Retrospectiva</button>' : '<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar alterações':'Salvar retrospectiva'}</button></div></div>
      </form>
    </div></div>`;
  }


  if (modal && modal.type === 'decision') {
    const p=currentProject();
    const existing=modal.id ? (p?.decisions||[]).find(d=>d.id===modal.id) : null;
    const d=existing || {title:'',context:'',alternatives:'',decision:'',reason:'',impact:'',sprintId:null,includeInPortfolio:false};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing?'Editar decisão':'Nova decisão'}</h2><p>Preserve o raciocínio que levou a uma escolha relevante.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="decisionForm" data-decision-id="${escapeHtml(existing?.id||'')}"><div class="form-grid">
        <div class="field full"><label>Título</label><input name="title" required maxlength="140" value="${escapeHtml(d.title||'')}" placeholder="Ex.: Manter persistência local em vez de banco em nuvem" /></div>
        <div class="field"><label>Sprint relacionada</label><select name="sprintId"><option value="">Decisão de projeto</option>${(p?.sprints||[]).map(sp=>`<option value="${escapeHtml(sp.id)}" ${d.sprintId===sp.id?'selected':''}>${escapeHtml(sp.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Data</label><input value="${fmtDate(d.createdAt||new Date().toISOString())}" disabled /></div>
        ${textareaField('context','Contexto','Qual situação ou problema exigiu uma decisão?',d.context)}
        ${textareaField('alternatives','Alternativas consideradas','Quais caminhos foram avaliados?',d.alternatives)}
        ${textareaField('decision','Decisão tomada','O que foi decidido?',d.decision)}
        ${textareaField('reason','Justificativa','Por que esta opção foi escolhida?',d.reason)}
        ${textareaField('impact','Impacto','Qual impacto esperado ou observado?',d.impact)}
        <label class="portfolio-check field full"><input type="checkbox" name="includeInPortfolio" ${d.includeInPortfolio?'checked':''} /><span><strong>★ Add to Portfolio</strong><small>Preservar esta decisão como evidência de análise e tomada de decisão.</small></span></label>
      </div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-decision">Excluir decisão</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar alterações':'Registrar decisão'}</button></div></div></form>
    </div></div>`;
  }

  if (modal && modal.type === 'impediment') {
    const p=currentProject();
    const existing=modal.id ? (p?.impediments||[]).find(i=>i.id===modal.id) : null;
    const i=existing || {title:'',description:'',impact:'',severity:'Medium',status:'Active',nextStep:'',resolution:'',sprintId:null,includeInPortfolio:false};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing?'Editar impedimento':'Novo impedimento'}</h2><p>Registre o bloqueio, impacto e próximo passo para removê-lo.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="impedimentForm" data-impediment-id="${escapeHtml(existing?.id||'')}"><div class="form-grid">
        <div class="field full"><label>Título</label><input name="title" required maxlength="140" value="${escapeHtml(i.title||'')}" placeholder="Ex.: Dependência técnica bloqueando entrega" /></div>
        <div class="field"><label>Severidade</label><select name="severity">${['Critical','High','Medium','Low'].map(v=>`<option ${i.severity===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Sprint relacionada</label><select name="sprintId"><option value="">Projeto geral</option>${(p?.sprints||[]).map(sp=>`<option value="${escapeHtml(sp.id)}" ${i.sprintId===sp.id?'selected':''}>${escapeHtml(sp.name)}</option>`).join('')}</select></div>
        ${textareaField('description','Descrição','O que está bloqueando ou dificultando o trabalho?',i.description)}
        ${textareaField('impact','Impacto','Que impacto este impedimento causa no projeto?',i.impact)}
        ${textareaField('nextStep','Próximo passo','Qual é a próxima ação para remover o bloqueio?',i.nextStep)}
        ${i.status==='Resolved'?textareaField('resolution','Resolução','Como o impedimento foi resolvido?',i.resolution):''}
        <label class="portfolio-check field full"><input type="checkbox" name="includeInPortfolio" ${i.includeInPortfolio?'checked':''} /><span><strong>★ Add to Portfolio</strong><small>Use quando a resolução deste impedimento demonstrar uma competência relevante.</small></span></label>
      </div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-impediment">Excluir impedimento</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar alterações':'Registrar impedimento'}</button></div></div></form>
    </div></div>`;
  }

  if (modal && modal.type === 'resolve-impediment') {
    const p=currentProject(); const i=(p?.impediments||[]).find(x=>x.id===modal.id);
    if(!i) return '';
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-small" onclick="event.stopPropagation()"><div class="modal-head"><div><h2>Resolver impedimento</h2><p>${escapeHtml(i.title)}</p></div><button class="icon-btn" data-action="close-modal">×</button></div><form class="modal-body" id="resolveImpedimentForm" data-impediment-id="${escapeHtml(i.id)}"><div class="field"><label>Como foi resolvido?</label><textarea name="resolution" required placeholder="Registre a solução e o aprendizado gerado.">${escapeHtml(i.resolution||'')}</textarea></div><div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button class="btn btn-primary">Marcar como resolvido</button></div></form></div></div>`;
  }

  if (modal && modal.type === 'evidence') {
    const p=currentProject();
    const existing=modal.id ? (p?.evidence||[]).find(e=>e.id===modal.id) : null;
    const e=existing || {title:'',type:'Result',summary:'',outcome:'',skills:[],reference:'',date:new Date().toISOString().slice(0,10),featured:false};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing?'Editar evidência':'Nova evidência'}</h2><p>Registre um resultado, artefato, feedback ou aprendizado que não nasceu de outro módulo.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="evidenceForm" data-evidence-id="${escapeHtml(existing?.id||'')}"><div class="form-grid">
        <div class="field full"><label>Título</label><input name="title" required maxlength="140" value="${escapeHtml(e.title||'')}" placeholder="Ex.: Redução do tempo de preparação do fluxo" /></div>
        <div class="field"><label>Tipo</label><select name="type">${['Result','Artifact','Feedback','Learning','Milestone','Other'].map(v=>`<option ${e.type===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Data</label><input name="date" type="date" value="${escapeHtml(e.date||'')}" /></div>
        ${textareaField('summary','Context / Evidence','O que aconteceu, foi produzido ou observado?',e.summary)}
        ${textareaField('outcome','Outcome / Learning','Qual resultado, impacto ou aprendizado essa evidência demonstra?',e.outcome)}
        <div class="field full"><label>Competências <span class="field-hint">separadas por vírgula</span></label><input name="skills" maxlength="280" value="${escapeHtml((e.skills||[]).join(', '))}" placeholder="Ex.: Prioritization, Stakeholder Management, Communication" /></div>
        <div class="field full"><label>Referência opcional</label><input name="reference" maxlength="400" value="${escapeHtml(e.reference||'')}" placeholder="Nome de documento, link ou referência para localizar o artefato" /></div>
        <label class="portfolio-check field full"><input type="checkbox" name="featured" ${e.featured?'checked':''} /><span><strong>★ Featured Evidence</strong><small>Destacar esta evidência quando o Portfolio Builder for implementado.</small></span></label>
      </div><div class="form-actions between">${existing?'<button type="button" class="btn btn-danger" data-action="delete-evidence">Excluir evidência</button>':'<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar alterações':'Registrar evidência'}</button></div></div></form>
    </div></div>`;
  }

  if (modal && modal.type === 'case-study') {
    const p=currentProject(); if(!p) return '';
    const d=caseStudyAutoDraft(p); const cs=p.caseStudy||{};
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>Editar Case Study</h2><p>Refine a narrativa profissional de ${escapeHtml(p.name)}. O conteúdo continua salvo localmente.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="caseStudyForm"><div class="form-grid">
        <div class="field full"><label>Título</label><input name="title" maxlength="160" value="${escapeHtml(d.title||'')}" /></div>
        <div class="field"><label>Role</label><input name="role" maxlength="120" value="${escapeHtml(d.role||'')}" placeholder="Ex.: Product / Project Management" /></div>
        <div class="field"><label>Period</label><input name="period" maxlength="100" value="${escapeHtml(d.period||'')}" placeholder="Ex.: Sep 2026 — Nov 2026" /></div>
        <div class="field"><label>Status</label><select name="status"><option ${cs.status!=='Ready'?'selected':''}>Draft</option><option ${cs.status==='Ready'?'selected':''}>Ready</option></select></div>
        <div class="field"></div>
        ${textareaField('challenge','The Challenge','Qual era o problema, contexto ou oportunidade?',d.challenge)}
        ${textareaField('responsibilities','My Responsibilities','Quais responsabilidades você assumiu? Uma por linha funciona muito bem.',d.responsibilities)}
        ${textareaField('approach','Approach & Process','Como o trabalho foi estruturado e conduzido?',d.approach)}
        ${textareaField('results','Results & Impact','Quais resultados, entregas ou impactos foram obtidos?',d.results)}
        ${textareaField('lessons','Lessons Learned','O que mudou na sua forma de trabalhar ou pensar?',d.lessons)}
      </div><div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button class="btn btn-primary">Salvar narrativa</button></div></form>
    </div></div>`;
  }

  if (modal && modal.type === 'story') {
    const p = currentProject();
    const existing = modal.id ? (p?.stories || []).find(s => s.id === modal.id) : null;
    const s = existing || { priority:'Medium', businessValue:3, storyPoints:3, status:'Backlog', epicId:'' };
    return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head"><div><h2>${existing ? `Editar ${escapeHtml(existing.key)}` : 'Nova User Story'}</h2><p>Registre necessidade, contexto, valor e critérios de aceite.</p></div><button class="icon-btn" data-action="close-modal">×</button></div>
      <form class="modal-body" id="storyForm" data-story-id="${escapeHtml(existing?.id || '')}">
        <div class="form-grid">
          <div class="field full"><label>Título</label><input name="title" required maxlength="120" value="${escapeHtml(s.title || '')}" placeholder="Ex.: Priorizar Product Backlog" /></div>
          <div class="field"><label>Epic</label><select name="epicId"><option value="">No Epic</option>${(p?.epics||[]).map(e=>`<option value="${escapeHtml(e.id)}" ${s.epicId===e.id?'selected':''}>${escapeHtml(e.title)}</option>`).join('')}</select></div>
          <div class="field"><label>Status</label><select name="status">${['Backlog','Ready','In Progress','Review','Done'].map(v=>`<option ${s.status===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label>Prioridade</label><select name="priority">${['Critical','High','Medium','Low'].map(v=>`<option ${s.priority===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label>Story Points</label><select name="storyPoints">${[1,2,3,5,8,13].map(v=>`<option ${Number(s.storyPoints)===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label>Business Value</label><select name="businessValue">${[1,2,3,4,5].map(v=>`<option ${Number(s.businessValue)===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="field full"><label>As a…</label><input name="asA" maxlength="160" value="${escapeHtml(s.asA || '')}" placeholder="Como usuária / Como Product Owner…" /></div>
          <div class="field full"><label>I want…</label><input name="iWant" maxlength="220" value="${escapeHtml(s.iWant || '')}" placeholder="quero…" /></div>
          <div class="field full"><label>So that…</label><input name="soThat" maxlength="220" value="${escapeHtml(s.soThat || '')}" placeholder="para que…" /></div>
          <div class="field full"><label>Acceptance Criteria</label><textarea name="acceptanceCriteria" placeholder="Critérios objetivos para considerar esta Story concluída.">${escapeHtml(s.acceptanceCriteria || '')}</textarea></div>
        </div>
        <div class="form-actions between">${existing ? '<button type="button" class="btn btn-danger" data-action="delete-story">Excluir Story</button>' : '<span></span>'}<div><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button> <button class="btn btn-primary">${existing?'Salvar alterações':'Criar Story'}</button></div></div>
      </form>
    </div></div>`;
  }
  return '';
}

function textareaField(name,label,placeholder,value='') {
  return `<div class="field full"><label>${label}</label><textarea name="${name}" placeholder="${placeholder}">${escapeHtml(value)}</textarea></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-action="open-help"]').forEach(btn=>btn.addEventListener('click',()=>{ modal='help'; render(); }));
  document.querySelectorAll('[data-action="onboarding-finish"]').forEach(btn=>btn.addEventListener('click',()=>{
    state.preferences.onboardingCompleted=true; state.preferences.lastSeenVersion=APP_VERSION; saveState(); modal=null; render(); showToast('AgileFlow pronto para uso.');
  }));
  document.querySelectorAll('[data-action="onboarding-demo"]').forEach(btn=>btn.addEventListener('click',()=>{
    state.preferences.onboardingCompleted=true; state.preferences.lastSeenVersion=APP_VERSION; createDemoProject(); modal=null; activeView='dashboard'; render(); showToast('Projeto-demo criado. Você pode excluí-lo depois.');
  }));
  document.querySelectorAll('[data-action="restart-onboarding"]').forEach(btn=>btn.addEventListener('click',()=>{ state.preferences.onboardingCompleted=false; saveState(); modal='onboarding'; render(); }));
  document.querySelectorAll('[data-action="add-demo-project"]').forEach(btn=>btn.addEventListener('click',()=>{ createDemoProject(); activeView='dashboard'; render(); showToast('Projeto-demo disponível.'); }));
  document.querySelectorAll('[data-action="copy-local-path"]').forEach(btn=>btn.addEventListener('click',async()=>{
    const value=bridgeStatus.root || 'Documents/AgileFlow';
    try { await navigator.clipboard.writeText(value); showToast('Caminho da pasta copiado.'); }
    catch { showToast(value); }
  }));
  document.querySelectorAll('[data-action="backup-now"]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(bridgeStatus.connected && bridgeStatus.paired){
      try { const result=await bridgeCreateBackup(); state.preferences.lastBackupAt=new Date().toISOString(); addActivity('Backup local criado', result?.file || 'Backup salvo pelo Local Bridge.', state.currentProjectId); saveState(); render(); showToast('Backup local criado.'); }
      catch(error){ console.error(error); exportWorkspaceBackup(); }
    } else exportWorkspaceBackup();
  }));
  document.getElementById('settingsForm')?.addEventListener('submit',e=>{
    e.preventDefault(); const fd=new FormData(e.currentTarget);
    state.profile.name=String(fd.get('profileName')||'Rachel').trim() || 'Rachel';
    state.preferences.theme=String(fd.get('theme')||'light')==='dark'?'dark':'light';
    state.preferences.backupReminderDays=Number(fd.get('backupReminderDays')||0);
    saveState(); render(); showToast('Preferências salvas.');
  });
  document.querySelectorAll('[data-action="conflict-use-browser"]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!startupConflict) return;
    state=normalizeState(startupConflict.local); state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true;
    const ok=await bridgeWriteState(state); state.preferences.lastBridgeSyncAt=new Date().toISOString(); persistenceAdapter.writeSync(JSON.stringify(state));
    syncConflictActive=false; startupConflict=null; modal=state.preferences.onboardingCompleted?null:'onboarding';
    setSyncState(ok?'saved':'offline', ok?'Cópia do navegador gravada em Documents/AgileFlow.':'Cópia do navegador preservada; Bridge indisponível.', {pending:!ok,at:state.preferences.lastBridgeSyncAt}); render(); showToast('Cópia do navegador selecionada.');
  }));
  document.querySelectorAll('[data-action="conflict-use-local"]').forEach(btn=>btn.addEventListener('click',()=>{
    if(!startupConflict) return;
    state=normalizeState(startupConflict.remote); state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true; state.preferences.lastBridgeSyncAt=startupConflict.remoteSavedAt||new Date().toISOString(); persistenceAdapter.writeSync(JSON.stringify(state));
    syncConflictActive=false; startupConflict=null; modal=state.preferences.onboardingCompleted?null:'onboarding'; setSyncState('saved','Cópia de Documents/AgileFlow carregada.',{pending:false,at:state.preferences.lastBridgeSyncAt}); render(); showToast('Cópia local selecionada.');
  }));
  document.querySelectorAll('[data-action="conflict-backup-newer"]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!startupConflict) return;
    try { await bridgeCreateBackup(); } catch(error) { console.warn('Backup local antes do conflito:', error); }
    downloadTextFile(`agileflow-browser-conflict-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({format:'agileflow-workspace-backup',formatVersion:1,agileFlowVersion:APP_VERSION,exportedAt:new Date().toISOString(),state:startupConflict.local},null,2),'application/json;charset=utf-8');
    const useBrowser=startupConflict.localTs>=startupConflict.remoteTs;
    if(useBrowser){ state=normalizeState(startupConflict.local); state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true; await bridgeWriteState(state); state.preferences.lastBridgeSyncAt=new Date().toISOString(); }
    else { state=normalizeState(startupConflict.remote); state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true; state.preferences.lastBridgeSyncAt=startupConflict.remoteSavedAt||new Date().toISOString(); }
    state.preferences.lastBackupAt=new Date().toISOString(); persistenceAdapter.writeSync(JSON.stringify(state)); syncConflictActive=false; startupConflict=null; modal=state.preferences.onboardingCompleted?null:'onboarding'; setSyncState('saved','Conflito resolvido após criar backups das cópias.',{pending:false,at:state.preferences.lastBridgeSyncAt}); render(); showToast('Backup criado e versão mais recente mantida.');
  }));
  document.querySelectorAll('[data-action="export-workspace"]').forEach(btn=>btn.addEventListener('click',exportWorkspaceBackup));
  document.querySelectorAll('[data-action="export-project"]').forEach(btn=>btn.addEventListener('click',exportCurrentProject));
  document.querySelectorAll('[data-action="choose-workspace-import"]').forEach(btn=>btn.addEventListener('click',()=>document.getElementById('workspaceImportFile')?.click()));
  document.querySelectorAll('[data-action="choose-project-import"]').forEach(btn=>btn.addEventListener('click',()=>document.getElementById('projectImportFile')?.click()));
  document.getElementById('workspaceImportFile')?.addEventListener('change',e=>{ const file=e.target.files?.[0]; if(file) importWorkspaceBackup(file); });
  document.getElementById('projectImportFile')?.addEventListener('change',e=>{ const file=e.target.files?.[0]; if(file) importProjectFile(file); });
  document.querySelectorAll('[data-action="bridge-detect"]').forEach(btn=>btn.addEventListener('click',()=>detectBridge()));
  document.querySelectorAll('[data-action="bridge-enable-mirror"]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!bridgeStatus.connected || !bridgeStatus.paired){ await detectBridge(); if(!bridgeStatus.connected){ showToast('Local Bridge não detectado.'); return; } }
    state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true;
    state.meta = state.meta || {}; state.meta.lastSavedAt = new Date().toISOString();
    const ok=await bridgeWriteState(state);
    if(ok){
      state.preferences.lastBridgeSyncAt=new Date().toISOString();
      persistenceAdapter.writeSync(JSON.stringify(state)); setSyncState('saved','Modo Local-first ativado. Workspace salvo em Documents/AgileFlow.',{pending:false,at:state.preferences.lastBridgeSyncAt}); render(); showToast('Modo Local-first ativado e sincronizado.');
    } else {
      state.preferences.bridgePrimaryEnabled=false; state.preferences.bridgeMirrorEnabled=false;
      persistenceAdapter.writeSync(JSON.stringify(state)); setSyncState('browser','Não foi possível ativar Local-first. O workspace continua salvo no navegador.',{pending:false,at:state.meta?.lastSavedAt}); showToast('Não foi possível gravar no Local Bridge.');
    }
  }));
  document.querySelectorAll('[data-action="bridge-disable-mirror"]').forEach(btn=>btn.addEventListener('click',()=>{
    state.preferences.bridgePrimaryEnabled=false; state.preferences.bridgeMirrorEnabled=false; persistenceAdapter.writeSync(JSON.stringify(state)); setSyncState('browser','Workspace salvo somente neste navegador.',{pending:false,at:state.meta?.lastSavedAt}); render(); showToast('Agora o AgileFlow usa somente o armazenamento do navegador.');
  }));
  document.querySelectorAll('[data-action="bridge-load"]').forEach(btn=>btn.addEventListener('click',async()=>{
    try {
      const remote=await bridgeReadWorkspace(); const candidate=remote.state;
      if(!candidate || !Array.isArray(candidate.projects)) throw new Error('Workspace local inválido');
      if(!confirm(`Recarregar o workspace a partir dos arquivos locais com ${candidate.projects.length} projeto(s)? O cache atual deste navegador será substituído.`)) return;
      state=normalizeState(candidate); state.preferences.bridgePrimaryEnabled=true; state.preferences.bridgeMirrorEnabled=true; state.preferences.lastBridgeSyncAt=remote.savedAt||new Date().toISOString();
      persistenceAdapter.writeSync(JSON.stringify(state)); setSyncState('saved','Workspace recarregado de Documents/AgileFlow.',{pending:false,at:state.preferences.lastBridgeSyncAt}); activeView='dashboard'; render(); showToast('Workspace recarregado dos arquivos locais.');
    } catch(error){ console.error(error); showToast(error.message || 'Não foi possível carregar os dados locais.'); }
  }));
  document.querySelectorAll('[data-action="bridge-backup"]').forEach(btn=>btn.addEventListener('click',async()=>{
    try { const result=await bridgeCreateBackup(); state.preferences.lastBackupAt=new Date().toISOString(); addActivity('Backup local criado',result?.file || 'Backup salvo pelo Local Bridge.',state.currentProjectId); saveState(); render(); showToast(result?.file ? `Backup local criado: ${result.file}` : 'Backup local criado.'); }
    catch(error){ console.error(error); showToast('Não foi possível criar o backup local.'); }
  }));
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => {
    activeView = btn.dataset.view;
    document.getElementById('sidebar')?.classList.remove('open');
    render();
  }));
  document.querySelectorAll('[data-action="new-project"]').forEach(btn => btn.addEventListener('click', () => { modal='new-project'; render(); }));

  document.querySelectorAll('[data-action="new-goal"]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'goal',id:null}; render(); }));
  document.querySelectorAll('[data-edit-goal]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'goal',id:btn.dataset.editGoal}; render(); }));
  document.querySelectorAll('[data-action="new-milestone"]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'milestone',id:null}; render(); }));
  document.querySelectorAll('[data-edit-milestone]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'milestone',id:btn.dataset.editMilestone}; render(); }));
  document.querySelectorAll('[data-complete-milestone]').forEach(btn=>btn.addEventListener('click',()=>completeMilestone(btn.dataset.completeMilestone)));
  document.querySelectorAll('[data-toggle-milestone-portfolio]').forEach(btn=>btn.addEventListener('click',()=>toggleMilestonePortfolio(btn.dataset.toggleMilestonePortfolio)));
  document.querySelectorAll('[data-action="new-risk"]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'risk',id:null}; render(); }));
  document.querySelectorAll('[data-edit-risk]').forEach(btn=>btn.addEventListener('click',()=>{ modal={type:'risk',id:btn.dataset.editRisk}; render(); }));
  document.querySelectorAll('[data-toggle-risk-portfolio]').forEach(btn=>btn.addEventListener('click',()=>toggleRiskPortfolio(btn.dataset.toggleRiskPortfolio)));
  const projectWizardForm = document.getElementById('newProjectForm');
  if (projectWizardForm) {
    const refreshTemplatePreview = () => {
      const selected = projectWizardForm.querySelector('input[name="method"]:checked')?.value || 'Hybrid';
      const cfg = PROJECT_TEMPLATES[normalizeTemplate(selected)];
      const target = document.getElementById('templatePreview');
      if (!target || !cfg) return;
      target.innerHTML = `<div><strong>${escapeHtml(cfg.icon)} ${escapeHtml(cfg.title)}</strong><span>${escapeHtml(cfg.bestFor)}</span></div><div class="template-preview-modules">${templateModuleNames(cfg.key).map(label=>`<span>${escapeHtml(label)}</span>`).join('')}</div>`;
    };
    projectWizardForm.querySelectorAll('input[name="method"]').forEach(input => input.addEventListener('change', refreshTemplatePreview));
    refreshTemplatePreview();
  }
  document.querySelectorAll('[data-action="edit-vision"]').forEach(btn => btn.addEventListener('click', () => { modal='edit-vision'; render(); }));
  document.querySelectorAll('[data-action="new-epic"]').forEach(btn => btn.addEventListener('click', () => { modal='new-epic'; render(); }));
  document.querySelectorAll('[data-action="new-story"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'story',id:null}; render(); }));
  document.querySelectorAll('[data-action="new-sprint"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'sprint',id:null}; render(); }));
  document.querySelectorAll('[data-action="new-retro"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'retro',id:null,sprintId:null}; render(); }));
  document.querySelectorAll('[data-action="new-decision"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'decision',id:null}; render(); }));
  document.querySelectorAll('[data-edit-decision]').forEach(btn => btn.addEventListener('click', () => { modal={type:'decision',id:btn.dataset.editDecision}; render(); }));
  document.querySelectorAll('[data-toggle-decision-portfolio]').forEach(btn => btn.addEventListener('click', () => toggleDecisionPortfolio(btn.dataset.toggleDecisionPortfolio)));
  document.querySelectorAll('[data-action="new-impediment"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'impediment',id:null}; render(); }));
  document.querySelectorAll('[data-edit-impediment]').forEach(btn => btn.addEventListener('click', () => { modal={type:'impediment',id:btn.dataset.editImpediment}; render(); }));
  document.querySelectorAll('[data-resolve-impediment]').forEach(btn => btn.addEventListener('click', () => { modal={type:'resolve-impediment',id:btn.dataset.resolveImpediment}; render(); }));
  document.querySelectorAll('[data-toggle-impediment-portfolio]').forEach(btn => btn.addEventListener('click', () => toggleImpedimentPortfolio(btn.dataset.toggleImpedimentPortfolio)));
  document.querySelectorAll('[data-action="new-evidence"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'evidence',id:null}; render(); }));
  document.querySelectorAll('[data-edit-evidence]').forEach(btn => btn.addEventListener('click', () => { modal={type:'evidence',id:btn.dataset.editEvidence}; render(); }));
  document.querySelectorAll('[data-remove-evidence]').forEach(btn => btn.addEventListener('click', () => removeGeneratedEvidence(btn.dataset.removeEvidence)));
  document.querySelectorAll('[data-case-project]').forEach(btn => btn.addEventListener('click', () => { state.currentProjectId=btn.dataset.caseProject; saveState(); activeView='caseStudy'; render(); }));
  document.querySelectorAll('[data-action="edit-case-study"]').forEach(btn => btn.addEventListener('click', () => { modal={type:'case-study'}; render(); }));
  document.querySelectorAll('[data-action="case-autofill"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p) return; const generated=caseStudyAutoDraft(p); p.caseStudy={...p.caseStudy,...generated}; touchProject(p); addActivity('Case Study atualizado','Rascunho narrativo gerado a partir dos dados do projeto.',p.id); saveState(); render(); showToast('Rascunho do Case Study atualizado.');
  }));
  document.querySelectorAll('[data-case-evidence]').forEach(box => box.addEventListener('change', e => {
    const p=currentProject(); if(!p) return; const all=collectPortfolioEvidence(p); let ids=[...(p.caseStudy?.selectedEvidence||[])];
    if(!ids.length) ids=caseStudySelectedEvidence(p).map(item=>item.id);
    const id=e.currentTarget.dataset.caseEvidence; ids=e.currentTarget.checked ? [...new Set([...ids,id])] : ids.filter(x=>x!==id);
    p.caseStudy.selectedEvidence=ids; touchProject(p); saveState(); render();
  }));
  document.querySelectorAll('[data-action="case-export-json"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p) return; downloadTextFile(`${slugify(p.name)}-case-study.json`,JSON.stringify(buildCaseStudyExport(p),null,2),'application/json;charset=utf-8'); showToast('Case Study exportado em JSON.');
  }));
  document.querySelectorAll('[data-action="case-export-md"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p) return; downloadTextFile(`${slugify(p.name)}-case-study.md`,caseStudyMarkdown(p),'text/markdown;charset=utf-8'); showToast('Case Study exportado em Markdown.');
  }));
  document.querySelectorAll('[data-action="case-print"]').forEach(btn => btn.addEventListener('click', () => { document.body.classList.add('printing-case-study'); setTimeout(()=>window.print(),50); setTimeout(()=>document.body.classList.remove('printing-case-study'),700); }));
  document.querySelectorAll('[data-retro-sprint]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); const sprintId=btn.dataset.retroSprint; const existing=(p?.retrospectives||[]).find(r=>r.sprintId===sprintId);
    modal={type:'retro',id:existing?.id || null,sprintId:existing ? null : sprintId}; render();
  }));
  document.querySelectorAll('[data-edit-retro]').forEach(btn => btn.addEventListener('click', () => { modal={type:'retro',id:btn.dataset.editRetro}; render(); }));
  document.querySelectorAll('[data-toggle-retro-portfolio]').forEach(btn => btn.addEventListener('click', () => toggleRetroPortfolio(btn.dataset.toggleRetroPortfolio)));
  document.querySelectorAll('[data-toggle-action]').forEach(btn => btn.addEventListener('click', () => toggleActionItem(btn.dataset.toggleAction)));
  document.querySelectorAll('[data-edit-sprint]').forEach(btn => btn.addEventListener('click', () => { modal={type:'sprint',id:btn.dataset.editSprint}; render(); }));
  document.querySelectorAll('[data-start-sprint]').forEach(btn => btn.addEventListener('click', () => startSprint(btn.dataset.startSprint)));
  document.querySelectorAll('[data-complete-sprint]').forEach(btn => btn.addEventListener('click', () => completeSprint(btn.dataset.completeSprint)));
  document.querySelectorAll('[data-edit-story]').forEach(btn => btn.addEventListener('click', () => { modal={type:'story',id:btn.dataset.editStory}; render(); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach(btn => btn.addEventListener('click', () => { modal=null; render(); }));
  document.querySelectorAll('[data-open-project]').forEach(btn => btn.addEventListener('click', () => {
    state.currentProjectId = btn.dataset.openProject; saveState(); activeView='dashboard'; render(); showToast('Projeto aberto.');
  }));
  document.querySelectorAll('[data-portfolio-project]').forEach(btn => btn.addEventListener('click', () => {
    state.currentProjectId = btn.dataset.portfolioProject; saveState(); activeView='evidence'; render(); showToast('Evidence Hub do projeto aberto.');
  }));
  document.querySelectorAll('[data-portfolio-skill]').forEach(btn => btn.addEventListener('click', () => {
    portfolioFilters.skill = btn.dataset.portfolioSkill; activeView='portfolio'; render();
  }));
  document.getElementById('projectSelect')?.addEventListener('change', e => { state.currentProjectId=e.target.value; const p=currentProject(); if(p && !projectModuleEnabled(p,activeView)) activeView='dashboard'; saveState(); render(); });
  document.getElementById('menuBtn')?.addEventListener('click', () => document.getElementById('sidebar')?.classList.toggle('open'));

  document.getElementById('themeToggle')?.addEventListener('click', () => {
    state.preferences.theme = state.preferences.theme === 'dark' ? 'light' : 'dark';
    saveState();
    render();
  });

  const boardSearch = document.getElementById('boardSearch');
  boardSearch?.addEventListener('input', e => {
    boardFilters.search = e.target.value;
    render();
    requestAnimationFrame(()=>{const el=document.getElementById('boardSearch'); if(el){el.focus(); el.setSelectionRange(el.value.length,el.value.length);}});
  });
  document.getElementById('boardEpicFilter')?.addEventListener('change', e => { boardFilters.epic=e.target.value; render(); });
  document.querySelectorAll('[data-board-status]').forEach(select => select.addEventListener('change', e => moveStory(e.currentTarget.dataset.boardStatus, e.currentTarget.value)));
  document.querySelectorAll('[data-drag-story]').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', e.currentTarget.dataset.dragStory);
      e.currentTarget.classList.add('dragging');
    });
    card.addEventListener('dragend', e => e.currentTarget.classList.remove('dragging'));
  });
  document.querySelectorAll('[data-drop-status]').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const storyId = e.dataTransfer.getData('text/plain');
      moveStory(storyId, zone.dataset.dropStatus);
    });
  });

  const search = document.getElementById('backlogSearch');
  search?.addEventListener('input', e => { backlogFilters.search = e.target.value; render(); requestAnimationFrame(()=>{const el=document.getElementById('backlogSearch'); if(el){el.focus(); el.setSelectionRange(el.value.length,el.value.length);}}); });
  document.getElementById('filterStatus')?.addEventListener('change', e => { backlogFilters.status=e.target.value; render(); });
  document.getElementById('filterPriority')?.addEventListener('change', e => { backlogFilters.priority=e.target.value; render(); });
  document.getElementById('filterEpic')?.addEventListener('change', e => { backlogFilters.epic=e.target.value; render(); });
  const evidenceSearch=document.getElementById('evidenceSearch');
  evidenceSearch?.addEventListener('input', e => { evidenceFilters.search=e.target.value; render(); requestAnimationFrame(()=>{const el=document.getElementById('evidenceSearch'); if(el){el.focus(); el.setSelectionRange(el.value.length,el.value.length);}}); });
  document.getElementById('evidenceSourceFilter')?.addEventListener('change', e => { evidenceFilters.source=e.target.value; render(); });
  const portfolioSearch=document.getElementById('portfolioSearch');
  portfolioSearch?.addEventListener('input', e => { portfolioFilters.search=e.target.value; render(); requestAnimationFrame(()=>{const el=document.getElementById('portfolioSearch'); if(el){el.focus(); el.setSelectionRange(el.value.length,el.value.length);}}); });
  document.getElementById('portfolioProjectFilter')?.addEventListener('change', e => { portfolioFilters.project=e.target.value; render(); });
  document.getElementById('portfolioSkillFilter')?.addEventListener('change', e => { portfolioFilters.skill=e.target.value; render(); });
  document.getElementById('growthProjectFilter')?.addEventListener('change', e => { growthFilters.project=e.target.value; render(); });
  document.getElementById('growthSkillFilter')?.addEventListener('change', e => { growthFilters.skill=e.target.value; render(); });
  document.getElementById('growthYearFilter')?.addEventListener('change', e => { growthFilters.year=e.target.value; render(); });
  document.querySelectorAll('[data-growth-skill]').forEach(btn=>btn.addEventListener('click',()=>{ growthFilters.skill=btn.dataset.growthSkill; activeView='growth'; render(); }));
  document.querySelectorAll('[data-growth-project]').forEach(btn=>btn.addEventListener('click',()=>{ state.currentProjectId=btn.dataset.growthProject; saveState(); activeView='evidence'; render(); showToast('Evidence Hub do projeto aberto.'); }));

  document.getElementById('newProjectForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name') || '').trim(); if (!name) return;
    const now = new Date().toISOString();
    const id = `${slugify(name)}-${Date.now().toString(36)}`;
    const template = normalizeTemplate(String(fd.get('method') || 'Hybrid'));
    const challenge = String(fd.get('challenge')||'').trim();
    const goal = String(fd.get('goal')||'').trim();
    const stakeholders = String(fd.get('stakeholders')||'').trim();
    const deadline = String(fd.get('deadline')||'').trim();
    const successCriteria = String(fd.get('successCriteria')||'').trim();
    const constraints = String(fd.get('constraints')||'').trim();
    const project = {
      id, keyPrefix:derivePrefix(name), storyCounter:0, name,
      description:String(fd.get('description')||'').trim(),
      method:template, template,
      setup:{challenge,goal,stakeholders,deadline,successCriteria},
      status:String(fd.get('status')||'Planning'), progress:0,
      createdAt:now, updatedAt:now,
      vision:{ problem:challenge, vision:'', objectives:goal, successCriteria, constraints },
      goals:[], milestones:[], risks:[], epics:[], stories:[], sprints:[], retrospectives:[], decisions:[], impediments:[], evidence:[]
    };
    state.projects.push(project);
    state.currentProjectId = id;
    addActivity('Projeto criado', `${name} foi criado com o template ${template}.`, id);
    saveState(); modal=null; activeView='vision'; render();
    showToast(`${template} configurado. Revise a Product Vision para começar.`);
  });

  document.getElementById('goalForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return; const fd=new FormData(e.currentTarget); const title=String(fd.get('title')||'').trim(); if(!title) return; const id=e.currentTarget.dataset.id; const now=new Date().toISOString(); let item=id?p.goals.find(x=>x.id===id):null; if(!item){item={id:uid(),createdAt:now};p.goals.push(item);} Object.assign(item,{title,description:String(fd.get('description')||'').trim(),status:String(fd.get('status')||'Planned'),targetDate:String(fd.get('targetDate')||''),successMeasure:String(fd.get('successMeasure')||'').trim(),updatedAt:now}); touchProject(p); addActivity(id?'Goal atualizado':'Goal criado',title,p.id); saveState(); modal=null; render(); showToast(id?'Goal atualizado.':'Goal criado.');
  });
  document.querySelectorAll('[data-action="delete-goal"]').forEach(btn=>btn.addEventListener('click',()=>{const p=currentProject();const id=modal?.id;const item=p?.goals?.find(x=>x.id===id);if(!p||!item)return;if(!confirm(`Excluir o goal “${item.title}”?`))return;p.goals=p.goals.filter(x=>x.id!==id);p.milestones.forEach(m=>{if(m.goalId===id)m.goalId=null;});touchProject(p);saveState();modal=null;render();showToast('Goal excluído.');}));
  document.getElementById('milestoneForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return; const fd=new FormData(e.currentTarget); const title=String(fd.get('title')||'').trim(); if(!title)return; const id=e.currentTarget.dataset.id; const now=new Date().toISOString(); let item=id?p.milestones.find(x=>x.id===id):null; if(!item){item={id:uid(),createdAt:now};p.milestones.push(item);} const status=String(fd.get('status')||'Upcoming'); Object.assign(item,{title,description:String(fd.get('description')||'').trim(),status,dueDate:String(fd.get('dueDate')||''),goalId:String(fd.get('goalId')||'')||null,includeInPortfolio:fd.get('includeInPortfolio')==='on',updatedAt:now,completedAt:status==='Completed'?(item.completedAt||now):null});touchProject(p);addActivity(id?'Milestone atualizado':'Milestone criado',title,p.id);saveState();modal=null;render();showToast(id?'Milestone atualizado.':'Milestone criado.');
  });
  document.querySelectorAll('[data-action="delete-milestone"]').forEach(btn=>btn.addEventListener('click',()=>{const p=currentProject();const id=modal?.id;const item=p?.milestones?.find(x=>x.id===id);if(!p||!item)return;if(!confirm(`Excluir o milestone “${item.title}”?`))return;p.milestones=p.milestones.filter(x=>x.id!==id);touchProject(p);saveState();modal=null;render();showToast('Milestone excluído.');}));
  document.getElementById('riskForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p)return; const fd=new FormData(e.currentTarget); const title=String(fd.get('title')||'').trim(); if(!title)return; const id=e.currentTarget.dataset.id; const now=new Date().toISOString(); let item=id?p.risks.find(x=>x.id===id):null; if(!item){item={id:uid(),createdAt:now};p.risks.push(item);} const status=String(fd.get('status')||'Open'); Object.assign(item,{title,description:String(fd.get('description')||'').trim(),probability:String(fd.get('probability')||'Medium'),impact:String(fd.get('impact')||'Medium'),response:String(fd.get('response')||'Reduce'),mitigation:String(fd.get('mitigation')||'').trim(),status,includeInPortfolio:fd.get('includeInPortfolio')==='on',updatedAt:now,closedAt:status==='Closed'?(item.closedAt||now):null});touchProject(p);addActivity(id?'Risk atualizado':'Risk registrado',`${title} • ${riskLevel(item)} exposure`,p.id);saveState();modal=null;render();showToast(id?'Risk atualizado.':'Risk registrado.');
  });
  document.querySelectorAll('[data-action="delete-risk"]').forEach(btn=>btn.addEventListener('click',()=>{const p=currentProject();const id=modal?.id;const item=p?.risks?.find(x=>x.id===id);if(!p||!item)return;if(!confirm(`Excluir o risk “${item.title}”?`))return;p.risks=p.risks.filter(x=>x.id!==id);touchProject(p);saveState();modal=null;render();showToast('Risk excluído.');}));

  document.getElementById('visionForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget);
    p.vision={ problem:String(fd.get('problem')||'').trim(), vision:String(fd.get('vision')||'').trim(), objectives:String(fd.get('objectives')||'').trim(), successCriteria:String(fd.get('successCriteria')||'').trim(), constraints:String(fd.get('constraints')||'').trim() };
    touchProject(p); addActivity('Product Vision atualizada', `A visão de ${p.name} foi revisada.`, p.id); saveState(); modal=null; render(); showToast('Product Vision salva.');
  });

  document.getElementById('epicForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd = new FormData(e.currentTarget); const title=String(fd.get('title')||'').trim(); if(!title) return;
    p.epics.push({id:uid(), title, description:String(fd.get('description')||'').trim(), createdAt:new Date().toISOString()});
    touchProject(p); addActivity('Epic criado', `${title} foi adicionado ao backlog.`, p.id); saveState(); modal=null; render(); showToast('Epic criado.');
  });


  document.getElementById('retroForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget); const retroId=e.currentTarget.dataset.retroId; const now=new Date().toISOString();
    const sprintId=String(fd.get('sprintId')||'') || null;
    if (sprintId) {
      const duplicate=(p.retrospectives||[]).find(r=>r.sprintId===sprintId && r.id!==retroId);
      if (duplicate) { showToast('Esta Sprint já possui uma retrospectiva.'); return; }
    }
    let retro=retroId ? (p.retrospectives||[]).find(r=>r.id===retroId) : null;
    if (!retro) { retro={id:uid(),createdAt:now,actionItems:[]}; p.retrospectives.push(retro); }
    const previousByText=new Map((retro.actionItems||[]).map(item=>[item.text.trim(),item]));
    const actionTexts=String(fd.get('actionItems')||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    const actionItems=actionTexts.map(text=> previousByText.get(text) || {id:uid(),text,status:'Open',createdAt:now,completedAt:null});
    Object.assign(retro,{
      sprintId,
      title:String(fd.get('title')||'').trim(),
      wentWell:String(fd.get('wentWell')||'').trim(),
      didntGoWell:String(fd.get('didntGoWell')||'').trim(),
      learned:String(fd.get('learned')||'').trim(),
      changeNext:String(fd.get('changeNext')||'').trim(),
      includeInPortfolio:fd.get('includeInPortfolio')==='on',
      actionItems,
      updatedAt:now
    });
    const sprint=sprintId ? (p.sprints||[]).find(s=>s.id===sprintId) : null;
    touchProject(p); addActivity(retroId?'Retrospectiva atualizada':'Retrospectiva registrada', `${retro.title || sprint?.name || 'Retrospectiva geral'} • ${actionItems.length} Action Item(s)`, p.id); saveState(); modal=null; render(); showToast(retroId?'Retrospectiva atualizada.':'Retrospectiva registrada.');
  });

  document.querySelectorAll('[data-action="delete-retro"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p || !modal?.id) return;
    const retro=(p.retrospectives||[]).find(r=>r.id===modal.id); if(!retro) return;
    if(!confirm('Excluir esta retrospectiva e seus Action Items?')) return;
    p.retrospectives=p.retrospectives.filter(r=>r.id!==retro.id); touchProject(p); addActivity('Retrospectiva excluída', retro.title || 'Registro removido.', p.id); saveState(); modal=null; render(); showToast('Retrospectiva excluída.');
  }));

  document.getElementById('decisionForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget); const id=e.currentTarget.dataset.decisionId; const now=new Date().toISOString();
    let item=id ? (p.decisions||[]).find(d=>d.id===id) : null;
    if(!item){ item={id:uid(),createdAt:now}; p.decisions.push(item); }
    Object.assign(item,{title:String(fd.get('title')||'').trim(),context:String(fd.get('context')||'').trim(),alternatives:String(fd.get('alternatives')||'').trim(),decision:String(fd.get('decision')||'').trim(),reason:String(fd.get('reason')||'').trim(),impact:String(fd.get('impact')||'').trim(),sprintId:String(fd.get('sprintId')||'')||null,includeInPortfolio:fd.get('includeInPortfolio')==='on',updatedAt:now});
    touchProject(p); addActivity(id?'Decisão atualizada':'Decisão registrada',item.title,p.id); saveState(); modal=null; render(); showToast(id?'Decisão atualizada.':'Decisão registrada.');
  });
  document.querySelectorAll('[data-action="delete-decision"]').forEach(btn=>btn.addEventListener('click',()=>{
    const p=currentProject(); if(!p||!modal?.id) return; const item=(p.decisions||[]).find(d=>d.id===modal.id); if(!item) return;
    if(!confirm(`Excluir a decisão “${item.title}”?`)) return; p.decisions=p.decisions.filter(d=>d.id!==item.id); touchProject(p); addActivity('Decisão excluída',item.title,p.id); saveState(); modal=null; render(); showToast('Decisão excluída.');
  }));

  document.getElementById('impedimentForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget); const id=e.currentTarget.dataset.impedimentId; const now=new Date().toISOString();
    let item=id ? (p.impediments||[]).find(i=>i.id===id) : null;
    if(!item){ item={id:uid(),status:'Active',createdAt:now,resolvedAt:null}; p.impediments.push(item); }
    Object.assign(item,{title:String(fd.get('title')||'').trim(),description:String(fd.get('description')||'').trim(),impact:String(fd.get('impact')||'').trim(),severity:String(fd.get('severity')||'Medium'),nextStep:String(fd.get('nextStep')||'').trim(),sprintId:String(fd.get('sprintId')||'')||null,includeInPortfolio:fd.get('includeInPortfolio')==='on',updatedAt:now});
    if(item.status==='Resolved' && fd.has('resolution')) item.resolution=String(fd.get('resolution')||'').trim();
    touchProject(p); addActivity(id?'Impedimento atualizado':'Impedimento registrado',item.title,p.id); saveState(); modal=null; render(); showToast(id?'Impedimento atualizado.':'Impedimento registrado.');
  });
  document.getElementById('resolveImpedimentForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return; const id=e.currentTarget.dataset.impedimentId; const item=(p.impediments||[]).find(i=>i.id===id); if(!item) return;
    const fd=new FormData(e.currentTarget); item.resolution=String(fd.get('resolution')||'').trim(); if(!item.resolution) return; item.status='Resolved'; item.resolvedAt=new Date().toISOString(); item.updatedAt=item.resolvedAt; touchProject(p); addActivity('Impedimento resolvido',item.title,p.id); saveState(); modal=null; render(); showToast('Impedimento resolvido.');
  });
  document.querySelectorAll('[data-action="delete-impediment"]').forEach(btn=>btn.addEventListener('click',()=>{
    const p=currentProject(); if(!p||!modal?.id) return; const item=(p.impediments||[]).find(i=>i.id===modal.id); if(!item) return;
    if(!confirm(`Excluir o impedimento “${item.title}”?`)) return; p.impediments=p.impediments.filter(i=>i.id!==item.id); touchProject(p); addActivity('Impedimento excluído',item.title,p.id); saveState(); modal=null; render(); showToast('Impedimento excluído.');
  }));

  document.getElementById('evidenceForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget); const id=e.currentTarget.dataset.evidenceId; const now=new Date().toISOString();
    const title=String(fd.get('title')||'').trim(); if(!title) return;
    let item=id ? (p.evidence||[]).find(x=>x.id===id) : null;
    if(!item){ item={id:uid(),createdAt:now}; p.evidence.push(item); }
    Object.assign(item,{title,type:String(fd.get('type')||'Other'),summary:String(fd.get('summary')||'').trim(),outcome:String(fd.get('outcome')||'').trim(),skills:String(fd.get('skills')||'').split(',').map(v=>v.trim()).filter(Boolean),reference:String(fd.get('reference')||'').trim(),date:String(fd.get('date')||''),featured:fd.get('featured')==='on',updatedAt:now});
    touchProject(p); addActivity(id?'Evidência atualizada':'Evidência registrada',item.title,p.id); saveState(); modal=null; render(); showToast(id?'Evidência atualizada.':'Evidência adicionada ao Evidence Hub.');
  });
  document.querySelectorAll('[data-action="delete-evidence"]').forEach(btn=>btn.addEventListener('click',()=>{
    const p=currentProject(); if(!p||!modal?.id) return; const item=(p.evidence||[]).find(e=>e.id===modal.id); if(!item) return;
    if(!confirm(`Excluir a evidência “${item.title}”?`)) return; p.evidence=p.evidence.filter(e=>e.id!==item.id); touchProject(p); addActivity('Evidência excluída',item.title,p.id); saveState(); modal=null; render(); showToast('Evidência excluída.');
  }));

  document.getElementById('caseStudyForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return; const fd=new FormData(e.currentTarget); const now=new Date().toISOString();
    p.caseStudy={...p.caseStudy,title:String(fd.get('title')||'').trim(),role:String(fd.get('role')||'').trim(),period:String(fd.get('period')||'').trim(),status:String(fd.get('status')||'Draft')==='Ready'?'Ready':'Draft',challenge:String(fd.get('challenge')||'').trim(),responsibilities:String(fd.get('responsibilities')||'').trim(),approach:String(fd.get('approach')||'').trim(),results:String(fd.get('results')||'').trim(),lessons:String(fd.get('lessons')||'').trim()};
    touchProject(p); addActivity('Case Study revisado',`${p.caseStudy.title} • ${p.caseStudy.status}`,p.id); saveState(); modal=null; render(); showToast('Narrativa do Case Study salva.');
  });

  document.getElementById('sprintForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd=new FormData(e.currentTarget); const sprintId=e.currentTarget.dataset.sprintId; const name=String(fd.get('name')||'').trim(); if(!name) return;
    const startDate=String(fd.get('startDate')||''); const endDate=String(fd.get('endDate')||'');
    if (startDate && endDate && endDate < startDate) { showToast('A data final precisa ser igual ou posterior à data inicial.'); return; }
    const selected = new Set(fd.getAll('storyIds').map(String));
    let sprint = sprintId ? p.sprints.find(s=>s.id===sprintId) : null;
    const now=new Date().toISOString();
    if (!sprint) { sprint={id:uid(), status:'Planned', createdAt:now, startedAt:null, completedAt:null, snapshot:null}; p.sprints.push(sprint); }
    Object.assign(sprint,{name, goal:String(fd.get('goal')||'').trim(), startDate, endDate, capacity:Number(fd.get('capacity')||0)});
    if (sprint.status !== 'Completed') {
      p.stories.forEach(story => {
        if (selected.has(story.id)) story.sprintId=sprint.id;
        else if (story.sprintId===sprint.id) story.sprintId=null;
      });
    }
    const metrics=sprintLiveMetrics(sprint,p.stories||[]);
    touchProject(p); addActivity(sprintId?'Sprint atualizada':'Sprint planejada', `${sprint.name} • ${metrics.storyCount} Stories • ${metrics.plannedPoints} pts`, p.id); saveState(); modal=null; render(); showToast(sprintId?'Sprint atualizada.':'Sprint criada.');
  });

  document.querySelectorAll('[data-action="delete-sprint"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p || !modal?.id) return;
    const sprint=p.sprints.find(s=>s.id===modal.id); if(!sprint || sprint.status!=='Planned') return;
    if(!confirm(`Excluir ${sprint.name}? As Stories voltarão a ficar sem Sprint.`)) return;
    p.stories.forEach(story=>{ if(story.sprintId===sprint.id) story.sprintId=null; });
    p.sprints=p.sprints.filter(s=>s.id!==sprint.id); touchProject(p); addActivity('Sprint excluída', `${sprint.name} foi removida do planejamento.`, p.id); saveState(); modal=null; render(); showToast('Sprint excluída.');
  }));

  document.getElementById('storyForm')?.addEventListener('submit', e => {
    e.preventDefault(); const p=currentProject(); if(!p) return;
    const fd = new FormData(e.currentTarget); const id=e.currentTarget.dataset.storyId; const title=String(fd.get('title')||'').trim(); if(!title) return;
    let story = id ? p.stories.find(s=>s.id===id) : null;
    const now = new Date().toISOString();
    if (!story) {
      p.storyCounter = Math.max(Number(p.storyCounter)||0, maxStoryNumber(p.stories)) + 1;
      story = { id:uid(), key:`${p.keyPrefix}-${String(p.storyCounter).padStart(3,'0')}`, createdAt:now };
      p.stories.push(story);
    }
    Object.assign(story, {
      title,
      epicId:String(fd.get('epicId')||''), status:String(fd.get('status')||'Backlog'), priority:String(fd.get('priority')||'Medium'),
      storyPoints:Number(fd.get('storyPoints')||3), businessValue:Number(fd.get('businessValue')||3),
      asA:String(fd.get('asA')||'').trim(), iWant:String(fd.get('iWant')||'').trim(), soThat:String(fd.get('soThat')||'').trim(),
      acceptanceCriteria:String(fd.get('acceptanceCriteria')||'').trim(), updatedAt:now, sprintId:story.sprintId || null
    });
    touchProject(p); addActivity(id ? 'User Story atualizada' : 'User Story criada', `${story.key} • ${story.title}`, p.id); saveState(); modal=null; render(); showToast(id ? 'User Story atualizada.' : 'User Story criada.');
  });

  document.querySelectorAll('[data-action="delete-story"]').forEach(btn => btn.addEventListener('click', () => {
    const p=currentProject(); if(!p || !modal?.id) return;
    const story=p.stories.find(s=>s.id===modal.id); if(!story) return;
    if(!confirm(`Excluir ${story.key} • ${story.title}?`)) return;
    p.stories=p.stories.filter(s=>s.id!==story.id); touchProject(p); addActivity('User Story excluída', `${story.key} foi removida do backlog.`, p.id); saveState(); modal=null; render(); showToast('User Story excluída.');
  }));
}

function removeGeneratedEvidence(compositeId) {
  const [source,id]=String(compositeId||'').split(':');
  if(source==='retro') return toggleRetroPortfolio(id);
  if(source==='decision') return toggleDecisionPortfolio(id);
  if(source==='impediment') return toggleImpedimentPortfolio(id);
  if(source==='milestone') return toggleMilestonePortfolio(id);
  if(source==='risk') return toggleRiskPortfolio(id);
}

function completeMilestone(id) {
  const p=currentProject(); const item=p?.milestones?.find(m=>m.id===id); if(!p||!item)return;
  item.status='Completed'; item.completedAt=new Date().toISOString(); item.updatedAt=item.completedAt; touchProject(p); addActivity('Milestone concluído',item.title,p.id); saveState(); render(); showToast('Milestone concluído.');
}

function toggleMilestonePortfolio(id) {
  const p=currentProject(); const item=p?.milestones?.find(m=>m.id===id); if(!p||!item)return;
  item.includeInPortfolio=!item.includeInPortfolio; item.updatedAt=new Date().toISOString(); touchProject(p); saveState(); render(); showToast(item.includeInPortfolio?'Milestone adicionado ao portfólio.':'Milestone removido do portfólio.');
}

function toggleRiskPortfolio(id) {
  const p=currentProject(); const item=p?.risks?.find(r=>r.id===id); if(!p||!item)return;
  item.includeInPortfolio=!item.includeInPortfolio; item.updatedAt=new Date().toISOString(); touchProject(p); saveState(); render(); showToast(item.includeInPortfolio?'Risk adicionado ao portfólio.':'Risk removido do portfólio.');
}

function toggleDecisionPortfolio(id) {
  const p=currentProject(); const item=p?.decisions?.find(d=>d.id===id); if(!p||!item) return;
  item.includeInPortfolio=!item.includeInPortfolio; item.updatedAt=new Date().toISOString(); touchProject(p); addActivity(item.includeInPortfolio?'Decisão adicionada ao portfolio':'Decisão removida do portfolio',item.title,p.id); saveState(); render(); showToast(item.includeInPortfolio?'Decisão marcada para o portfolio.':'Decisão removida do portfolio.');
}

function toggleImpedimentPortfolio(id) {
  const p=currentProject(); const item=p?.impediments?.find(i=>i.id===id); if(!p||!item) return;
  item.includeInPortfolio=!item.includeInPortfolio; item.updatedAt=new Date().toISOString(); touchProject(p); addActivity(item.includeInPortfolio?'Impedimento adicionado ao portfolio':'Impedimento removido do portfolio',item.title,p.id); saveState(); render(); showToast(item.includeInPortfolio?'Impedimento marcado para o portfolio.':'Impedimento removido do portfolio.');
}

function toggleRetroPortfolio(retroId) {
  const p=currentProject(); const retro=p?.retrospectives?.find(r=>r.id===retroId); if(!p || !retro) return;
  retro.includeInPortfolio=!retro.includeInPortfolio; retro.updatedAt=new Date().toISOString(); touchProject(p);
  addActivity(retro.includeInPortfolio?'Evidência adicionada ao portfolio':'Evidência removida do portfolio', retro.title || 'Retrospectiva', p.id);
  saveState(); render(); showToast(retro.includeInPortfolio?'Retrospectiva marcada para o portfolio.':'Retrospectiva removida do portfolio.');
}

function toggleActionItem(value) {
  const [retroId,itemId]=String(value||'').split('::');
  const p=currentProject(); const retro=p?.retrospectives?.find(r=>r.id===retroId); const item=retro?.actionItems?.find(i=>i.id===itemId);
  if(!p || !retro || !item) return;
  const done=item.status!=='Done'; item.status=done?'Done':'Open'; item.completedAt=done?new Date().toISOString():null; retro.updatedAt=new Date().toISOString(); touchProject(p);
  addActivity(done?'Action Item concluído':'Action Item reaberto', item.text, p.id); saveState(); render(); showToast(done?'Action Item concluído.':'Action Item reaberto.');
}

function touchProject(project) {
  project.updatedAt = new Date().toISOString();
}

function derivePrefix(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0,3).map(w=>w[0]).join('').toUpperCase();
  const cleaned = String(name || 'PRJ').replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  return (cleaned.slice(0,3) || 'PRJ');
}

function maxStoryNumber(stories=[]) {
  return stories.reduce((max,s)=>{
    const m=String(s.key||'').match(/(\d+)$/); return Math.max(max, m ? Number(m[1]) : 0);
  },0);
}

function slugify(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,42) || 'project';
}

function showToast(message) {
  clearTimeout(toastTimer); document.querySelector('.toast')?.remove();
  const el=document.createElement('div'); el.className='toast'; el.textContent=message; document.body.appendChild(el);
  toastTimer=setTimeout(()=>el.remove(),2600);
}

window.addEventListener('beforeunload', event => {
  if (state?.preferences?.bridgePrimaryEnabled && syncState.pending) {
    event.preventDefault();
    event.returnValue = '';
  }
});

render();
setTimeout(() => initializeLocalFirst(), 250);
