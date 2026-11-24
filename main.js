'use strict';

const {
  Plugin, ItemView, Menu, PluginSettingTab, Setting, TFile, TFolder,
  MarkdownRenderer, Notice, Platform, setIcon, normalizePath, moment,
} = require('obsidian');

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const VIEW_TYPE = 'keep-notes-view';

// Paleta do Google Keep (claro / escuro). O id é o que vai no frontmatter.
const CORES = [
  { id: 'default',    nome: 'Padrão' },
  { id: 'coral',      nome: 'Coral' },
  { id: 'pessego',    nome: 'Pêssego' },
  { id: 'areia',      nome: 'Areia' },
  { id: 'menta',      nome: 'Menta' },
  { id: 'salvia',     nome: 'Sálvia' },
  { id: 'nevoa',      nome: 'Névoa' },
  { id: 'ceu',        nome: 'Céu' },
  { id: 'tempestade', nome: 'Tempestade' },
  { id: 'rosa',       nome: 'Rosa' },
  { id: 'giz',        nome: 'Giz' },
  { id: 'cinza',      nome: 'Cinza' },
];
const CORES_IDS = new Set(CORES.map((c) => c.id));

const DEFAULT_SETTINGS = {
  pasta: 'Notas rápidas',
  corPadrao: 'areia',
  incluirSubpastas: true,
  larguraCard: 240,
  ordenacao: 'criacao',      // 'criacao' | 'edicao'
  barraAoEditar: 'mobile',   // 'mobile' | 'sempre' | 'nunca'
};

const RE_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const RE_MARCADOR_LISTA = /^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/;
const RE_TAREFA = /^(\s*(?:[-*+]|\d+\.)\s+\[)( |x|X)(\])/;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function separarFrontmatter(texto) {
  const m = texto.match(RE_FRONTMATTER);
  if (!m) return { fm: '', corpo: texto };
  return { fm: m[0], corpo: texto.slice(m[0].length) };
}

function sanitizarNome(nome) {
  return nome.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

// Barra de formatação para um <textarea> com Markdown.
// Cada ação opera sobre a seleção e devolve o foco ao campo.
class Formatador {
  constructor(textarea, aoMudar) {
    this.ta = textarea;
    this.aoMudar = aoMudar;
  }

  _set(valor, ini, fim) {
    this.ta.value = valor;
    this.ta.setSelectionRange(ini, fim);
    this.ta.focus();
    this.aoMudar && this.aoMudar();
  }

  envolver(antes, depois = antes) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    const sel = v.slice(s, e);
    // Já está envolvido? Então remove.
    if (v.slice(s - antes.length, s) === antes && v.slice(e, e + depois.length) === depois) {
      const novo = v.slice(0, s - antes.length) + sel + v.slice(e + depois.length);
      return this._set(novo, s - antes.length, e - antes.length);
    }
    if (sel.startsWith(antes) && sel.endsWith(depois) && sel.length >= antes.length + depois.length) {
      const miolo = sel.slice(antes.length, sel.length - depois.length);
      return this._set(v.slice(0, s) + miolo + v.slice(e), s, s + miolo.length);
    }
    const novo = v.slice(0, s) + antes + sel + depois + v.slice(e);
    this._set(novo, s + antes.length, e + antes.length);
  }

  // Alterna um prefixo de linha em todas as linhas selecionadas.
  // `tem` reconhece o prefixo desejado; `remover` reconhece qualquer marcador
  // de lista a ser trocado (ex.: "- " vira "- [ ] ").
  prefixo(pref, tem, remover = tem) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    const iniLinha = v.lastIndexOf('\n', s - 1) + 1;
    let fimLinha = v.indexOf('\n', e);
    if (fimLinha === -1) fimLinha = v.length;
    const bloco = v.slice(iniLinha, fimLinha);
    const linhas = bloco.split('\n');
    const todasTem = linhas.every((l) => tem.test(l.replace(/^\s*/, '')));
    const novas = linhas.map((l, i) => {
      const semIndent = l.replace(/^\s*/, '');
      const indent = l.slice(0, l.length - semIndent.length);
      const limpa = semIndent.replace(remover, '');
      if (todasTem) return indent + limpa;
      const p = pref.replace('%n', String(i + 1));
      return indent + p + limpa;
    });
    const novoBloco = novas.join('\n');
    const novo = v.slice(0, iniLinha) + novoBloco + v.slice(fimLinha);
    this._set(novo, iniLinha, iniLinha + novoBloco.length);
  }

  negrito()     { this.envolver('**'); }
  italico()     { this.envolver('*'); }
  sublinhado()  { this.envolver('<u>', '</u>'); }
  tachado()     { this.envolver('~~'); }
  destaque()    { this.envolver('=='); }
  codigo()      { this.envolver('`'); }
  titulo()      { this.prefixo('## ', /^#{1,6}\s+/); }
  topicos()     { this.prefixo('- ', /^[-*+]\s+(?!\[[ xX]\]\s)/, RE_MARCADOR_LISTA); }
  numerada()    { this.prefixo('%n. ', /^\d+\.\s+(?!\[[ xX]\]\s)/, RE_MARCADOR_LISTA); }
  tarefa()      { this.prefixo('- [ ] ', /^(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/, RE_MARCADOR_LISTA); }

  // Enter dentro de lista continua a lista; Enter em item vazio encerra.
  aoEnter(ev) {
    const { value: v, selectionStart: s, selectionEnd: e } = this.ta;
    if (s !== e) return false;
    const iniLinha = v.lastIndexOf('\n', s - 1) + 1;
    const linha = v.slice(iniLinha, s);
    const m = linha.match(/^(\s*)(?:([-*+])\s+(\[[ xX]\]\s+)?|(\d+)\.\s+)(.*)$/);
    if (!m) return false;
    ev.preventDefault();
    const [, indent, marcador, caixa, num, resto] = m;
    if (!resto.trim()) {
      // Item vazio: remove o marcador e sai da lista.
      this._set(v.slice(0, iniLinha) + indent + v.slice(s), iniLinha + indent.length, iniLinha + indent.length);
      return true;
    }
    let pref;
    if (num) pref = `${indent}${Number(num) + 1}. `;
    else pref = `${indent}${marcador} ${caixa ? '[ ] ' : ''}`;
    const novo = v.slice(0, s) + '\n' + pref + v.slice(s);
    this._set(novo, s + 1 + pref.length, s + 1 + pref.length);
    return true;
  }

  atalho(ev) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Enter' && !mod && !ev.shiftKey) return this.aoEnter(ev);
    if (!mod) return false;
    const k = ev.key.toLowerCase();
    if (k === 'b') { ev.preventDefault(); this.negrito(); return true; }
    if (k === 'i') { ev.preventDefault(); this.italico(); return true; }
    if (k === 'u') { ev.preventDefault(); this.sublinhado(); return true; }
    if (ev.shiftKey && k === 'x') { ev.preventDefault(); this.tachado(); return true; }
    if (ev.shiftKey && k === 'c') { ev.preventDefault(); this.tarefa(); return true; }
    if (ev.shiftKey && ev.code === 'Digit8') { ev.preventDefault(); this.topicos(); return true; }
    return false;
  }
}

const BOTOES_BARRA = [
  { acao: 'negrito',    icone: 'bold',           rotulo: 'Negrito (Ctrl+B)' },
  { acao: 'italico',    icone: 'italic',         rotulo: 'Itálico (Ctrl+I)' },
  { acao: 'sublinhado', icone: 'underline',      rotulo: 'Sublinhado (Ctrl+U)' },
  { acao: 'tachado',    icone: 'strikethrough',  rotulo: 'Tachado (Ctrl+Shift+X)' },
  { acao: 'destaque',   icone: 'highlighter',    rotulo: 'Destaque' },
  { sep: true },
  { acao: 'titulo',     icone: 'heading',        rotulo: 'Título' },
  { acao: 'topicos',    icone: 'list',           rotulo: 'Lista de tópicos (Ctrl+Shift+8)' },
  { acao: 'numerada',   icone: 'list-ordered',   rotulo: 'Lista numerada' },
  { acao: 'tarefa',     icone: 'check-square',   rotulo: 'Tarefa (Ctrl+Shift+C)' },
  { sep: true },
  { acao: 'codigo',     icone: 'code',           rotulo: 'Código' },
];

function montarBarra(container, formatador) {
  const barra = container.createDiv({ cls: 'keep-toolbar' });
  for (const b of BOTOES_BARRA) {
    if (b.sep) { barra.createSpan({ cls: 'keep-toolbar-sep' }); continue; }
    const btn = barra.createEl('button', { cls: 'keep-tb-btn clickable-icon', attr: { 'aria-label': b.rotulo, title: b.rotulo, type: 'button' } });
    setIcon(btn, b.icone);
    // mousedown/touchend com preventDefault: o textarea não perde o foco nem a seleção
    btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); formatador[b.acao](); });
    btn.addEventListener('touchend', (ev) => { ev.preventDefault(); formatador[b.acao](); }, { passive: false });
  }
  return barra;
}

function montarPaleta(container, corAtual, aoEscolher) {
  const pal = container.createDiv({ cls: 'keep-palette' });
  for (const c of CORES) {
    const dot = pal.createEl('button', {
      cls: 'keep-color-dot' + (c.id === corAtual ? ' is-active' : ''),
      attr: { 'data-color': c.id, 'aria-label': c.nome, title: c.nome, type: 'button' },
    });
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pal.querySelectorAll('.keep-color-dot').forEach((d) => d.removeClass('is-active'));
      dot.addClass('is-active');
      aoEscolher(c.id);
    });
  }
  return pal;
}

function autoAltura(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 480) + 'px';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class KeepNotesPlugin extends Plugin {
  async onload() {
    await this.carregarSettings();

    this.registerView(VIEW_TYPE, (leaf) => new KeepView(leaf, this));

    this.addRibbonIcon('sticky-note', 'Notas rápidas', () => this.abrirView());
    this.addRibbonIcon('file-plus', 'Nova nota rápida', () => this.novaNota());

    this.addCommand({ id: 'abrir', name: 'Abrir notas rápidas', callback: () => this.abrirView() });
    this.addCommand({ id: 'nova', name: 'Nova nota rápida', callback: () => this.novaNota() });

    this.addSettingTab(new KeepSettingTab(this.app, this));
  }

  onunload() {}

  async carregarSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async salvarSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view.recarregar && l.view.recarregar());
  }

  get pasta() {
    return normalizePath(this.settings.pasta || DEFAULT_SETTINGS.pasta);
  }

  async garantirPasta() {
    const p = this.pasta;
    const existente = this.app.vault.getAbstractFileByPath(p);
    if (existente instanceof TFolder) return existente;
    if (existente) throw new Error(`"${p}" existe mas não é uma pasta.`);
    return this.app.vault.createFolder(p);
  }

  pertenceAPasta(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    const base = this.pasta + '/';
    if (!file.path.startsWith(base)) return false;
    if (this.settings.incluirSubpastas) return true;
    return !file.path.slice(base.length).includes('/');
  }

  listarNotas() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.pertenceAPasta(f));
  }

  lerMeta(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const cor = CORES_IDS.has(fm.color) ? fm.color : 'default';
    const fixada = fm.pinned === true || fm.pinned === 'true';
    const criada = fm.created ? moment(String(fm.created), ['YYYY-MM-DD', moment.ISO_8601]) : moment(file.stat.ctime);
    return { cor, fixada, criada: criada.isValid() ? criada : moment(file.stat.ctime) };
  }

  async lerCorpo(file) {
    const texto = await this.app.vault.cachedRead(file);
    return separarFrontmatter(texto).corpo;
  }

  async escreverCorpo(file, corpo) {
    const atual = await this.app.vault.read(file);
    const { fm } = separarFrontmatter(atual);
    const novo = fm + corpo;
    if (novo !== atual) await this.app.vault.modify(file, novo);
  }

  async definirCor(file, cor) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.color = cor; });
  }

  async definirFixada(file, fixada) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.pinned = !!fixada; });
  }

  async alternarTarefa(file, indice) {
    const atual = await this.app.vault.read(file);
    const { fm, corpo } = separarFrontmatter(atual);
    const linhas = corpo.split('\n');
    let n = -1;
    let emCodigo = false;
    for (let i = 0; i < linhas.length; i++) {
      if (/^\s*(```|~~~)/.test(linhas[i])) { emCodigo = !emCodigo; continue; }
      if (emCodigo) continue;
      const m = linhas[i].match(RE_TAREFA);
      if (!m) continue;
      n++;
      if (n !== indice) continue;
      const marcado = m[2] !== ' ';
      linhas[i] = linhas[i].replace(RE_TAREFA, `$1${marcado ? ' ' : 'x'}$3`);
      break;
    }
    await this.app.vault.modify(file, fm + linhas.join('\n'));
  }

  nomeUnico(pasta, nome, ignorar = null) {
    let candidato = nome;
    let i = 2;
    for (;;) {
      const existente = this.app.vault.getAbstractFileByPath(`${pasta}/${candidato}.md`);
      if (!existente || existente === ignorar) return candidato;
      candidato = `${nome} ${i++}`;
    }
  }

  async criarNota({ titulo = '', corpo = '', cor } = {}) {
    const nome = sanitizarNome(titulo);
    if (!nome) throw new Error('A nota precisa de um título.');
    const pasta = await this.garantirPasta();
    const unico = this.nomeUnico(pasta.path, nome);
    const corFinal = CORES_IDS.has(cor) ? cor : this.settings.corPadrao;
    const conteudo = `---\ncolor: ${corFinal}\npinned: false\ncreated: ${moment().format('YYYY-MM-DD')}\n---\n${corpo}`;
    return this.app.vault.create(`${pasta.path}/${unico}.md`, conteudo);
  }

  async renomear(file, novoTitulo) {
    const nome = sanitizarNome(novoTitulo);
    if (!nome || nome === file.basename) return file;
    const pastaPai = file.parent ? file.parent.path : this.pasta;
    const unico = this.nomeUnico(pastaPai, nome, file);
    await this.app.fileManager.renameFile(file, `${pastaPai}/${unico}.md`);
    return file;
  }

  async excluir(file) {
    await this.app.vault.trash(file, true);
  }

  async abrirView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf;
  }

  async novaNota() {
    const leaf = await this.abrirView();
    if (leaf.view instanceof KeepView) leaf.view.novoRascunho();
  }
}

// ---------------------------------------------------------------------------
// Visão em grade
// ---------------------------------------------------------------------------

class KeepView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.busca = '';
    this.grades = [];
    this.editando = null;        // elemento do cartão em edição (nota ou rascunho)
    this.renderPendente = false;
    this.rascunhoEl = null;
    this.recarregar = debounce(() => this.render(), 150);
    this.aoRedimensionar = debounce(() => this.redistribuirTudo(), 100);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Notas rápidas'; }
  getIcon() { return 'sticky-note'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('keep-root');

    const header = root.createDiv({ cls: 'keep-header' });
    const buscaWrap = header.createDiv({ cls: 'keep-search' });
    setIcon(buscaWrap.createSpan({ cls: 'keep-search-icon' }), 'search');
    const busca = buscaWrap.createEl('input', { type: 'search', placeholder: 'Pesquisar notas', cls: 'keep-search-input' });
    busca.addEventListener('input', () => { this.busca = busca.value.trim().toLowerCase(); this.render(); });

    const btnNova = header.createEl('button', { cls: 'keep-btn-nova mod-cta' });
    setIcon(btnNova.createSpan(), 'plus');
    btnNova.createSpan({ text: 'Nova nota' });
    btnNova.addEventListener('click', () => this.novoRascunho());

    this.draftEl = root.createDiv({ cls: 'keep-draft-area' });
    this.gridEl = root.createDiv({ cls: 'keep-sections' });
    this.larguraAnterior = 0;
    this.ro = new ResizeObserver((entradas) => {
      const w = Math.round(entradas[0].contentRect.width);
      if (w !== this.larguraAnterior) { this.larguraAnterior = w; this.aoRedimensionar(); }
    });
    this.ro.observe(this.gridEl);

    const v = this.app.vault;
    const soPasta = (f) => { if (this.plugin.pertenceAPasta(f) || f instanceof TFolder) this.recarregar(); };
    this.registerEvent(v.on('create', soPasta));
    this.registerEvent(v.on('modify', soPasta));
    this.registerEvent(v.on('delete', soPasta));
    this.registerEvent(v.on('rename', (f, antigo) => {
      if (this.plugin.pertenceAPasta(f) || antigo.startsWith(this.plugin.pasta + '/')) this.recarregar();
    }));
    this.registerEvent(this.app.metadataCache.on('changed', soPasta));

    await this.render();
  }

  async onClose() {
    if (this.ro) this.ro.disconnect();
  }

  // ---- carregamento e layout -------------------------------------------

  async carregarNotas() {
    const arquivos = this.plugin.listarNotas();
    const notas = await Promise.all(arquivos.map(async (file) => {
      const meta = this.plugin.lerMeta(file);
      const corpo = await this.plugin.lerCorpo(file);
      return { file, corpo, ...meta };
    }));
    const chave = this.plugin.settings.ordenacao === 'edicao'
      ? (n) => n.file.stat.mtime
      : (n) => n.criada.valueOf();
    notas.sort((a, b) => (b.fixada - a.fixada) || (chave(b) - chave(a)) || a.file.basename.localeCompare(b.file.basename));
    if (!this.busca) return notas;
    return notas.filter((n) => (n.file.basename + '\n' + n.corpo).toLowerCase().includes(this.busca));
  }

  async render() {
    if (!this.gridEl) return;
    // Não redesenha enquanto um cartão está sendo editado: isso destruiria o campo.
    if (this.editando) { this.renderPendente = true; return; }
    this.renderPendente = false;
    const notas = await this.carregarNotas();
    if (this.editando) { this.renderPendente = true; return; }
    this.gridEl.empty();
    this.grades = [];
    this.gridEl.style.setProperty('--keep-card-w', `${this.plugin.settings.larguraCard}px`);

    if (!notas.length) {
      const vazio = this.gridEl.createDiv({ cls: 'keep-empty' });
      setIcon(vazio.createSpan({ cls: 'keep-empty-icon' }), 'sticky-note');
      vazio.createDiv({ text: this.busca ? 'Nenhuma nota corresponde à pesquisa.' : 'Clique em "Nova nota" para começar.' });
      return;
    }

    const fixadas = notas.filter((n) => n.fixada);
    const outras = notas.filter((n) => !n.fixada);
    if (fixadas.length) {
      this.gridEl.createDiv({ cls: 'keep-section-title', text: 'Fixadas' });
      this.montarGrade(fixadas);
      if (outras.length) this.gridEl.createDiv({ cls: 'keep-section-title', text: 'Outras' });
    }
    if (outras.length) this.montarGrade(outras);
  }

  montarGrade(notas) {
    const grade = this.gridEl.createDiv({ cls: 'keep-grid' });
    const cards = [];
    const prontos = [];
    for (const n of notas) {
      const { card, pronto } = this.montarCard(n);
      cards.push(card);
      prontos.push(pronto);
    }
    this.grades.push({ grade, cards });
    this.distribuir(grade, cards, true);
    Promise.all(prontos).then(() => this.distribuir(grade, cards));
  }

  // Masonry: cada cartão vai para a coluna mais baixa no momento.
  distribuir(grade, cards, forcar = false) {
    if (!grade.isConnected) return;
    // Durante a edição o layout fica congelado: o cartão não pode trocar de coluna com o cursor dentro.
    if (this.editando && !forcar) { this.layoutPendente = true; return; }
    this.layoutPendente = false;
    const gap = 14;
    const largura = grade.clientWidth || this.gridEl.clientWidth || 800;
    const n = Math.max(1, Math.floor((largura + gap) / (this.plugin.settings.larguraCard + gap)));
    const ativo = document.activeElement;
    grade.empty();
    const cols = [];
    for (let i = 0; i < n; i++) cols.push(grade.createDiv({ cls: 'keep-col' }));
    for (const card of cards) {
      let alvo = cols[0];
      for (const c of cols) if (c.offsetHeight < alvo.offsetHeight) alvo = c;
      alvo.appendChild(card);
    }
    if (ativo && grade.contains(ativo) && document.activeElement !== ativo) ativo.focus();
  }

  redistribuirTudo() {
    for (const { grade, cards } of this.grades) this.distribuir(grade, cards);
  }

  // ---- edição no próprio cartão ----------------------------------------

  // Encerra a edição e redesenha, se algo ficou pendente.
  terminarEdicao() {
    this.editando = null;
    this.layoutPendente = false;
    this.recarregar();
  }

  // Abre a paleta de um cartão e fecha ao clicar/tocar fora dela.
  abrirPaleta(pal) {
    pal.addClass('is-open');
    const fechar = (ev) => {
      if (pal.contains(ev.target)) return;
      pal.removeClass('is-open');
      document.removeEventListener('pointerdown', fechar, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', fechar, true), 0);
  }

  mostrarBarraAoEditar() {
    const m = this.plugin.settings.barraAoEditar;
    return m === 'sempre' || (m === 'mobile' && Platform.isMobile);
  }

  montarCard(nota) {
    const { file, cor, fixada, corpo, criada } = nota;
    const card = createDiv({ cls: 'keep-card', attr: { 'data-color': cor } });
    let pronto = Promise.resolve();
    let corpoAtual = corpo;

    // Fixar
    const pin = card.createEl('button', { cls: 'keep-card-pin clickable-icon' + (fixada ? ' is-active' : ''), attr: { 'aria-label': fixada ? 'Desafixar' : 'Fixar', title: fixada ? 'Desafixar' : 'Fixar' } });
    setIcon(pin, fixada ? 'pin-off' : 'pin');
    pin.addEventListener('click', (ev) => { ev.stopPropagation(); this.plugin.definirFixada(file, !fixada); });

    // Título editável
    const titulo = card.createEl('input', { type: 'text', cls: 'keep-card-title', value: file.basename, attr: { placeholder: 'Título', spellcheck: 'false' } });
    titulo.addEventListener('focus', () => { this.editando = card; });
    titulo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); entrarEdicao(); }
      if (ev.key === 'Escape') { ev.preventDefault(); titulo.value = file.basename; titulo.blur(); }
    });
    titulo.addEventListener('change', async () => {
      const novo = sanitizarNome(titulo.value);
      if (!novo) { titulo.value = file.basename; new Notice('A nota precisa de um título.'); return; }
      if (novo === file.basename) return;
      try { await this.plugin.renomear(file, novo); }
      catch (e) { titulo.value = file.basename; new Notice('Não foi possível renomear: ' + e.message); }
    });

    // Corpo renderizado
    const body = card.createDiv({ cls: 'keep-card-body markdown-rendered' });
    const renderizarCorpo = () => {
      body.empty();
      body.removeClass('is-overflow');
      if (!corpoAtual.trim()) {
        body.createDiv({ cls: 'keep-card-empty', text: 'Clique para escrever' });
        return Promise.resolve();
      }
      return MarkdownRenderer.render(this.app, corpoAtual, body, file.path, this).then(() => {
        if (body.scrollHeight > body.clientHeight + 4) body.addClass('is-overflow');
        body.querySelectorAll('input.task-list-item-checkbox').forEach((cb, i) => {
          cb.disabled = false;
          cb.addEventListener('click', (ev) => { ev.stopPropagation(); this.plugin.alternarTarefa(file, i); });
        });
      });
    };
    pronto = renderizarCorpo();

    // Corpo em edição (textarea no lugar do texto renderizado)
    const ta = card.createEl('textarea', { cls: 'keep-card-edit', attr: { placeholder: 'Escreva aqui...', rows: 2 } });
    const fmt = new Formatador(ta, () => { autoAltura(ta); salvarCorpo(); });
    const barra = montarBarra(card, fmt);
    barra.addClass('keep-card-toolbar');
    let sujo = false;
    const gravar = async () => {
      if (!sujo) return;
      sujo = false;
      corpoAtual = ta.value;
      try { await this.plugin.escreverCorpo(file, corpoAtual); }
      catch (e) { new Notice('Não foi possível salvar: ' + e.message); }
    };
    const salvarCorpo = debounce(gravar, 800);
    ta.addEventListener('input', () => { sujo = true; autoAltura(ta); salvarCorpo(); });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ta.blur(); return; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); ta.blur(); return; }
      fmt.atalho(ev);
    });

    const entrarEdicao = () => {
      if (card.hasClass('is-editing')) { ta.focus(); return; }
      this.editando = card;
      ta.value = corpoAtual;
      card.addClass('is-editing');
      if (this.mostrarBarraAoEditar()) card.addClass('show-toolbar');
      autoAltura(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    const sairEdicao = async () => {
      if (!card.hasClass('is-editing')) return;
      card.removeClass('is-editing');
      card.removeClass('show-toolbar');
      await gravar();
      await renderizarCorpo();
    };

    body.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('input')) return;
      const sel = window.getSelection();
      if (sel && sel.toString() && body.contains(sel.anchorNode)) return; // usuário está copiando texto
      const link = t.closest('a');
      if (link) {
        ev.preventDefault();
        if (link.hasClass('internal-link')) this.app.workspace.openLinkText(link.dataset.href || link.getAttribute('href'), file.path);
        else if (link.href) window.open(link.href);
        return;
      }
      entrarEdicao();
    });

    // Paleta de cores (abre pelo menu)
    const pal = montarPaleta(card, cor, (c) => { pal.removeClass('is-open'); this.plugin.definirCor(file, c); });
    pal.addClass('keep-palette-pop');

    // Confirmação de exclusão, no próprio cartão
    const confirmar = card.createDiv({ cls: 'keep-card-confirm' });
    confirmar.createSpan({ text: 'Excluir esta nota?' });
    const btnSim = confirmar.createEl('button', { text: 'Excluir', cls: 'keep-btn-ghost keep-del is-armed' });
    const btnNao = confirmar.createEl('button', { text: 'Cancelar', cls: 'keep-btn-ghost' });
    btnSim.addEventListener('click', (ev) => { ev.stopPropagation(); if (this.editando === card) this.editando = null; this.plugin.excluir(file); });
    btnNao.addEventListener('click', (ev) => { ev.stopPropagation(); confirmar.removeClass('is-open'); });

    // Rodapé: data de criação + menu ⋮
    const rodape = card.createDiv({ cls: 'keep-card-footer' });
    rodape.createSpan({ cls: 'keep-card-date', text: criada.format('DD-MM-YY'), attr: { title: 'Criada em ' + criada.format('DD/MM/YYYY') } });
    const btnMais = rodape.createEl('button', { cls: 'clickable-icon keep-card-more', attr: { 'aria-label': 'Mais opções', title: 'Mais opções' } });
    setIcon(btnMais, 'more-vertical');
    const encerrar = async () => {
      await sairEdicao();
      if (this.editando === card) this.terminarEdicao();
    };
    btnMais.addEventListener('click', (ev) => {
      ev.stopPropagation();
      card.dataset.menuAberto = '1';
      const menu = new Menu();
      menu.onHide(() => {
        delete card.dataset.menuAberto;
        setTimeout(() => { if (card.isConnected && !card.contains(document.activeElement)) encerrar(); }, 0);
      });
      menu.addItem((i) => i.setTitle('Formatação de texto').setIcon('type').onClick(() => { card.addClass('show-toolbar'); entrarEdicao(); }));
      menu.addItem((i) => i.setTitle('Mudar cor').setIcon('palette').onClick(() => this.abrirPaleta(pal)));
      menu.addItem((i) => i.setTitle(fixada ? 'Desafixar' : 'Fixar').setIcon(fixada ? 'pin-off' : 'pin').onClick(() => this.plugin.definirFixada(file, !fixada)));
      menu.addItem((i) => i.setTitle('Abrir como nota').setIcon('file-text').onClick(() => this.app.workspace.getLeaf('tab').openFile(file)));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('Excluir').setIcon('trash-2').setWarning(true).onClick(() => confirmar.addClass('is-open')));
      menu.showAtMouseEvent(ev);
    });

    // Quando o foco sai do cartão, encerra a edição e libera o redesenho.
    card.addEventListener('focusout', (ev) => {
      if (ev.relatedTarget && card.contains(ev.relatedTarget)) return;
      if (card.dataset.menuAberto) return;
      setTimeout(() => { if (!card.contains(document.activeElement)) encerrar(); }, 0);
    });

    return { card, pronto };
  }

  // ---- rascunho de nota nova -------------------------------------------

  novoRascunho() {
    if (this.rascunhoEl && this.rascunhoEl.isConnected) {
      this.rascunhoEl.querySelector('.keep-card-title').focus();
      return;
    }
    const cor = this.plugin.settings.corPadrao;
    const card = createDiv({ cls: 'keep-card keep-card-draft is-editing', attr: { 'data-color': cor } });
    this.rascunhoEl = card;
    this.editando = card;

    const titulo = card.createEl('input', { type: 'text', cls: 'keep-card-title', attr: { placeholder: 'Título (obrigatório)', spellcheck: 'false' } });
    const ta = card.createEl('textarea', { cls: 'keep-card-edit', attr: { placeholder: 'Escreva aqui...', rows: 3 } });
    const fmt = new Formatador(ta, () => autoAltura(ta));
    const barra = montarBarra(card, fmt);
    barra.addClass('keep-card-toolbar');
    let corEscolhida = cor;
    const pal = montarPaleta(card, cor, (c) => { corEscolhida = c; card.setAttribute('data-color', c); pal.removeClass('is-open'); });
    pal.addClass('keep-palette-pop');

    const rodape = card.createDiv({ cls: 'keep-card-footer' });
    rodape.createSpan({ cls: 'keep-card-date', text: moment().format('DD-MM-YY') });
    const acoes = rodape.createDiv({ cls: 'keep-draft-actions' });
    const btnCor = acoes.createEl('button', { cls: 'clickable-icon', attr: { title: 'Cor' } });
    setIcon(btnCor, 'palette');
    btnCor.addEventListener('click', (ev) => { ev.stopPropagation(); if (pal.hasClass('is-open')) pal.removeClass('is-open'); else this.abrirPaleta(pal); });
    const btnFmt = acoes.createEl('button', { cls: 'clickable-icon', attr: { title: 'Formatação de texto' } });
    setIcon(btnFmt, 'type');
    btnFmt.addEventListener('click', (ev) => { ev.stopPropagation(); card.toggleClass('show-toolbar', !card.hasClass('show-toolbar')); ta.focus(); });
    const btnDescartar = acoes.createEl('button', { cls: 'keep-btn-ghost', text: 'Descartar' });
    const btnSalvar = acoes.createEl('button', { cls: 'mod-cta', text: 'Salvar' });

    const descartar = () => {
      card.remove();
      this.rascunhoEl = null;
      if (this.editando === card) this.terminarEdicao();
    };
    const salvar = async () => {
      const nome = sanitizarNome(titulo.value);
      if (!nome) {
        titulo.addClass('is-invalid');
        new Notice('Dê um título à nota antes de salvar.');
        titulo.focus();
        return false;
      }
      try {
        await this.plugin.criarNota({ titulo: nome, corpo: ta.value.trim() ? ta.value.trim() + '\n' : '', cor: corEscolhida });
        descartar();
        return true;
      } catch (e) {
        new Notice('Não foi possível criar a nota: ' + e.message);
        return false;
      }
    };

    btnDescartar.addEventListener('click', descartar);
    btnSalvar.addEventListener('click', salvar);
    titulo.addEventListener('input', () => titulo.removeClass('is-invalid'));
    titulo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ta.focus(); }
      if (ev.key === 'Escape') { ev.preventDefault(); descartar(); }
    });
    ta.addEventListener('input', () => autoAltura(ta));
    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); salvar(); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); descartar(); return; }
      fmt.atalho(ev);
    });
    // Ao sair do rascunho: salva se tem título; descarta se está vazio; senão mantém.
    card.addEventListener('focusout', (ev) => {
      if (ev.relatedTarget && card.contains(ev.relatedTarget)) return;
      setTimeout(() => {
        if (!card.isConnected || card.contains(document.activeElement)) return;
        if (!titulo.value.trim() && !ta.value.trim()) descartar();
        else if (titulo.value.trim()) salvar();
      }, 0);
    });

    if (this.mostrarBarraAoEditar()) card.addClass('show-toolbar');
    this.draftEl.empty();
    this.draftEl.appendChild(card);
    this.draftEl.style.setProperty('--keep-card-w', `${this.plugin.settings.larguraCard}px`);
    autoAltura(ta);
    titulo.focus();
    card.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

class KeepSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Pasta das notas')
      .setDesc('Toda nota criada pelo plugin vai para esta pasta. É criada automaticamente se não existir.')
      .addText((t) => t.setPlaceholder('Notas rápidas').setValue(this.plugin.settings.pasta)
        .onChange(async (v) => { this.plugin.settings.pasta = v.trim() || DEFAULT_SETTINGS.pasta; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Cor padrão das notas novas')
      .addDropdown((d) => {
        CORES.forEach((c) => d.addOption(c.id, c.nome));
        d.setValue(this.plugin.settings.corPadrao)
          .onChange(async (v) => { this.plugin.settings.corPadrao = v; await this.plugin.salvarSettings(); });
      });

    new Setting(containerEl)
      .setName('Incluir subpastas')
      .setDesc('Mostrar também notas que estejam em subpastas da pasta das notas.')
      .addToggle((t) => t.setValue(this.plugin.settings.incluirSubpastas)
        .onChange(async (v) => { this.plugin.settings.incluirSubpastas = v; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Ordenação')
      .setDesc('Notas fixadas vêm sempre primeiro.')
      .addDropdown((d) => d
        .addOption('criacao', 'Mais recentes primeiro (data de criação)')
        .addOption('edicao', 'Editadas por último primeiro')
        .setValue(this.plugin.settings.ordenacao)
        .onChange(async (v) => { this.plugin.settings.ordenacao = v; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Barra de formatação ao editar')
      .setDesc('Quando mostrar a barra automaticamente. Pelo menu ⋮ ela pode ser aberta a qualquer momento.')
      .addDropdown((d) => d
        .addOption('mobile', 'Só no celular e tablet')
        .addOption('sempre', 'Sempre')
        .addOption('nunca', 'Nunca')
        .setValue(this.plugin.settings.barraAoEditar)
        .onChange(async (v) => { this.plugin.settings.barraAoEditar = v; await this.plugin.salvarSettings(); }));

    new Setting(containerEl)
      .setName('Largura dos cartões')
      .setDesc('Em pixels. Padrão: 240.')
      .addSlider((s) => s.setLimits(180, 400, 10).setDynamicTooltip().setValue(this.plugin.settings.larguraCard)
        .onChange(async (v) => { this.plugin.settings.larguraCard = v; await this.plugin.salvarSettings(); }));
  }
}

module.exports = KeepNotesPlugin;
