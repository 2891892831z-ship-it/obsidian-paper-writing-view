'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, Modal, MarkdownView, EditorSuggest,
  editorInfoField, editorLivePreviewField, sanitizeHTMLToDom, setIcon, renderMath, finishRenderMath, Platform, requestUrl} = require('obsidian');
const {StateField, StateEffect, EditorState} = require('@codemirror/state');
const {Decoration, EditorView, WidgetType} = require('@codemirror/view');
const {scanDocument, imageInventory, citationMap, maskExamples, blankLineViolations, referenceItems, documentIssues, blankLineEdits, fakeScriptViolations, fakeScriptEdits} = require('./core');

const refreshEffect = StateEffect.define();
const DEFAULTS = {prefix: '图', align: 'center', bold: false, showUnlabelled: true, citations: true, centerImages: true, optimizeTables: true, indentParagraphs: true, compactBlankLines: true, blankLineWarnings: true, wordSpacing: true,
  imageBorderColor: '#e53935', imageBorderWidth: 1.5, imageBorderStyle: 'dashed', imageGap: 4, captionGap: 0.65,
  chineseFont: 'SimSun', latinFont: 'Times New Roman', punctuationSong: true, bodySize: 0, bodyLineHeight: 1.5,
  bodyThemeColor: true, bodyColor: '#222222', referenceColor: '#3498db', captionThemeColor: true, captionColorCustom: '#222222',
  paragraphGap: 10, indentSize: 2, captionScale: 0.875, captionLineHeight: 1.65, tableSize: 12, tableLineHeight: 1,
  quietBlankWarnings: true, fakeScriptWarnings: true, appearanceProfiles: {}, manuscriptLanguages: {}, languageAppearance: {}};

const APPEARANCE_KEYS = ['chineseFont','latinFont','punctuationSong','bodySize','bodyLineHeight','bodyThemeColor','bodyColor',
  'referenceColor','captionThemeColor','captionColorCustom','paragraphGap','indentSize','captionScale','captionLineHeight','tableSize','tableLineHeight',
  'imageBorderColor','imageBorderWidth','imageBorderStyle','imageGap','captionGap'];
const LANGUAGE_APPEARANCE_KEYS=[...APPEARANCE_KEYS,'align','bold'];
function appearanceVariables(settings) {
  const s = {...DEFAULTS, ...settings};
  const font = name => JSON.stringify(String(name).replace(/[\r\n]/g, '').trim());
  return {
    '--pcp-font': (s.punctuationSong ? "'PCP Chinese Punctuation', " : '') + font(s.latinFont) + ', ' + font(s.chineseFont) + ', STSong, \"Songti SC\", serif',
    '--pcp-body-size': s.bodySize ? s.bodySize + 'px' : 'var(--font-text-size)',
    '--pcp-body-line': String(s.bodyLineHeight), '--pcp-body-color': s.bodyThemeColor ? 'var(--text-normal)' : s.bodyColor,
    '--pcp-reference-color': s.referenceColor, '--pcp-caption-color': s.captionThemeColor ? 'var(--text-normal)' : s.captionColorCustom,
    '--pcp-blank-gap': s.paragraphGap + 'px', '--pcp-indent': s.indentSize + 'em',
    '--pcp-caption-size': s.captionScale + 'em', '--pcp-caption-line': String(s.captionLineHeight),
    '--pcp-table-size': s.tableSize + 'px', '--pcp-table-line': String(s.tableLineHeight),
    '--pcp-image-border-color': s.imageBorderColor, '--pcp-image-border-width': s.imageBorderWidth + 'px',
    '--pcp-image-border-style': s.imageBorderStyle, '--pcp-image-gap': s.imageGap + 'px', '--pcp-caption-gap': s.captionGap + 'em'
  };
}

function appearanceSnapshot(settings) {
  return Object.fromEntries([...APPEARANCE_KEYS, 'wordSpacing', 'align', 'bold', 'indentParagraphs', 'compactBlankLines'].map(key => [key, settings[key]]));
}
const BUILTIN_PROFILES = {
  '日常写作': {bodySize:20, bodyLineHeight:1.5, paragraphGap:10, tableSize:12},
  '论文阅读': {bodySize:22, bodyLineHeight:1.7, paragraphGap:12, tableSize:14},
  '紧凑修改': {bodySize:18, bodyLineHeight:1.4, paragraphGap:6, tableSize:12}
};

function languageDecision(frontmatter = {}, text = '', manual) {
  frontmatter=frontmatter || {};
  if(manual==='en'||manual==='zh')return {language:manual,source:'手动选择',uncertain:false};
  const lang=String(frontmatter.lang || frontmatter['citation-language'] || '').trim().replace(/_/g,'-');
  if(lang) return {language:/^en(?:-|$)/i.test(lang)?'en':'zh',source:(frontmatter.lang?'lang':'citation-language')+': '+lang,uncertain:false};
  const classes=Array.isArray(frontmatter.cssclasses)?frontmatter.cssclasses:String(frontmatter.cssclasses||'').split(/\s+/);
  if(classes.includes('en-doc'))return {language:'en',source:'cssclasses: en-doc',uncertain:false};
  if(!text)return {language:'zh',source:'默认中文（正文不足）',uncertain:true};
  const body=maskExamples(text).replace(/!\[[\s\S]*?\]\([^\r\n]*?\)(?:\{[^}]*\})?/g,'').replace(/!\[\[[^\]]*\]\]/g,'')
    .replace(/\[@[^\]]*\]|@(?:fig|tbl|eq):[\w:-]+|https?:\/\/\S+|<[^>]*>|\$[\s\S]*?\$/g,'').slice(0,30000);
  const han=(body.match(/[\p{Script=Han}]/gu)||[]).length,latin=(body.match(/[A-Za-z]/g)||[]).length;
  const total=han+latin,ratio=total?han/total:0;
  return {language:latin>=40 && ratio<0.15?'en':'zh',source:'正文推断',uncertain:total<40||(han>=40&&latin>=40&&ratio>=0.15&&ratio<=0.7),han,latin};
}
function manuscriptLanguage(frontmatter = {}, text = '') {
  return languageDecision(frontmatter,text).language;
}
function renamedLanguageChoices(choices, oldPath, newPath) {
  const result={...choices};let changed=false;
  for(const path of Object.keys(choices||{})) {
    if(path!==oldPath&&!path.startsWith(oldPath+'/'))continue;
    const target=newPath+path.slice(oldPath.length);
    if(!Object.prototype.hasOwnProperty.call(result,target))result[target]=choices[path];
    delete result[path];changed=true;
  }
  return changed?result:null;
}
function manuscriptVariables(settings, frontmatter) {
  const vars=appearanceVariables(settings);
  if(manuscriptLanguage(frontmatter)==='en') {
    vars['--pcp-font']=JSON.stringify(settings.latinFont || DEFAULTS.latinFont)+', serif';
    vars['--pcp-indent']=settings.indentParagraphs === false ? '0em' : ((settings.indentSize ?? DEFAULTS.indentSize)*0.5)+'em';
  }
  return vars;
}

function citationStyleIssues(language,xml) {
  const issues=[],locale=/default-locale=["']([^"']+)/i.exec(xml)?.[1] || '';
  const citation=/<citation\b[\s\S]*?<\/citation>/i.exec(xml)?.[0] || '';
  if(language==='en' && (/^zh/i.test(locale)||/prefix=["']（|suffix=["']）|delimiter=["']；/.test(citation)))issues.push('当前 CSL 的默认语言或引用标点偏中文，请确认是否适用于英文稿。');
  return issues;
}

function citationConfiguration(frontmatter = {}, settings = {}, platform = '') {
  const issues = [];
  const resolve = (property, fallback) => {
    const value = frontmatter[property] ?? fallback ?? '';
    if (typeof value !== 'string') { issues.push(`${property} 必须是单字符串，不能是列表或对象。`); return ''; }
    return value.trim();
  };
  const bibliography = resolve('bibliography', settings.pathToBibliography);
  const style = resolve('csl', frontmatter['citation-style'] ?? (settings.cslStylePath || settings.cslStyleURL));
  const pandoc = typeof settings.pathToPandoc === 'string' ? settings.pathToPandoc.trim() : '';
  if (!bibliography && !settings.pullFromZotero) issues.push('未配置文献库：请在 Pandoc Reference List 中选择 .bib 文件，或启用其 Zotero 文库来源。');
  if (!style) issues.push('未配置 CSL 引用样式：请在笔记 csl 或引用插件设置中选择样式。');
  if (!pandoc) issues.push('未配置 Pandoc 路径：请打开 Pandoc Reference List 设置。');
  for (const [label, value] of [['文献库',bibliography],['CSL',style],['Pandoc',pandoc]]) {
    if (platform === 'mac' && /^(?:[a-z]:[\\/]|\\\\)/i.test(value)) issues.push(`${label} 仍是 Windows 路径，请在 Mac 上重新选择文件。`);
    if (platform === 'win' && /^\/(?:Users|Applications|opt|usr|Volumes)\//.test(value)) issues.push(`${label} 仍是 macOS 路径，请在 Windows 上重新选择文件。`);
    if (/^~[\\/]/.test(value)) issues.push(`${label} 的 ~ 路径可能无法展开，请选择完整路径或库内相对路径。`);
  }
  return {bibliography,style,pandoc,issues};
}

// Use Obsidian's native suggestion popup; do not replace other completions.
class ReferenceSuggest extends EditorSuggest {
  onTrigger(cursor, editor, file) {
    if (!file || editor.cm?.composing) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = /@(?:(?:fig|tbl|eq):[^@\s（）()\[\]，,；;。]*|f(?:ig?)?|t(?:bl?)?|eq?)?$/.exec(before);
    if (!match) return null;
    const offset = editor.posToOffset?.({line: cursor.line, ch: cursor.ch - match[0].length});
    if (offset != null && maskExamples(editor.getValue())[offset] !== '@') return null;
    return {start: {line: cursor.line, ch: cursor.ch - match[0].length}, end: cursor, query: match[0]};
  }
  getSuggestions(context) {
    return referenceItems(context.editor.getValue(), context.query);
  }
  renderSuggestion(item, el) {
    el.createDiv({text: item.detail + '  ' + item.title, cls: 'suggestion-title'});
    el.createDiv({text: item.value, cls: 'suggestion-note'});
  }
  selectSuggestion(item) {
    const context = this.context;
    if (!context) return;
    context.editor.replaceRange(item.value, context.start, context.end);
    context.editor.setCursor({line: context.start.line, ch: context.start.ch + item.value.length});
    this.close();
  }
}

function numberedLabel(prefix, number) {
  const label=String(prefix).trim();
  return label+' '+number;
}
function appendRichText(parent, text, options = {}) {
  const doc = parent.ownerDocument, stack = [parent];
  // Only a small, attribute-free inline whitelist is interpreted as HTML.
  const tokens = text.split(/(<\/?(?:sub|sup|em|strong|i|b)>|==|\[@[^\]\r\n]+\]|@(?:fig|tbl|eq):[\w:-]+)/gi);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const open = /^<(sub|sup|em|strong|i|b)>$/i.exec(token);
    const close = /^<\/(sub|sup|em|strong|i|b)>$/i.exec(token);
    const ref = /^@(fig|tbl|eq):([\w:-]+)$/.exec(token);
    const citation = options.citations?.get(token);
    if (token === '==' && stack.at(-1).tagName === 'MARK') stack.pop();
    else if (token === '==' && tokens.slice(index + 1).includes('==')) {
      const mark = doc.createElement('mark'); stack.at(-1).append(mark); stack.push(mark);
    } else if (ref) {
      const number = (ref[1] === 'fig' ? options.numbers : ref[1] === 'tbl' ? options.tableNumbers : options.eqNumbers)?.get(ref[2]);
      const label = ref[1] === 'fig' ? options.prefix || '图' : ref[1] === 'tbl' ? options.tablePrefix || '表' : options.eqPrefix || '式';
      const span = doc.createElement('span'); span.className = 'pcp-reference';
      span.textContent = number == null ? token : numberedLabel(label,number);
      if (number == null) span.title = '未找到对应图表或公式标签';
      stack.at(-1).append(span);
    } else if (citation) {
      const span = doc.createElement('span'); span.className = 'pcp-citation';
      span.dataset.citekey = citation.keys.join('|'); span.dataset.source = options.sourcePath || '';
      span.append(sanitizeHTMLToDom(citation.value)); stack.at(-1).append(span);
    } else if (open) {
      const child = doc.createElement(open[1].toLowerCase()); stack.at(-1).append(child); stack.push(child);
    } else if (close && stack.length > 1 && stack.at(-1).tagName.toLowerCase() === close[1].toLowerCase()) stack.pop();
    else stack.at(-1).append(doc.createTextNode(token));
  }
}

class CitationBridge {
  constructor(plugin) { this.plugin = plugin; this.requests = new Map(); this.listeners = new Set(); this.scopedMaps = new Map(); }
  manager() { return this.plugin.app.plugins?.plugins['obsidian-pandoc-reference-list']?.bibManager; }
  map(path) {
    const result = citationMap(this.manager()?.getCacheForPath?.(path));
    for (const [raw, value] of this.scopedMaps.get(path) || []) result.set(raw, value);
    return result;
  }
  ensure(file, text) {
    const manager = this.manager();
    if (!manager?.getReferenceList || !file || !text.includes('[@')) return;
    const last = this.requests.get(file.path);
    if (last?.text === text && last.manager === manager && (last.ok || last.pending)) return;
    const request = {text, manager, pending: true}; this.requests.set(file.path, request);
    // Coalesce all widgets in one note into one full-document CSL request.
    Promise.resolve().then(() => manager.getReferenceList(file, text)).then(async () => {
      // The reference plugin may treat the outer image [] as one citation cluster.
      // Use a separate engine with the same scoped bibliography/CSL for inner clusters.
      const cache = manager.getCacheForPath(file.path);
      const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const scoped = cache?.settings || {bibliography: typeof fm.bibliography === 'string' ? fm.bibliography : undefined,
        style: typeof fm.csl === 'string' ? fm.csl : undefined, lang: typeof fm.lang === 'string' ? fm.lang : undefined};
      let source = cache?.source || manager;
      if (source === manager) {
        const globalStyle = manager.plugin.settings.cslStylePath || manager.plugin.settings.cslStyleURL;
        const style = manager.styleCache.has(scoped.style) ? scoped.style : globalStyle;
        const lang = manager.langCache.has(scoped.lang) ? scoped.lang : manager.engine?.opt?.lang;
        if (style && lang && manager.buildEngine) source = {bibCache: manager.bibCache,
          engine: manager.buildEngine(lang, manager.langCache, style, manager.styleCache, manager.bibCache)};
      } else {
        // loadScopedEngine constructs a fresh engine; never mutate the reference plugin's active engine.
        source = await manager.loadScopedEngine(scoped);
      }
      const map = new Map();
      const clusters = [...new Set(text.match(/\[@[^\]\r\n]+\]/g) || [])];
      const parsed = clusters.map(raw => ({raw, parts: raw.slice(1, -1).split(';').map(s => s.trim())}));
      const simple = parsed.filter(c => c.parts.every(p => /^-?@[\p{L}\p{N}_.:/+?<>~#$%&-]+$/u.test(p)));
      if (source?.engine && source !== manager) {
        const ids = new Set([...cache?.resolvedKeys || []]);
        for (const c of simple) for (const part of c.parts) ids.add(part.replace(/^-?@/, ''));
        source.engine.updateItems([...ids].filter(id => source.bibCache.has(id)));
        for (const c of simple) {
          const items = c.parts.map(part => ({id: part.replace(/^-?@/, ''), 'suppress-author': part.startsWith('-@')}));
          if (items.every(item => source.bibCache.has(item.id))) map.set(c.raw,
            {value: source.engine.makeCitationCluster(items), keys: items.map(item => item.id)});
        }
      }
      if (this.requests.get(file.path) === request) this.scopedMaps.set(file.path, map);
      request.ok = true;
      if (!this.plugin.disposed && this.requests.get(file.path) === request) this.notify(file.path);
    }).catch(error => { request.error=String(error?.message || error); console.warn('[Paper Writing View] CSL unavailable', error); })
      .finally(() => { request.pending = false; });
  }
  notify(path) { for (const callback of [...this.listeners]) callback(path); }
  clear() { this.listeners.clear(); this.requests.clear(); this.scopedMaps.clear(); }
}

class FigureWidget extends WidgetType {
  constructor(plugin, figure, file, text, prefix, numbers) {
    super(); Object.assign(this, {plugin, figure, file, text, prefix, numbers});
    const appearance=plugin.appearanceFor(file,text);
    this.styleKey = JSON.stringify([appearance.align, appearance.bold, plugin.settings.citations]);
    this.renderKey = JSON.stringify([figure.caption, figure.src, figure.width, figure.id, figure.number,
      figure.type, figure.rescue, figure.blankWarning, prefix, [...numbers || []],
      [...figure.tableNumbers || []], [...figure.eqNumbers || []], this.styleKey]);
  }
  eq(other) { return other instanceof FigureWidget && other.plugin === this.plugin &&
    other.file?.path === this.file?.path && other.renderKey === this.renderKey &&
    other.figure.from === this.figure.from && other.figure.to === this.figure.to; }
  updateDOM(dom) {
    const previous = dom._pcpWidget;
    if (!previous || previous.plugin !== this.plugin || previous.file?.path !== this.file?.path || previous.renderKey !== this.renderKey) return false;
    // Event handlers retain this original instance: update its source positions
    // instead of replacing loaded images when preceding prose changes length.
    Object.assign(previous, {figure: this.figure, file: this.file, text: this.text, numbers: this.numbers});
    return true;
  }
  toDOM(view) {
    const doc = view.dom.ownerDocument, wrap = doc.createElement(this.figure.rescue ? 'figure' : 'span');
    wrap.className = this.figure.rescue ? 'pcp-figure' : 'pcp-figure pcp-caption-only'; wrap.dataset.figureId = this.figure.id || '';
    wrap._pcpWidget = this;
    if (this.figure.type === 'tbl') wrap.classList.add('pcp-table-caption');
    if (this.figure.blankWarning) {
      wrap.classList.add('pcp-image-blank-warn');
      const warning = doc.createElement('button'); warning.type = 'button';
      warning.className = 'pcp-blank-notice'; warning.textContent = '图片附近缺少空行 · 点击检查';
      warning.addEventListener('mousedown', event => event.preventDefault());
      warning.addEventListener('click', event => {event.preventDefault(); event.stopPropagation(); this.plugin.fixBlankLines();});
      wrap.append(warning);
    }
    if (this.figure.rescue) {
    const image = doc.createElement('img'); image.alt = this.figure.caption.replace(/<[^>]*>/g, '');
    image.draggable = false;
    image.title = '双击放大预览';
    image.addEventListener('dblclick', event => {
      event.preventDefault(); event.stopPropagation();
      if (image.src) this.plugin.previewImage(image.src, image.alt);
    });
    const resource = this.plugin.resolveImage(this.figure.src, this.file?.path || '');
    const dimensions = this.plugin.imageDimensions?.get(resource);
    if (dimensions) { image.width = dimensions.width; image.height = dimensions.height; image.style.aspectRatio = dimensions.width + '/' + dimensions.height; }
    if (resource) image.src = resource;
    else { wrap.classList.add('pcp-missing'); image.alt = '未找到图片：' + this.figure.src; }
    if (this.figure.width) image.style.width = this.figure.width;
    image.addEventListener('load', () => {
      if (image.naturalWidth && image.naturalHeight) {
        if (this.plugin.imageDimensions?.size > 500) this.plugin.imageDimensions.clear();
        this.plugin.imageDimensions?.set(resource, {width:image.naturalWidth, height:image.naturalHeight});
        image.style.aspectRatio = image.naturalWidth + '/' + image.naturalHeight;
      }
      view.requestMeasure();
    });
    image.addEventListener('error', () => {
      wrap.classList.add('pcp-missing');
      image.alt = '图片无法加载：' + this.figure.src;
      view.requestMeasure();
    });
    const imageWrap = doc.createElement('span'); imageWrap.className = 'pcp-image-wrap';
    imageWrap.append(image); wrap.append(imageWrap);
    const toolbar = doc.createElement('span'); toolbar.className = 'pcp-image-toolbar';
    const action = (label, icon, callback) => {
      const button = doc.createElement('button'); button.type = 'button';
      button.title = label; button.setAttribute('aria-label', label);
      setIcon(button, icon);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); callback(); });
      toolbar.append(button);
    };
    action('放大预览', 'zoom-in', () => { if (image.src) this.plugin.previewImage(image.src, image.alt); });
    action('查看源码', 'code', () => {
      view.dispatch({selection: {anchor: this.figure.from}, scrollIntoView: true}); view.focus();
    });
    imageWrap.append(toolbar);
    }
    const caption = doc.createElement(this.figure.rescue ? 'figcaption' : 'span'); caption.className = 'pcp-caption';
    const appearance=this.plugin.appearanceFor(this.file,this.text);
    caption.style.textAlign = appearance.align;
    caption.style.fontWeight = appearance.bold ? '600' : '400';
    wrap.append(caption);
    let lastCaptionKey;
    const render = () => {
      const map = this.plugin.settings.citations ? this.plugin.citations.map(this.file?.path) : new Map();
      const captionKey = JSON.stringify([this.renderKey, [...map]]);
      if (captionKey === lastCaptionKey) return;
      lastCaptionKey = captionKey;
      caption.replaceChildren();
      if (this.figure.number != null) caption.append(doc.createTextNode(numberedLabel(this.prefix,this.figure.number) + ' '));
      const fm = this.plugin.app.metadataCache.getFileCache(this.file)?.frontmatter;
      appendRichText(caption, this.figure.caption, {citations: map, numbers: this.numbers,
        tableNumbers: this.figure.tableNumbers, eqNumbers: this.figure.eqNumbers, prefix: this.prefix,
        tablePrefix: typeof fm?.tblPrefix === 'string' ? fm.tblPrefix : '表',
        eqPrefix: typeof fm?.eqnPrefix === 'string' ? fm.eqnPrefix : '式', sourcePath: this.file?.path});
      view.requestMeasure();
    };
    render();
    const update = path => { if (path === this.file?.path) render(); };
    this.plugin.citations.listeners.add(update);
    wrap._pcpDispose = () => this.plugin.citations.listeners.delete(update);
    if (this.plugin.settings.citations) this.plugin.citations.ensure(this.file, this.text);
    wrap.addEventListener('click', event => {
      if (event.target.closest('a') || event.target.closest('img')) return;
      view.dispatch({selection: {anchor: this.figure.from}, scrollIntoView: true}); view.focus();
    });
    wrap.title = this.figure.type === 'tbl' ? '选择表名后可复制；点击编辑源码' : '双击图片放大预览；点击图注编辑源码';
    return wrap;
  }
  destroy(dom) { dom._pcpDispose?.(); }
  ignoreEvent() { return true; }
}

class FigureGroupWidget extends WidgetType {
  constructor(items) { super(); this.items = items; }
  eq(other) { return other instanceof FigureGroupWidget && this.items.length === other.items.length &&
    this.items.every((item, i) => item.eq(other.items[i])); }
  toDOM(view) {
    const dom = view.dom.ownerDocument.createElement('div'); dom.className = 'pcp-figure-group';
    for (const item of this.items) dom.append(item.toDOM(view));
    return dom;
  }
  updateDOM(dom) {
    if (dom.children.length !== this.items.length || this.items.some((item, i) => dom.children[i]._pcpWidget?.renderKey !== item.renderKey)) return false;
    return this.items.every((item, i) => item.updateDOM(dom.children[i]));
  }
  destroy(dom) { for (const child of dom.children) child._pcpDispose?.(); }
  ignoreEvent() { return true; }
}

class ReferenceWidget extends WidgetType {
  constructor(reference, prefix) { super(); this.reference = reference; this.prefix = prefix; }
  eq(other) { return other instanceof ReferenceWidget && other.reference.id === this.reference.id &&
    other.reference.type === this.reference.type && other.reference.number === this.reference.number && other.prefix === this.prefix; }
  toDOM(view) {
    const el = view.dom.ownerDocument.createElement('span'); el.className = 'pcp-reference';
    el.textContent = this.reference.number == null ? '@' + (this.reference.type || 'fig') + ':' + this.reference.id : numberedLabel(this.prefix,this.reference.number);
    if (this.reference.number == null) { el.classList.add('pcp-unresolved-citation'); el.title = '未找到图表或公式标签'; }
    return el;
  }
}

class EqLabelWidget extends WidgetType {
  // Renders the {#eq:id} label line as a right-aligned "（式 N）", Word-style.
  constructor(prefix, number) { super(); this.text = `（${prefix} ${number}）`; }
  eq(other) { return other instanceof EqLabelWidget && other.text === this.text; }
  toDOM(view) {
    const el = view.dom.ownerDocument.createElement('span'); el.className = 'pcp-eq-label';
    el.textContent = this.text; return el;
  }
  ignoreEvent() { return true; }
}

function buildDecorations(plugin, state) {
  if (!state.field(editorLivePreviewField, false) || plugin.disposed || plugin.conflict()) return Decoration.none;
  const info = state.field(editorInfoField, false), file = info?.file;
  if (!file) return Decoration.none;
  const text = state.doc.toString(), parsed = scanDocument(text), widgets = [];
  if (plugin.settings.citations) plugin.citations.ensure(file, text);
  const rawFrontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const frontmatter = {...rawFrontmatter, lang:plugin.languageFor(file,text)==='en'?'en-US':'zh-CN'};
  const prefix = typeof frontmatter?.figPrefix === 'string' ? frontmatter.figPrefix : plugin.settings.prefix;
  const tablePrefix = typeof frontmatter?.tblPrefix === 'string' ? frontmatter.tblPrefix : '表';
  const eqPrefix = typeof frontmatter?.eqnPrefix === 'string' ? frontmatter.eqnPrefix : '式';
  const touches = (from, to) => state.selection.ranges.some(range => range.from <= to && range.to >= from);
  {
    // Raw lines identify real blank lines: maskExamples blanks fenced and indented
    // code, so masked-whitespace lines inside code must never become indent hosts.
    const lines = maskExamples(text).split('\n'), rawLines = text.split('\n');
    const frontmatterBlock = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(text);
    const frontmatterEnd = frontmatterBlock ? frontmatterBlock[0].length : -1;
    // The caret line gets the visual indent while still blank, so pressing Enter
    // shows the two-em gap immediately, with a single or a double Enter alike.
    const caret = state.selection.main?.head ?? state.selection.ranges.at(-1)?.head;
    let caretIndex = -1, caretOffset = 0;
    if (caret != null) for (let i = 0; i < rawLines.length && caretIndex < 0; i++) {
      if (caret <= caretOffset + rawLines[i].length) caretIndex = i;
      caretOffset += rawLines[i].length + 1;
    }
    // Count $$ marks instead of toggling: an inline $$x$$ line must not flip the state.
    // Track fenced code with the same rules as maskExamples so blank lines inside
    // fences are never mistaken for caret paragraph starts.
    let offset = 0, mathMarks = 0, fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(), hasText = !!rawLines[i].trim();
      // content = a real prose line; code lines masked to whitespace have raw text
      // but no masked text and must be skipped entirely.
      const content = hasText && !!line;
      const inMath = mathMarks % 2 === 1, inFence = !!fence;
      mathMarks += (line.match(/\$\$/g) || []).length;
      const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(rawLines[i] || '');
      if (fence) {
        if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(rawLines[i] || '')) fence = null;
      } else if (fenceMark) fence = fenceMark[1];
      const structural = /^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|\||!\[|!\[\[|\{#|:{1,3}(?:\s|$)|<|\$\$|[-*_]{3,}\s*$)/.test(line);
      if (offset>frontmatterEnd && content && !structural && !inMath && !inFence &&
        !parsed.figures.some(f=>offset>=f.from && offset<f.to) && !parsed.tables.some(t=>offset>=t.from && offset<t.to))
        widgets.push(Decoration.line({class:'pcp-prose-line'}).range(offset));
      // A line starts a paragraph when the previous line is blank (or it is the
      // first line). Blank caret lines only indent when typing there would form
      // a real new paragraph, so preview never diverges from what exports show.
      const startsParagraph = i === 0 || !lines[i - 1].trim();
      if (plugin.settings.indentParagraphs && offset > frontmatterEnd && !inMath && !inFence && !structural &&
        (content ? startsParagraph : (startsParagraph && !hasText && i === caretIndex)) &&
        !parsed.figures.some(f => offset >= f.from && offset < f.to) &&
        !parsed.tables.some(t => offset >= t.from && offset < t.to)) {
        widgets.push(Decoration.line({class: 'pcp-paragraph-start'}).range(offset));
      }
      offset += lines[i].length + 1;
    }
  }
  // Warn about blank lines pandoc needs: a missing one turns images inline,
  // kills headings, and turns table captions into definition lists.
  const blankViolations = plugin.settings.blankLineWarnings ? blankLineViolations(text).violations : [];
  if (plugin.settings.blankLineWarnings) {
    for (const violation of blankViolations) {
      if (plugin.settings.quietBlankWarnings && !touches(state.doc.lineAt(violation.from).from, state.doc.lineAt(violation.from).to)) continue;
      widgets.push(Decoration.line({class: 'pcp-blank-warn'}).range(violation.from));
    }
  }
  const figureGroups = new Map();
  for (const figure of parsed.figures) {
    const key = figure.groupFrom;
    if (!figureGroups.has(key)) figureGroups.set(key, []);
    figureGroups.get(key).push(figure);
  }
  for (const group of figureGroups.values()) {
    const visible = group.filter(f => f.id || plugin.settings.showUnlabelled);
    if (!visible.length || visible.length !== group.length) continue;
    const from = group[0].groupFrom, to = group[0].groupTo;
    const lineFrom = state.doc.lineAt(from).from, lineTo = state.doc.lineAt(to).to;
    if (touches(lineFrom, lineTo)) continue;
    const items = visible.map(figure => {
    // Use one image renderer and toolbar for every standalone Markdown figure.
    const rescue = true;
    const blankWarning = !plugin.settings.quietBlankWarnings && blankViolations.some(v => (v.from >= figure.from && v.from <= figure.to) || (v.prev === 'image' && v.from === lineTo + 1));
    const widget = new FigureWidget(plugin, {...figure, rescue, blankWarning, tableNumbers: parsed.tableNumbers, eqNumbers: parsed.eqNumbers}, file, text, prefix, parsed.numbers);
    return widget;
    });
    const widget = items.length === 1 ? items[0] : new FigureGroupWidget(items);
    widgets.push(Decoration.replace({widget, block: true, inclusive: true}).range(from, to));
  }
  if (!plugin.legacy()) for (const table of parsed.tables) {
    const line = state.doc.lineAt(table.from);
    if (touches(line.from, line.to)) continue;
    widgets.push(Decoration.replace({widget: new FigureWidget(plugin,
      {...table, type: 'tbl', rescue: false, tableNumbers: parsed.tableNumbers, eqNumbers: parsed.eqNumbers}, file, text, tablePrefix, parsed.numbers),
      block: true, inclusive: false}).range(table.from, table.to));
  }
  if (!plugin.legacy()) for (const equation of parsed.equations) {
    const line = state.doc.lineAt(equation.from);
    if (touches(line.from, line.to)) continue;
    widgets.push(Decoration.replace({widget: new EqLabelWidget(eqPrefix, equation.number), block: true, inclusive: false})
      .range(equation.from, equation.to));
  }
  if (!plugin.legacy()) for (const reference of parsed.references) {
    if (touches(reference.from, reference.to)) continue;
    widgets.push(Decoration.replace({widget: new ReferenceWidget(reference,
      reference.type === 'tbl' ? tablePrefix : reference.type === 'eq' ? eqPrefix : prefix), inclusive: false})
      .range(reference.from, reference.to));
  }
  return Decoration.set(widgets, true);
}

class CaptionSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl; el.empty();
    this.editLanguage=this.editLanguage || this.plugin.languageFor(this.plugin.markdownView()?.file,this.plugin.markdownView()?.editor?.getValue()||'');
    this.editSettings=this.plugin.appearanceEditor(this.editLanguage);
    el.createEl('h2', {text: 'Paper Writing View'});
    el.classList.add('pcp-settings');
    el.createEl('p', {text: '选择适合自己的论文阅读与写作外观，设置自动保存并应用到全库预览。'});
    new Setting(el).setName('Zotero 与引用配置').setDesc('检查引用插件、Pandoc、文献库和 CSL；Windows 与 macOS 使用同一个插件包，各自配置本机路径。')
      .addButton(b=>b.setButtonText('检查配置').onClick(()=>this.plugin.checkCitationSetup()))
      .addButton(b=>b.setButtonText('打开引用设置').onClick(()=>this.plugin.openCitationSettings()));
    new Setting(el).setName('正在调整的外观').setDesc('中英文各自保存字号、行距、段间距、颜色、图注和表格外观。')
      .addDropdown(d=>d.addOptions({zh:'中文稿样式',en:'英文稿样式'}).setValue(this.editLanguage).onChange(v=>{this.editLanguage=v;this.display();}));
    const preview = el.createDiv({cls: 'pcp-appearance-preview'});
    let useCurrentNote = false;
    new Setting(el).setName('预览内容').addDropdown(d => d.addOptions({sample:'示例排版', current:'当前笔记节选'}).onChange(v => {useCurrentNote=v==='current';drawPreview();}));
    const drawPreview = () => {
      const fm={lang:this.editLanguage==='en'?'en-US':'zh-CN'};
      for (const [key,value] of Object.entries(manuscriptVariables(this.editSettings,fm))) preview.style.setProperty(key,value);
      preview.classList.toggle('pcp-english',manuscriptLanguage(fm)==='en');
      preview.empty(); preview.createDiv({text: '外观预览', cls: 'pcp-preview-label'});
      preview.createEl('p', {text:this.editLanguage==='en'?'Fault activity controls helium migration and accumulation. Helium enrichment (2026) depends on supply and preservation.':'断裂与氦气富集：“源岩—运移—聚集”。Helium 2026，3.4 × 10。'});
      if (useCurrentNote) {
        const view = this.plugin.markdownView(), text = view?.editor?.getValue() || '';
        const paragraphs = maskExamples(text).split(/\r?\n\s*\r?\n/).filter(p=>p.trim() && !/^[!#|:$>{]/.test(p.trim()));
        preview.createEl('p', {text:paragraphs[0]?.slice(0,500) || '请先打开一篇 Markdown 笔记。'});
        const first = scanDocument(text).figures[0], src = first && this.plugin.resolveImage(first.src, view?.file?.path || '');
        if (src) preview.createEl('img', {cls:'pcp-sample-real-image',attr:{src,alt:first.caption}});
        if (first) preview.createDiv({text:first.caption,cls:'pcp-sample-caption'});
      }
      preview.createEl('span', {text: '图1 · 表1 · 式1 ·（作者，2026）', cls: 'pcp-sample-reference'});
      const image = preview.createDiv({cls: 'pcp-sample-image'}); image.setText('图片边界');
      preview.createDiv({text: '图1 氦气成藏模式 · Helium accumulation', cls: 'pcp-sample-caption'});
      const table = preview.createEl('table');
      for (const row of [['样品 Sample','氦含量'],['A','0.10%']]) { const tr = table.createEl('tr'); for (const value of row) tr.createEl('td', {text:value}); }
      const math = preview.createDiv({cls:'pcp-sample-math'});
      if (renderMath) { math.append(renderMath('R = {{}^3\\mathrm{He}} / {{}^4\\mathrm{He}}',true)); finishRenderMath?.(); }
      else math.setText('R = He 同位素比值');
    };
    const appearanceSave = async () => {drawPreview(); this.plugin.applyAppearance(); await this.plugin.saveData(this.plugin.settings);};
    const languageView=this.plugin.markdownView();
    if(languageView?.file) new Setting(el).setName('当前稿件语言').setDesc(languageView.file.basename+'：自动模式优先读取 lang，其次识别正文；手动选择只影响这一篇，并同步导出默认值。')
      .addDropdown(d=>d.addOptions({auto:'自动识别',zh:'中文稿',en:'英文稿'}).setValue(this.editSettings.manuscriptLanguages[languageView.file.path]||'auto').onChange(async value=>{
        if(value==='auto')delete this.editSettings.manuscriptLanguages[languageView.file.path];else this.editSettings.manuscriptLanguages[languageView.file.path]=value;
        await appearanceSave();this.plugin.refresh();this.display();
      }));
    const section = title => {const d=el.createEl('details',{cls:'pcp-settings-section'});d.open=true;d.createEl('summary',{text:title});return d.createDiv();};
    const profiles = section('排版方案');
    let selectedProfile = '', profileName = '';
    const entries = {...Object.fromEntries(Object.keys(BUILTIN_PROFILES).map(n=>['builtin:'+n,n+'（预设）'])),
      ...Object.fromEntries(Object.keys(this.editSettings.appearanceProfiles || {}).map(n=>['saved:'+n,n]))};
    new Setting(profiles).setName('应用方案').addDropdown(d=>d.addOption('','请选择').addOptions(entries).onChange(v=>{selectedProfile=v;}))
      .addButton(b=>b.setButtonText('应用').onClick(async()=>{
        if (!selectedProfile) return;
        const builtin = selectedProfile.startsWith('builtin:'), name=selectedProfile.slice(selectedProfile.indexOf(':')+1);
        const profile = builtin ? {...appearanceSnapshot(DEFAULTS),...BUILTIN_PROFILES[name]} : this.editSettings.appearanceProfiles[name];
        if (!profile) return;
        for (const key of Object.keys(appearanceSnapshot(DEFAULTS))) if (profile[key] !== undefined) this.editSettings[key]=profile[key];
        await appearanceSave();this.plugin.refresh();this.display();
      })).addButton(b=>b.setButtonText('删除自存方案').onClick(async()=>{
        if (!selectedProfile.startsWith('saved:')) return new Notice('只能删除自己保存的方案。');
        delete this.editSettings.appearanceProfiles[selectedProfile.slice(6)];await this.plugin.saveData(this.plugin.settings);this.display();
      }));
    new Setting(profiles).setName('保存当前外观').setDesc('同名方案将更新；预设方案保持可用。')
      .addText(t=>t.setPlaceholder('方案名称').onChange(v=>{profileName=v.trim();}))
      .addButton(b=>b.setButtonText('保存方案').onClick(async()=>{
        if (!profileName || ['__proto__','constructor','prototype'].includes(profileName)) return new Notice('请输入有效的方案名称。');
        this.editSettings.appearanceProfiles={...this.editSettings.appearanceProfiles,[profileName]:appearanceSnapshot(this.editSettings)};
        await this.plugin.saveData(this.plugin.settings);this.display();
      }));
    const fonts = section('字体与正文');
    new Setting(fonts).setName('启用正文外观').setDesc('关闭后由主题控制正文字体、字号、颜色和行距。').addToggle(t=>t.setValue(this.editSettings.wordSpacing).onChange(async v=>{this.editSettings.wordSpacing=v;await appearanceSave();}));
    for (const [key,title,options] of [
      ['chineseFont','中文字体',{'SimSun':'宋体','STSong':'华文宋体','Microsoft YaHei':'微软雅黑','KaiTi':'楷体','SimHei':'黑体'}],
      ['latinFont','西文字体',{'Times New Roman':'Times New Roman','Arial':'Arial','Calibri':'Calibri','Georgia':'Georgia','Cambria':'Cambria'}]]) {
      const opts={...options};opts[this.editSettings[key]]=opts[this.editSettings[key]]||this.editSettings[key];
      new Setting(fonts).setName(title).setDesc('使用本机已安装的字体；也可填写其他字体名。').addDropdown(d=>d.addOptions(opts).setValue(this.editSettings[key]).onChange(async v=>{this.editSettings[key]=v;await appearanceSave();})).addText(t=>t.setPlaceholder('自定义字体名').onChange(async v=>{if(v.trim()){this.editSettings[key]=v.trim();await appearanceSave();}}));
    }
    new Setting(fonts).setName('中文引号、破折号使用宋体').addToggle(t=>t.setValue(this.editSettings.punctuationSong).onChange(async v=>{this.editSettings.punctuationSong=v;await appearanceSave();}));
    new Setting(fonts).setName('正文字号').setDesc('选“跟随 Obsidian”可继续使用外观设置中的字号；px 为屏幕显示大小。').addDropdown(d=>d.addOptions({'0':'跟随 Obsidian',...Object.fromEntries([14,16,18,20,22,24,26,28,30,32].map(n=>[n,n+' px']))}).setValue(String(this.editSettings.bodySize)).onChange(async v=>{this.editSettings.bodySize=Number(v);await appearanceSave();}));
    const slider = (parent,key,title,min,max,step) => new Setting(parent).setName(title).addSlider(s=>s.setLimits(min,max,step).setValue(this.editSettings[key]).setDynamicTooltip().onChange(async v=>{this.editSettings[key]=v;await appearanceSave();}));
    slider(fonts,'bodyLineHeight','正文行距（倍）',1,2.5,0.1);
    const colors = section('文字与引用颜色');
    for (const [toggle,key,title] of [['bodyThemeColor','bodyColor','正文颜色'],['captionThemeColor','captionColorCustom','图表标题颜色']]) {
      new Setting(colors).setName(title+'跟随主题').addToggle(t=>t.setValue(this.editSettings[toggle]).onChange(async v=>{this.editSettings[toggle]=v;await appearanceSave();}));
      new Setting(colors).setName('自定义'+title).setDesc('关闭对应的“跟随主题”后生效。').addColorPicker(c=>c.setValue(this.editSettings[key]).onChange(async v=>{this.editSettings[key]=v;await appearanceSave();}));
    }
    new Setting(colors).setName('文献与图表式引用颜色').addColorPicker(c=>c.setValue(this.editSettings.referenceColor).onChange(async v=>{this.editSettings.referenceColor=v;await appearanceSave();}));
    const layout = section('段落、图注与表格');
    slider(layout,'paragraphGap','段落空行高度（px）',0,24,1);
    slider(layout,'indentSize','首行缩进（字宽）',0,4,0.5);
    slider(layout,'captionScale','图表标题字号（相对正文）',0.7,1.2,0.025);
    slider(layout,'captionLineHeight','图表标题行距（倍）',1,2.5,0.1);
    slider(layout,'tableSize','表格字号（px）',10,24,1);
    slider(layout,'tableLineHeight','表格行距（倍）',1,2,0.1);
    new Setting(el).setName('恢复默认外观').setDesc('恢复字体、颜色和间距，保留引用与写作辅助功能设置。').addButton(b=>b.setButtonText('恢复默认').onClick(async()=>{for(const key of APPEARANCE_KEYS)this.editSettings[key]=DEFAULTS[key];await appearanceSave();this.display();}));
    drawPreview();
    el.createEl('h3',{text:'图片与写作辅助'});
    new Setting(el).setName('安静的空行提醒').setDesc('平时只显示状态栏计数，光标到问题行时才标记；关闭后显示图片提示按钮。')
      .addToggle(t=>t.setValue(this.editSettings.quietBlankWarnings).onChange(async v=>{this.editSettings.quietBlankWarnings=v;await this.plugin.saveData(this.plugin.settings);this.plugin.refresh();}));
    const save = async () => { drawPreview(); await this.plugin.saveData(this.plugin.settings); this.plugin.refresh(); };
    new Setting(el).setName('图片边框颜色').addColorPicker(c => c.setValue(this.editSettings.imageBorderColor).onChange(async value => {this.editSettings.imageBorderColor = value; await save();}));
    new Setting(el).setName('图片边框样式').addDropdown(d => d.addOptions({dashed: '虚线', solid: '实线', dotted: '点线', none: '隐藏'}).setValue(this.editSettings.imageBorderStyle).onChange(async value => {this.editSettings.imageBorderStyle = value; await save();}));
    for (const [key, name, min, max, step] of [['imageBorderWidth', '图片边框粗细（px）', 0.5, 4, 0.5], ['imageGap', '图片附近空行高度（px）', 0, 20, 1], ['captionGap', '图片与图注间距（em）', 0, 1.5, 0.05]]) {
      new Setting(el).setName(name).addSlider(s => s.setLimits(min, max, step).setValue(this.editSettings[key]).setDynamicTooltip().onChange(async value => {this.editSettings[key] = value; await save();}));
    }
    new Setting(el).setName('默认图编号前缀').setDesc('笔记 frontmatter 中的 figPrefix 优先。')
      .addText(t => t.setValue(this.editSettings.prefix).onChange(async value => {
        this.editSettings.prefix = value || '图'; await save();
      }));
    new Setting(el).setName('图注对齐').addDropdown(d => d.addOptions({center: '居中', left: '左对齐'})
      .setValue(this.editSettings.align).onChange(async value => { this.editSettings.align = value; await save(); }));
    new Setting(el).setName('图注加粗').addToggle(t => t.setValue(this.editSettings.bold)
      .onChange(async value => { this.editSettings.bold = value; await save(); }));
    new Setting(el).setName('图片自动居中').setDesc('实时预览和阅读模式中的独立图片自动居中。')
      .addToggle(t => t.setValue(this.editSettings.centerImages).onChange(async value => {
        this.editSettings.centerImages = value; await save();
      }));
    new Setting(el).setName('正文首行缩进两字').setDesc('仅实时预览显示两字缩进，不写入空格，不改变 Markdown 导出内容。')
      .addToggle(t => t.setValue(this.editSettings.indentParagraphs).onChange(async value => {
        this.editSettings.indentParagraphs = value; await save();
      }));
    new Setting(el).setName('压缩段落间空行（Word 式间距）').setDesc('实时预览中正文段落间的空行显示为小间距而非整行空白；代码块内空行与正在编辑的行保持原高度。间距可通过 styles.css 中的 --pcp-blank-gap 调整。')
      .addToggle(t => t.setValue(this.editSettings.compactBlankLines).onChange(async value => {
        this.editSettings.compactBlankLines = value; await save();
      }));
    new Setting(el).setName('缺失空行警告').setDesc('正文或图片紧跟图片、表格、表名、标题时提供标记；安静模式仅标记光标所在的问题行。状态栏可打开修复预览。')
      .addToggle(t => t.setValue(this.editSettings.blankLineWarnings).onChange(async value => {
        this.editSettings.blankLineWarnings = value; await save();
      }));
    new Setting(el).setName('优化表格显示').setDesc('表格引用显示作者—年份；长内容换行，宽表保留横向滚动。')
      .addToggle(t => t.setValue(this.editSettings.optimizeTables).onChange(async value => {
        this.editSettings.optimizeTables = value; await save();
      }));
    new Setting(el).setName('虚假上下标提醒').setDesc('检查正文、标题、表格和图注中的 Unicode 上下标字符。状态栏点击预览并选择修复为 HTML 上下标；不自动修改，不猜测普通数字，跳过代码、公式和链接地址。')
      .addToggle(t => t.setValue(this.editSettings.fakeScriptWarnings).onChange(async value => {
        this.editSettings.fakeScriptWarnings = value; await save();
      }));
    new Setting(el).setName('检查虚假上下标').addButton(b => b.setButtonText('检查与修复').onClick(() => this.plugin.fixFakeScripts()));
    new Setting(el).setName('显示无标签图片的图注').setDesc('无 {#fig:id} 的图片显示图注，但不参与编号。')
      .addToggle(t => t.setValue(this.editSettings.showUnlabelled).onChange(async value => {
        this.editSettings.showUnlabelled = value; await save();
      }));
    new Setting(el).setName('显示作者—年份文献').setDesc('需要 Pandoc Reference List；缺少结果时显示原 citekey。')
      .addToggle(t => t.setValue(this.editSettings.citations).onChange(async value => {
        this.editSettings.citations = value; await save();
      }));
    new Setting(el).setName('检查当前笔记').addButton(b => b.setButtonText('诊断').onClick(() => this.plugin.diagnose()));
    new Setting(el).setName('稿件语言与引用样式').setDesc('检查 lang、当前显示语言和 CSL 是否存在明确冲突。')
      .addButton(b=>b.setButtonText('检查引用样式').onClick(()=>this.plugin.checkCitationLanguage()));
    if (this.plugin.conflict()) el.createEl('p', {text: '检测到未兼容的 Pandoc Live Preview。本插件暂停渲染，请安装附带兼容补丁或停用旧插件。'});
  }
}

module.exports = class PaperCaptionPreview extends Plugin {
  async onload() {
    this.disposed = false;
    this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULTS)), await this.loadData());
    this.imageDimensions = new Map();
    this.nativeImages = new Set();
    this.citations = new CitationBridge(this);
    this.installScopedCitationPaths();
    this.tableOriginals = new Map();
    this.tableObservers = new Map();
    this.tableListener = () => this.queueTables();
    this.citations.listeners.add(this.tableListener);
    this.compatibilityVersion = 1;
    this.field = StateField.define({
      create: state => buildDecorations(this, state),
      update: (previous, transaction) => {
        if (transaction.docChanged || transaction.selection || transaction.reconfigured ||
          transaction.effects.some(effect => effect.is(refreshEffect))) return buildDecorations(this, transaction.state);
        return previous;
      },
      provide: field => EditorView.decorations.from(field)
    });
    this.registerEditorExtension(this.field);
    this.referenceSuggest = new ReferenceSuggest(this.app);
    this.registerEditorSuggest(this.referenceSuggest);
    this.blankStatus = this.addStatusBarItem();
    this.scriptStatus = this.addStatusBarItem();
    this.scriptStatus.classList.add('pcp-script-status');
    this.scriptStatus.setAttribute('role', 'button'); this.scriptStatus.setAttribute('tabindex', '0');
    this.registerDomEvent(this.scriptStatus, 'click', () => this.fixFakeScripts(this.blankStatusView));
    this.registerDomEvent(this.scriptStatus, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); this.fixFakeScripts(this.blankStatusView);}
    });
    this.languageStatus=this.addStatusBarItem();
    this.languageStatus.classList.add('pcp-language-status');
    this.languageStatus.setAttribute('role','button');this.languageStatus.setAttribute('tabindex','0');
    this.registerDomEvent(this.languageStatus,'click',()=>this.selectManuscriptLanguage(this.languageStatusView));
    this.registerDomEvent(this.languageStatus,'keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();this.selectManuscriptLanguage(this.languageStatusView);}});
    this.blankStatus.classList.add('pcp-blank-status');
    this.blankStatus.setAttribute('role', 'button');
    this.blankStatus.setAttribute('tabindex', '0');
    this.registerDomEvent(this.blankStatus, 'click', () => this.fixBlankLines(this.blankStatusView));
    this.registerDomEvent(this.blankStatus, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.fixBlankLines(this.blankStatusView); }
    });
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      globalThis.clearTimeout(this.blankStatusTimer);
      this.blankStatusTimer = globalThis.setTimeout(() => {this.updateBlankStatus(info?.editor && info?.file ? info : undefined);this.applyAppearance();}, 200);
    }));
    this.addSettingTab(new CaptionSettings(this.app, this));
    this.addCommand({id: 'appearance-settings', name: '打开外观设置', callback: () => {
      this.app.setting.open(); this.app.setting.openTabById(this.manifest.id);
    }});
    this.addCommand({id: 'refresh-captions', name: '刷新论文图注', callback: () => {
      this.citations.requests.clear(); this.citations.scopedMaps.clear(); this.refresh();
    }});
    this.addCommand({id: 'fix-blank-lines', name: '补全缺失空行', callback: () => this.fixBlankLines()});
    this.addCommand({id: 'fix-fake-scripts', name: '检查并修复虚假上下标', callback: () => this.fixFakeScripts()});
    this.addCommand({id: 'diagnose-captions', name: '检查当前笔记图注', callback: () => this.diagnose()});
    this.addCommand({id: 'figure-navigation', name: '图表与公式导航', callback: () => this.openNavigation()});
    this.addRibbonIcon?.('list-tree', '图表与公式导航', () => this.openNavigation());
    this.addCommand({id: 'fix-current-blank', name: '补齐光标附近这一处空行', callback: () => this.fixBlankLines(undefined, true)});
    this.addCommand({id:'manuscript-language',name:'选择当前稿件语言',callback:()=>this.selectManuscriptLanguage()});
    this.addCommand({id:'citation-language-check',name:'检查稿件语言与引用样式',callback:()=>this.checkCitationLanguage()});
    this.addCommand({id:'citation-setup',name:'检查 Zotero 与引用配置',callback:()=>this.checkCitationSetup()});
    this.frontmatterSignatures = new Map();
    this.registerEvent(this.app.metadataCache.on('changed', (file, _text, cache) => {
      if (!file) return;
      const fm = cache?.frontmatter || {};
      const signature = JSON.stringify(['figPrefix', 'tblPrefix', 'eqnPrefix', 'bibliography', 'csl', 'citation-style', 'lang', 'cssclasses'].map(k => fm[k]));
      const previous = this.frontmatterSignatures.get(file.path);
      this.frontmatterSignatures.set(file.path, signature);
      if (previous !== undefined && previous !== signature) this.queueRefresh();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => this.queueRefresh()));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const choices=renamedLanguageChoices(this.settings.manuscriptLanguages,oldPath,file.path);
      if(!choices)return;
      this.settings.manuscriptLanguages=choices;
      this.saveData(this.settings).catch(error=>{console.error(error);new Notice('稿件语言选择保存失败，请重新选择。');});
      this.queueRefresh();
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.queueRefresh()));
    this.app.workspace.onLayoutReady(() => { if (!this.disposed) this.refresh(); });
    // Check cache changes without running Pandoc or rereading notes on every tick.
    this.signatures = new Map();
    this.registerInterval(globalThis.setInterval(() => {
      const mode = String(!!this.legacy()) + ':' + String(this.conflict());
      const manager=this.citations.manager();
      if (this.lastMode !== mode || this.scopedCitationManager !== (manager || null)) { this.lastMode = mode; this.refresh(); }
      for (const path of new Set([...this.citations.requests.keys()])) {
        const map = this.citations.map(path), signature = JSON.stringify([...map]);
        if (this.signatures.get(path) !== signature) { this.signatures.set(path, signature); this.citations.notify(path); }
      }
    }, 2000));
    if (this.conflict()) new Notice('Paper Writing View：旧 Pandoc Live Preview 尚未安装兼容补丁，已暂停重复渲染。');
  }
  updateBlankStatus(sourceView) {
    if (this.disposed || !this.blankStatus) return;
    const view = sourceView || this.markdownView();
    this.blankStatusView = view;
    if (this.scriptStatus) {
      this.scriptStatus.style.display = view?.file && view.editor && this.settings.fakeScriptWarnings ? '' : 'none';
      if (view?.file && view.editor && this.settings.fakeScriptWarnings) {
        const count = fakeScriptViolations(view.editor.getValue()).length;
        this.scriptStatus.setText(count ? `虚假上下标 ${count} 处 · 点击检查` : '上下标检查 ✓');
        this.scriptStatus.classList.toggle('pcp-has-script-issues', count > 0);
        this.scriptStatus.setAttribute('aria-label', count ? `发现 ${count} 处虚假上下标，打开修复预览` : '未发现 Unicode 虚假上下标');
        this.scriptStatus.setAttribute('title', view.file.path + '\n检查 Unicode 上下标；不检查普通数字和公式，不会自动修改正文');
      }
    }
    this.languageStatusView=view;
    if(this.languageStatus) {
      this.languageStatus.style.display=view?.file&&view.editor?'':'none';
      if(view?.file&&view.editor){
        const manual=['en','zh'].includes(this.settings.manuscriptLanguages[view.file.path]);
        this.languageStatus.setText((this.languageFor(view.file,view.editor.getValue())==='en'?'英文稿':'中文稿')+' · '+(manual?'手动':'自动'));
        const decision=this.languageDecisionFor(view.file,view.editor.getValue());
        this.languageStatus.setAttribute('title',view.file.path+'\n识别依据：'+decision.source+(decision.uncertain?'；正文较短或中英混排，建议手动确认':'')+'\n点击选择稿件语言');
      }
    }
    if (!view?.file || !view.editor) { this.blankStatus.style.display = 'none'; return; }
    this.blankStatus.style.display = '';
    const count = blankLineViolations(view.editor.getValue()).violations.length;
    this.blankStatus.setText(count ? `缺空行 ${count} 处 · 点击检查` : '空行检查 ✓');
    this.blankStatus.classList.toggle('pcp-has-blank-issues', count > 0);
    this.blankStatus.setAttribute('aria-label', count ? `缺少 ${count} 处空行，打开修复预览` : '未发现缺失空行');
    this.blankStatus.setAttribute('title', view.file.path + '\n点击预览缺失空行；不会自动修改正文');
  }
  legacy() { return this.app.plugins?.plugins['pandoc-live-preview']; }
  markdownView() {
    const active=this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.editor && active?.file) return active;
    const recent=this.app.workspace.getMostRecentLeaf()?.view;
    return recent?.editor && recent?.file ? recent : this.app.workspace.getLeavesOfType('markdown').find(l=>l.view.editor && l.view.file)?.view;
  }
  languageFor(file,text='') {
    return this.languageDecisionFor(file,text).language;
  }
  languageDecisionFor(file,text='') {
    return languageDecision(file?this.app.metadataCache.getFileCache(file)?.frontmatter:{},text,this.settings.manuscriptLanguages?.[file?.path]);
  }
  appearanceEditor(language) {
    return new Proxy(this.settings,{
      get(target,key){return LANGUAGE_APPEARANCE_KEYS.includes(key)?(target.languageAppearance?.[language]?.[key]??target[key]):target[key];},
      set(target,key,value){if(LANGUAGE_APPEARANCE_KEYS.includes(key)){target.languageAppearance ||= {};target.languageAppearance[language] ||= {};target.languageAppearance[language][key]=value;}else target[key]=value;return true;}
    });
  }
  appearanceFor(file,text='') {
    const language=this.languageFor(file,text);
    return {...this.settings,...this.settings.languageAppearance?.[language]};
  }
  selectManuscriptLanguage(sourceView) {
    const view=sourceView || this.markdownView();if(!view)return new Notice('请先打开 Markdown 稿件。');
    const modal=new Modal(this.app),file=view.file;
    modal.contentEl.createEl('h2',{text:'当前稿件语言'});
    const decision=this.languageDecisionFor(file,view.editor.getValue());
    modal.contentEl.createEl('p',{text:'识别依据：'+decision.source+(decision.uncertain?'。正文较短或中英混排，请确认选择。':'')});
    modal.contentEl.createEl('p',{text:file.basename+' · 当前显示：'+(this.languageFor(file,view.editor.getValue())==='en'?'英文稿':'中文稿')});
    for(const [value,title] of [['auto','自动识别（优先 lang，其次正文）'],['zh','中文稿'],['en','英文稿']])
      modal.contentEl.createEl('button',{text:title}).onclick=async()=>{
        if(value==='auto')delete this.settings.manuscriptLanguages[file.path];else this.settings.manuscriptLanguages[file.path]=value;
        await this.saveData(this.settings);this.refresh();modal.close();
      };
    modal.open();return modal;
  }
  async citationLanguageReport(file,text='') {
    const fm=this.app.metadataCache.getFileCache(file)?.frontmatter || {}, language=this.languageFor(file,text);
    const manager=this.citations.manager();
    const style=String(fm['citation-style'] || fm.csl || manager?.plugin?.settings?.cslStylePath || manager?.plugin?.settings?.cslStyleURL || '');
    const issues=[];
    if(!style)issues.push('未找到明确的 CSL，请在稿件属性中指定引用样式。');
    if(/^https?:/i.test(style))issues.push('当前为远程 CSL，本次未下载核验其语言和标点。');
    if(fm.lang && manuscriptLanguage(fm)!==language)issues.push('手动排版语言与笔记 lang 不一致；导出和引用引擎可能采用不同语言。');
    let xml='';
    if(style && !/^https?:/i.test(style))try {
      const base=this.app.vault.adapter.getBasePath().replace(/\\/g,'/'),normalized=style.replace(/\\/g,'/');
      const relative=normalized.toLowerCase().startsWith(base.toLowerCase()+'/')?normalized.slice(base.length+1):normalized;
      if(/^[a-z]:\//i.test(relative)||relative.startsWith('/')) {
        xml=manager?.styleCache?.get(style) || '';
        if(!xml)throw new Error('CSL outside vault is not cached');
      }else xml=await this.app.vault.adapter.read(relative);
    }catch {issues.push('无法读取当前 CSL，请核实样式路径。');}
    const locale=/default-locale=["']([^"']+)/i.exec(xml)?.[1] || '';
    issues.push(...citationStyleIssues(language,xml));
    return {language,style,locale,issues};
  }
  async checkCitationLanguage(sourceView) {
    const view=sourceView || this.markdownView();if(!view)return new Notice('请先打开 Markdown 稿件。');
    const report=await this.citationLanguageReport(view.file,view.editor.getValue());
    const modal=new Modal(this.app);modal.contentEl.createEl('h2',{text:'稿件语言与引用样式'});
    modal.contentEl.createEl('p',{text:(report.language==='en'?'英文稿':'中文稿')+' · CSL：'+(report.style||'未指定')});
    for(const issue of report.issues.length?report.issues:['未发现明确的语言或括号冲突；这不代表已核验期刊全部引用要求。'])modal.contentEl.createEl('p',{text:issue});
    modal.contentEl.createEl('button',{text:'选择稿件语言'}).onclick=()=>{modal.close();this.selectManuscriptLanguage(view);};
    modal.contentEl.createEl('button',{text:'查看笔记属性与 CSL'}).onclick=()=>{modal.close();view.editor.setCursor({line:0,ch:0});view.editor.focus();};
    modal.open();return modal;
  }
  openCitationSettings() {
    const id='obsidian-pandoc-reference-list';
    if(!this.app.plugins.plugins[id])return new Notice('请先在社区插件中安装并启用 Pandoc Reference List。基础排版仍可使用。');
    this.app.setting.open();this.app.setting.openTabById(id);
  }
  async citationSetupReport(view=this.markdownView()) {
    const dependency=this.app.plugins.plugins['obsidian-pandoc-reference-list'];
    const manager=dependency?.bibManager;
    const platform=Platform?.isMacOS?'mac':Platform?.isWin?'win':'';
    const fm=view?.file?this.app.metadataCache.getFileCache(view.file)?.frontmatter || {}:{};
    const config=citationConfiguration(fm,dependency?.settings || {},platform);
    const issues=[];
    if(!dependency)issues.push('未启用 Pandoc Reference List：安装并启用后才能显示作者—年份引用。字体、图片和表格功能不受影响。');
    else {
      issues.push(...config.issues);
      if(!manager?.engine)issues.push('引用引擎尚未就绪，请检查引用插件设置并重新加载。');
      const base=this.app.vault.adapter.getBasePath?.();
      for(const [label,value] of [['文献库',config.bibliography],['CSL',config.style],['Pandoc',config.pandoc]]) {
        if(!value || /^https?:\/\//i.test(value))continue;
        const absolute=/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
        if(!absolute && base && !await this.app.vault.adapter.exists(value.replace(/\\/g,'/')))issues.push(`${label} 在当前库中不存在：${value}`);
        else if(absolute && this.app.vault.adapter.fs?.access) {
          const exists=await new Promise(resolve=>this.app.vault.adapter.fs.access(value,error=>resolve(!error)));
          if(!exists)issues.push(`${label} 文件不存在或无法访问：${value}`);
        }
      }
    }
    const request=view?.file?this.citations.requests.get(view.file.path):null;
    if(request?.error)issues.push('当前笔记的引用渲染失败：'+request.error);
    return {...config,platform,issues,dependency:!!dependency,ready:!!manager?.engine};
  }
  async checkCitationSetup() {
    const view=this.markdownView(),report=await this.citationSetupReport(view);
    const modal=new Modal(this.app);modal.contentEl.createEl('h2',{text:'Zotero 与引用配置'});
    modal.contentEl.createEl('p',{text:'Paper Writing View 复用 Pandoc Reference List 的数据；不会修改 Zotero 全局设置，也不需要 Word 导出插件。'});
    for(const [label,value] of [['当前笔记',view?.file?.path],['文献库',report.bibliography],['CSL',report.style],['Pandoc',report.pandoc]])modal.contentEl.createEl('p',{text:label+'：'+(value||'未指定')});
    for(const issue of report.issues.length?report.issues:['基础配置已就绪。该检查不代表每条引用或所有期刊要求均已核验。'])modal.contentEl.createEl('p',{text:issue});
    modal.contentEl.createEl('p',{text:'推荐使用 Better BibTeX 导出的 .bib，并开启自动导出。选择 .bib 文件时，预览不要求 Zotero 一直运行；更新文库仍需 Zotero。Windows 与 Mac 的绝对路径不可直接互用，库内相对路径更便于同步。'});
    modal.contentEl.createEl('button',{text:'打开引用插件设置'}).onclick=()=>{modal.close();this.openCitationSettings();};
    modal.contentEl.createEl('button',{text:'重新检查'}).onclick=()=>{modal.close();this.checkCitationSetup();};
    modal.contentEl.createEl('button',{text:'刷新当前引用'}).onclick=()=>{this.citations.requests.clear();this.citations.scopedMaps.clear();this.refresh();new Notice('已重新请求引用；若仍显示 citekey，请检查文库中是否存在对应键。');};
    modal.contentEl.createEl('button',{text:'检查 Zotero 连接（可选）'}).onclick=async event=>{
      const button=event.currentTarget;button.disabled=true;
      try {const response=await requestUrl({url:'http://127.0.0.1:23119/connector/ping',throw:false});new Notice(response.status===200?'Zotero 本机连接正常。此检查不验证 Better BibTeX 或文献完整性。':'Zotero 未返回正常响应；使用本地 .bib 时仍可预览引用。');}
      catch {new Notice('未连接到 Zotero。请确认 Zotero 已启动；本地 .bib 预览不依赖此连接。');}
      finally {button.disabled=false;}
    };
    modal.open();return modal;
  }
  installScopedCitationPaths() {
    const manager=this.citations.manager(),base=this.app.vault?.adapter?.getBasePath?.();
    if(manager && this.scopedCitationManager===manager)return;
    this.restoreScopedCitationPaths?.();
    this.scopedCitationManager=null;
    if(!manager?.loadScopedEngine || !base) return;
    const original=manager.loadScopedEngine;
    const wrapped=function(settings) {
      if(!settings)return original.call(this,settings);
      const resolved={...settings};
      for(const key of ['style','bibliography']) {
        const value=resolved[key];
        if(typeof value==='string' && value && !/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(value))resolved[key]=base+'/'+value;
      }
      return original.call(this,resolved);
    };
    manager.loadScopedEngine=wrapped;
    this.scopedCitationManager=manager;
    this.restoreScopedCitationPaths=()=>{if(manager.loadScopedEngine===wrapped)manager.loadScopedEngine=original;};
    for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const file=leaf.view.file;
      if(file)manager.fileCache?.delete(file);
    }
  }
  enhanceNativeImages() {
    for (const host of this.nativeImages) if (!host.isConnected) this.nativeImages.delete(host);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const root=leaf.view.containerEl;
      for (const host of root.querySelectorAll('.image-embed')) {
        if (!host.querySelector('img') || host.closest('.pcp-figure') || host.querySelector('.pcp-native-toolbar')) continue;
        host.classList.add('pcp-unified-native'); host.closest('.cm-embed-block')?.classList.add('pcp-unified-block'); this.nativeImages.add(host);
        const toolbar=host.ownerDocument.createElement('span');toolbar.className='pcp-image-toolbar pcp-native-toolbar';
        const button=(title,icon,run)=>{
          const b=host.ownerDocument.createElement('button');b.type='button';b.title=title;b.setAttribute('aria-label',title);setIcon(b,icon);
          b.addEventListener('mousedown',e=>e.preventDefault());
          b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();run();});toolbar.append(b);
        };
        button('放大预览','zoom-in',()=>{const image=host.querySelector('img');if(image?.src)this.previewImage(image.src,image.alt);});
        button('查看源码','code',()=>{
          const native=(host.closest('.cm-embed-block') || host).querySelector('.edit-block-button');
          if(native) {native.click();return;}
          const cm=leaf.view.editor?.cm;
          if(cm) {try {const pos=cm.posAtDOM(host);cm.dispatch({selection:{anchor:pos},scrollIntoView:true});cm.focus();}catch {new Notice('请切换到编辑模式查看此图片源码。');}}
          else new Notice('请切换到编辑模式查看此图片源码。');
        });
        host.append(toolbar);
      }
    }
  }
  openNavigation() {
    const view=this.markdownView();
    if(!view) return new Notice('请先打开 Markdown 笔记。');
    const path=view.file.path, modal=new Modal(this.app);
    modal.modalEl.classList.add('pcp-navigation-modal');
    modal.contentEl.createEl('h2',{text:'图表与公式导航'});
    modal.contentEl.createEl('p',{text:path});
    const search=modal.contentEl.createEl('input',{attr:{type:'search',placeholder:'搜索标题、标签、路径或问题'}});
    const list=modal.contentEl.createDiv({cls:'pcp-navigation-list'});
    const draw=()=>{
      list.empty();if(view.file?.path!==path){list.setText('笔记已切换，请重新打开导航。');return;}
      const text=view.editor.getValue(), parsed=scanDocument(text);
      const issues=documentIssues(text,src=>this.resolveImage(src,path));
      const rows=[...imageInventory(text).map(f=>({...f,type:'图',title:f.caption||f.src})),
        ...parsed.tables.map(f=>({...f,type:'表',title:f.caption})),...parsed.equations.map(f=>({...f,type:'式',title:f.id})),
        ...issues.map(f=>({...f,type:'需核实',title:f.message}))].sort((a,b)=>a.from-b.from);
      const query=search.value.trim().toLocaleLowerCase();
      const filtered=rows.filter(r=>[r.title,r.id,r.src,r.type].join(' ').toLocaleLowerCase().includes(query));
      if(!filtered.length)list.createEl('p',{text:'没有匹配的图表、公式或问题。'});
      for(const row of filtered) new Setting(list).setName(`${row.type}${row.number??''} · ${row.title}`).setDesc(`第 ${text.slice(0,row.from).split('\n').length} 行${row.id?' · '+row.id:''}`)
        .addButton(b=>b.setButtonText('跳转').onClick(()=>{
          if(view.file?.path!==path || view.editor.getValue()!==text) {draw();return new Notice('笔记已变化，已刷新导航，请重新选择。');}
          modal.close();const pos=view.editor.offsetToPos(row.from);view.editor.setCursor(pos);view.editor.scrollIntoView({from:pos,to:pos},true);view.editor.focus();
        }));
    };
    search.oninput=draw;modal.contentEl.createEl('button',{text:'刷新列表'}).onclick=draw;draw();modal.open();return modal;
  }
  ownsRange(text, start, end) {
    if (this.rangeText !== text) { this.rangeText = text; this.rangeFigures = scanDocument(text).figures; }
    return this.rangeFigures.some(figure => start >= figure.from && end <= figure.to);
  }
  conflict() { const legacy = this.legacy(); return !!legacy && legacy.paperCaptionCompatibility !== 1; }
  queueRefresh() { globalThis.clearTimeout(this.refreshTimer); this.refreshTimer = globalThis.setTimeout(() => this.refresh(), 200); }
  queueTables() {
    globalThis.clearTimeout(this.tableTimer);
    this.tableTimer = globalThis.setTimeout(() => this.renderTables(), 100);
  }
  restoreTableCitations(root) {
    for (const [span, raw] of this.tableOriginals) {
      if (root && !root.contains(span)) continue;
      if (span.isConnected) span.replaceWith(span.ownerDocument.createTextNode(raw));
      this.tableOriginals.delete(span);
    }
  }
  renderTables() {
    if (this.disposed) return;
    this.enhanceNativeImages();
    for (const [span] of this.tableOriginals) if (!span.isConnected) this.tableOriginals.delete(span);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view, root = view.containerEl;
      if (!this.settings.optimizeTables || !this.settings.citations) { this.restoreTableCitations(root); continue; }
      // Never modify active cell editors: their raw text belongs to CodeMirror.
      const tables = [...root.querySelectorAll('.cm-content table, .markdown-preview-view table')];
      if (!tables.length || !view.file) continue;
      const text = view.editor?.getValue() || '';
      this.citations.ensure(view.file, text);
      const map = this.citations.map(view.file.path);
      for (const table of tables) {
        for (const span of table.querySelectorAll('.pcp-table-citation')) {
          const raw = this.tableOriginals.get(span), citation = map.get(raw);
          if (citation && span.dataset.rendered !== citation.value) {
            span.replaceChildren(sanitizeHTMLToDom(citation.value)); span.dataset.rendered = citation.value;
          }
        }
        const cells = table.classList.contains('table-editor') ? table.querySelectorAll('.table-cell-wrapper') : table.querySelectorAll('td, th');
        for (const cell of cells) {
          if (cell.matches('[contenteditable="true"]') || cell.closest('.cm-editor') !== table.closest('.cm-editor') ||
            cell.querySelector('.cm-editor, [contenteditable="true"]')) continue;
          const walker = cell.ownerDocument.createTreeWalker(cell, 4), nodes = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.parentElement.closest('a, code, pre, .pcp-table-citation') && node.nodeValue.includes('[@')) nodes.push(node);
          }
          for (const node of nodes) {
            const matches = [...node.nodeValue.matchAll(/\[@[^\]\r\n]+\]/g)].filter(m => map.has(m[0]));
            if (!matches.length) continue;
            const fragment = cell.ownerDocument.createDocumentFragment(); let offset = 0;
            for (const match of matches) {
              fragment.append(cell.ownerDocument.createTextNode(node.nodeValue.slice(offset, match.index)));
              const citation = map.get(match[0]), span = cell.ownerDocument.createElement('span');
              span.className = 'pcp-citation pcp-table-citation'; span.title = match[0];
              span.dataset.rendered = citation.value; span.dataset.citekey = citation.keys.join('|');
              span.append(sanitizeHTMLToDom(citation.value));
              this.tableOriginals.set(span, match[0]); fragment.append(span); offset = match.index + match[0].length;
            }
            fragment.append(cell.ownerDocument.createTextNode(node.nodeValue.slice(offset))); node.replaceWith(fragment);
          }
        }
      }
    }
  }
  applyAppearance() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const root = leaf.view.containerEl;
      let changed=root.classList.contains('pcp-word-spacing')!==!!this.settings.wordSpacing;
      root.classList.toggle('pcp-word-spacing', this.settings.wordSpacing);
      const fm={lang:this.languageFor(leaf.view.file,leaf.view.editor?.getValue()||'')==='en'?'en-US':'zh-CN'};
      changed ||= root.classList.contains('pcp-english')!==(fm.lang==='en-US');
      root.classList.toggle('pcp-english',manuscriptLanguage(fm)==='en');
      for (const [key,value] of Object.entries(manuscriptVariables(this.appearanceFor(leaf.view.file,leaf.view.editor?.getValue()||''),fm))) {
        if(root.style.getPropertyValue(key)!==value){root.style.setProperty(key,value);changed=true;}
      }
      if(changed)leaf.view.editor?.cm?.requestMeasure?.();
    }
  }
  refresh() {
    if (this.disposed) return;
    this.installScopedCitationPaths();
    this.updateBlankStatus();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      leaf.view.containerEl.classList.add('pcp-preview-scope');
      leaf.view.containerEl.classList.toggle('pcp-center-images', this.settings.centerImages);
      leaf.view.containerEl.classList.toggle('pcp-indent-paragraphs', this.settings.indentParagraphs);
      leaf.view.containerEl.classList.toggle('pcp-optimize-tables', this.settings.optimizeTables);
      leaf.view.containerEl.classList.toggle('pcp-compact-blanks', this.settings.compactBlankLines);
      leaf.view.containerEl.classList.toggle('pcp-blank-warn-on', this.settings.blankLineWarnings);
      leaf.view.containerEl.classList.toggle('pcp-word-spacing', this.settings.wordSpacing);
      leaf.view.containerEl.classList.toggle('pcp-quiet-blanks', this.settings.quietBlankWarnings);
      const root = leaf.view.containerEl;
      const fm={lang:this.languageFor(leaf.view.file,leaf.view.editor?.getValue()||'')==='en'?'en-US':'zh-CN'};
      root.classList.toggle('pcp-english',manuscriptLanguage(fm)==='en');
      for (const [key,value] of Object.entries(manuscriptVariables(this.appearanceFor(leaf.view.file,leaf.view.editor?.getValue()||''),fm))) root.style.setProperty(key,value);
      if (!this.tableObservers.has(root)) {
        const observer = new MutationObserver(() => this.queueTables());
        observer.observe(root, {childList: true, subtree: true, characterData: true});
        this.tableObservers.set(root, observer);
        // Restore display-only replacements before the native table enters editing/copying.
        const restore = event => { const table = event.target.closest?.('table'); if (table) this.restoreTableCitations(table); };
        this.registerDomEvent(root, 'pointerdown', restore, true);
        this.registerDomEvent(root, 'focusin', restore, true);
        this.registerDomEvent(root, 'copy', restore, true);
        // CodeMirror otherwise copies the underlying source selection of a replaced widget.
        this.registerDomEvent(root, 'copy', event => {
          const selection = root.ownerDocument.getSelection();
          const parent = node => node?.nodeType === 1 ? node : node?.parentElement;
          const caption = parent(selection?.anchorNode)?.closest('.pandoc-def, .pcp-caption');
          if (!caption || !root.contains(caption) || !caption.contains(selection.focusNode) ||
            selection.isCollapsed || !event.clipboardData) return;
          event.clipboardData.setData('text/plain', selection.toString());
          event.preventDefault(); event.stopPropagation();
        }, true);
      }
      const cm = leaf.view.editor?.cm;
      if (cm?.dispatch && cm.state) cm.dispatch({effects: refreshEffect.of(null), selection: cm.state.selection});
    }
    for (const [root, observer] of this.tableObservers) if (!root.isConnected) { observer.disconnect(); this.tableObservers.delete(root); }
    this.queueTables();
  }
  resolveImage(src, sourcePath) {
    if (/^https?:\/\//i.test(src)) return src;
    if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return null;
    let link = src.split('#')[0];
    try { link = decodeURIComponent(link); } catch { /* Preserve malformed literal paths. */ }
    const file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    return file && file.extension !== 'md' ? this.app.vault.getResourcePath(file) : null;
  }
  previewImage(src, alt) {
    const modal = new Modal(this.app);
    modal.modalEl.classList.add('pcp-image-modal');
    const controls = modal.contentEl.createDiv({cls: 'pcp-zoom-controls'});
    const viewport = modal.contentEl.createDiv({cls: 'pcp-image-viewport'});
    const image = viewport.createEl('img', {attr: {src, alt}});
    let zoom = 1;
    const change = value => {
      zoom = Math.min(5, Math.max(0.25, value));
      image.style.maxWidth = zoom === 1 ? '100%' : 'none';
      image.style.width = zoom === 1 ? 'auto' : `${image.naturalWidth * zoom}px`;
      image.style.maxHeight = zoom === 1 ? '75vh' : 'none';
    };
    controls.createEl('button', {text: '缩小'}).onclick = () => change(zoom / 1.25);
    controls.createEl('button', {text: '放大'}).onclick = () => change(zoom * 1.25);
    controls.createEl('button', {text: '适应窗口'}).onclick = () => change(1);
    controls.createEl('button', {text: '关闭'}).onclick = () => modal.close();
    modal.open();
  }
  fixFakeScripts(sourceView) {
    const view = sourceView || this.markdownView();
    if (!view?.file || !view.editor) return new Notice('请先打开 Markdown 笔记。');
    const editor = view.editor, text = editor.getValue(), path = view.file.path;
    const issues = fakeScriptViolations(text);
    if (!issues.length) return new Notice('未发现 Unicode 虚假上下标 ✓（不检查普通数字和公式）');
    const modal = new Modal(this.app), selected = new Set(issues), lines = text.split('\n');
    modal.modalEl.classList.add('pcp-review-modal');
    modal.contentEl.createEl('h2', {text: '预览虚假上下标修复'});
    modal.contentEl.createEl('p', {text: `发现 ${issues.length} 处。将字符转换为真正的 HTML 上下标；选择后修复并更新时间字段，可一次撤销。代码、公式、链接地址、citekey 和图表标签保持原样。`});
    const apply = chosen => {
      if (!chosen.length) return new Notice('请先选择需要修复的位置。');
      if (view.file?.path !== path || editor.getValue() !== text) return new Notice('笔记已变化，请关闭后重新检查，避免改错位置。');
      if (!editor.cm?.dispatch) return new Notice('当前编辑器不支持批量撤销，未修改笔记。');
      const now = new Date(), pad = n => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      editor.cm.dispatch({changes: fakeScriptEdits(text, chosen, timestamp)});
      this.updateBlankStatus(view);
      modal.close(); new Notice(`已修复 ${chosen.length} 处虚假上下标（可 Ctrl+Z / Cmd+Z 撤销）`);
    };
    const list = modal.contentEl.createDiv({cls: 'pcp-review-list'});
    for (const issue of issues) {
      const row = list.createDiv({cls: 'pcp-review-row'}), label = row.createEl('label');
      const check = label.createEl('input', {attr: {type: 'checkbox'}}); check.checked = true;
      check.onchange = () => check.checked ? selected.add(issue) : selected.delete(issue);
      label.appendText(` 第 ${issue.line+1} 行，第 ${issue.column+1} 列：${issue.original} → ${issue.replacement}`);
      row.createEl('pre', {text: lines[issue.line]});
      row.createEl('button', {text: '仅修此处'}).onclick = () => apply([issue]);
      row.createEl('button', {text: '定位'}).onclick = () => {
        modal.close(); editor.setSelection(editor.offsetToPos(issue.from), editor.offsetToPos(issue.to)); editor.focus();
      };
    }
    const controls = modal.contentEl.createDiv({cls: 'pcp-zoom-controls'});
    controls.createEl('button', {text: '修复所选'}).onclick = () => apply([...selected]);
    controls.createEl('button', {text: '全部修复'}).onclick = () => apply(issues);
    controls.createEl('button', {text: '取消'}).onclick = () => modal.close();
    modal.open(); return modal;
  }
  fixBlankLines(sourceView, currentOnly = false) {
    const view = sourceView || this.markdownView();
    if (!view?.file || !view.editor) return new Notice('请先打开 Markdown 笔记。');
    const editor = view.editor;
    const text = editor.getValue(), path = view.file.path;
    let violations = blankLineViolations(text).violations;
    if(currentOnly && violations.length) {
      const line=editor.getCursor().line;
      const nearest=violations.reduce((a,b)=>Math.abs(b.line-line)<Math.abs(a.line-line)?b:a);
      if(Math.abs(nearest.line-line)>1)return new Notice('光标附近没有缺失空行，请将光标移到图片或相邻正文行。');
      violations=[nearest];
    }
    if (!violations.length) return new Notice('未发现缺失的空行 ✓');
    const modal = new Modal(this.app), selected = new Set(violations), lines = text.split('\n');
    modal.modalEl.classList.add('pcp-review-modal');
    modal.contentEl.createEl('h2', {text: '预览缺失空行'});
    modal.contentEl.createEl('p', {text: `发现 ${violations.length} 处。选择后补齐；正文与引用保持原位，并更新时间字段。一次撤销可恢复。`});
    const apply = chosen => {
      if (!chosen.length) return new Notice('请先选择需要补齐的位置。');
      if (view.file?.path !== path || editor.getValue() !== text) return new Notice('笔记已变化，请关闭后重新检查，避免改错位置。');
      if (!editor.cm?.dispatch) return new Notice('当前编辑器不支持批量撤销，未修改笔记。');
      const now = new Date(), pad = n => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      editor.cm.dispatch({changes: blankLineEdits(text, chosen, timestamp)});
      this.updateBlankStatus();
      modal.close(); new Notice(`已补全 ${chosen.length} 处缺失空行（可 Ctrl+Z 撤销）`);
    };
    const names = {prose: '正文', image: '图片', tablecap: '表名', tablerow: '表格', heading: '标题'};
    const list = modal.contentEl.createDiv({cls: 'pcp-review-list'});
    for (const v of violations) {
      const row = list.createDiv({cls: 'pcp-review-row'});
      const label = row.createEl('label'), check = label.createEl('input', {attr: {type: 'checkbox'}}); check.checked = true;
      check.onchange = () => check.checked ? selected.add(v) : selected.delete(v);
      label.appendText(` 第 ${v.line+1} 行：${names[v.prev]}后直接跟${names[v.cur]}`);
      row.createEl('pre', {text: lines.slice(Math.max(0,v.line-1), v.line+1).join('\n')});
      row.createEl('button', {text: '仅补此处'}).onclick = () => apply([v]);
      row.createEl('button', {text: '定位'}).onclick = () => { modal.close(); editor.setCursor(editor.offsetToPos(v.from)); editor.focus(); };
    }
    const controls = modal.contentEl.createDiv({cls: 'pcp-zoom-controls'});
    controls.createEl('button', {text: '补齐所选'}).onclick = () => apply([...selected]);
    controls.createEl('button', {text: '全部补齐'}).onclick = () => apply(violations);
    controls.createEl('button', {text: '取消'}).onclick = () => modal.close();
    modal.open(); return modal;
  }
  diagnose() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) || this.app.workspace.getMostRecentLeaf()?.view;
    if (!view?.file || !view.editor) return new Notice('请先打开 Markdown 笔记。');
    const parsed = scanDocument(view.editor.getValue()), modal = new Modal(this.app);
    modal.contentEl.createEl('h2', {text: '论文图注诊断'});
    modal.contentEl.createEl('p', {text: `可预览图片：${parsed.figures.length}；带编号：${parsed.figures.filter(f => f.id).length}。`});
    modal.contentEl.createEl('p', {text: this.conflict() ? '旧插件兼容补丁缺失，当前暂停渲染。' : '渲染兼容检查通过。'});
    modal.contentEl.createEl('p', {text: this.citations.manager() ? 'Pandoc Reference List 已连接。' : '未连接引用插件，引用保留源码。'});
    const issues = documentIssues(view.editor.getValue(), src => this.resolveImage(src, view.file.path));
    modal.contentEl.createEl('p', {text: `需核实事项：${issues.length}。远程图片仅检查地址形式，不保证网络可访问。`});
    for (const issue of issues) {
      new Setting(modal.contentEl).setName(`第 ${issue.line} 行 · ${issue.message}`).addButton(b => b.setButtonText('定位').onClick(() => {
        modal.close(); view.editor.setCursor(view.editor.offsetToPos(issue.from)); view.editor.focus();
      }));
    }
    for (const figure of parsed.figures) modal.contentEl.createEl('p', {
      text: `${figure.number ?? '无编号'} · ${figure.src} · ${this.resolveImage(figure.src, view.file.path) ? '路径可解析' : '路径缺失/不支持'}`
    });
    modal.open(); return modal;
  }
  onunload() {
    this.restoreScopedCitationPaths?.();
    this.disposed = true; globalThis.clearTimeout(this.refreshTimer); globalThis.clearTimeout(this.tableTimer);
    globalThis.clearTimeout(this.blankStatusTimer);
    for (const host of this.nativeImages) { host.querySelector('.pcp-native-toolbar')?.remove();host.classList.remove('pcp-unified-native');host.closest('.cm-embed-block')?.classList.remove('pcp-unified-block'); }
    this.nativeImages.clear(); this.imageDimensions.clear();
    for (const observer of this.tableObservers.values()) observer.disconnect();
    this.tableObservers.clear(); this.restoreTableCitations(); this.citations.clear();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      leaf.view.containerEl.classList.remove('pcp-preview-scope', 'pcp-center-images', 'pcp-optimize-tables', 'pcp-compact-blanks', 'pcp-blank-warn-on', 'pcp-word-spacing', 'pcp-quiet-blanks', 'pcp-english', 'pcp-indent-paragraphs');
      for (const key of Object.keys(appearanceVariables(this.settings))) leaf.view.containerEl.style.removeProperty(key);
    }
    // Legacy plugin recomputes on selection transactions when this plugin is unloaded.
    globalThis.setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const cm = leaf.view.editor?.cm;
        if (cm?.dispatch && cm.state) cm.dispatch({selection: cm.state.selection});
      }
    }, 0);
  }
};
