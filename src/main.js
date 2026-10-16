'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, Modal, MarkdownView, EditorSuggest,
  editorInfoField, editorLivePreviewField, sanitizeHTMLToDom, setIcon, renderMath, finishRenderMath, Platform, requestUrl} = require('obsidian');
const {StateField, StateEffect, EditorState} = require('@codemirror/state');
const {Decoration, EditorView, WidgetType} = require('@codemirror/view');
const {scanDocument, imageInventory, citationMap, maskExamples, blankLineViolations, referenceItems, documentIssues, blankLineEdits, fakeScriptViolations, fakeScriptEdits, performanceDecision,
  captionTargets, captionTranslationPlan, protectCaption, captionTranslationRequest, validateCaptionTranslation, captionTranslationEdits,
  captionBatchRequest, parseCaptionBatch, captionBatchEdits, translationBase, translationFailure,captionHandoff,importCaptionHandoff} = require('./core');

const refreshEffect = StateEffect.define();
const DEFAULTS = {prefix: '图', align: 'center', bold: false, showUnlabelled: true, citations: true, centerImages: true, optimizeTables: true, indentParagraphs: true, compactBlankLines: true, blankLineWarnings: true, wordSpacing: true,
  imageBorderColor: '#e53935', imageBorderWidth: 1.5, imageBorderStyle: 'dashed', imageGap: 4, captionGap: 0.65,
  chineseFont: 'SimSun', latinFont: 'Times New Roman', punctuationSong: true, bodySize: 0, bodyLineHeight: 1.5,
  bodyThemeColor: true, bodyColor: '#222222', referenceColor: '#3498db', captionThemeColor: true, captionColorCustom: '#222222',
  paragraphGap: 10, indentSize: 2, captionScale: 0.875, captionLineHeight: 1.65, tableSize: 12, tableLineHeight: 1,
  quietBlankWarnings: true, fakeScriptWarnings: true, performanceMode: 'auto', appearanceProfiles: {}, manuscriptLanguages: {}, languageAppearance: {},
  translationEndpoint: 'https://api.openai.com/v1', translationModel: '', translationReasoning:'default'};

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
  const body=maskExamples(text.slice(0,30000)).replace(/!\[[\s\S]*?\]\([^\r\n]*?\)(?:\{[^}]*\})?/g,'').replace(/!\[\[[^\]]*\]\]/g,'')
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
  const tokens = text.split(/(<\/?(?:sub|sup|em|strong|i|b)>|==|\[@[^\]\r\n]+\]|\[-@(?:fig|tbl|eq):[\w:-]+\]|-?@(?:fig|tbl|eq):[\w:-]+)/gi);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const open = /^<(sub|sup|em|strong|i|b)>$/i.exec(token);
    const close = /^<\/(sub|sup|em|strong|i|b)>$/i.exec(token);
    const ref = /^@(fig|tbl|eq):([\w:-]+)$/.exec(token);
    const bare = /^\[-@(fig|tbl|eq):([\w:-]+)\]$/.exec(token) || /^-@(fig|tbl|eq):([\w:-]+)$/.exec(token);
    const citation = options.citations?.get(token);
    if (token === '==' && stack.at(-1).tagName === 'MARK') stack.pop();
    else if (token === '==' && tokens.slice(index + 1).includes('==')) {
      const mark = doc.createElement('mark'); stack.at(-1).append(mark); stack.push(mark);
    } else if (ref || bare) {
      const type = ref ? ref[1] : bare[1], id = ref ? ref[2] : bare[2];
      const number = (type === 'fig' ? options.numbers : type === 'tbl' ? options.tableNumbers : options.eqNumbers)?.get(id);
      const label = type === 'fig' ? options.prefix || '图' : type === 'tbl' ? options.tablePrefix || '表' : options.eqPrefix || '式';
      const span = doc.createElement('span'); span.className = 'pcp-reference';
      span.textContent = number == null ? token : bare ? String(number) : numberedLabel(label, number);
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
    if (this.plugin.isLiteFile(file)) return;
    if (this.plugin.largePending?.has(file?.path)) return;
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
      figure.type, figure.rescue, figure.blankWarning, figure.captionDiv, prefix, [...numbers || []],
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
    this.domPeer = previous;
    return true;
  }
  toDOM(view) {
    const doc = view.dom.ownerDocument, wrap = doc.createElement(this.figure.rescue ? 'figure' : 'span');
    wrap.className = this.figure.rescue ? 'pcp-figure' : 'pcp-figure pcp-caption-only'; wrap.dataset.figureId = this.figure.id || '';
    wrap._pcpWidget = this;
    this.domPeer = this;
    if (this.figure.type === 'tbl') wrap.classList.add('pcp-table-caption');
    if (this.figure.captionDiv) { wrap.classList.add('pcp-caption-div'); wrap.dataset.customStyle = this.figure.captionDiv; }
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
    image.loading = 'lazy'; image.decoding = 'async';
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
    if (this.figure.captionDiv && /(?:^|[\s_-])EN(?:$|[\s_-])/i.test(this.figure.captionDiv))
      caption.style.fontFamily = JSON.stringify(appearance.latinFont || DEFAULTS.latinFont) + ', serif';
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
    wrap.title = this.figure.captionDiv ? '点击编辑题注源码' : this.figure.type === 'tbl' ? '选择表名后可复制；点击编辑源码' : '双击图片放大预览；点击图注编辑源码';
    return wrap;
  }
  destroy(dom) { dom._pcpDispose?.(); }
  ignoreEvent() { return true; }
}

class FigureGroupWidget extends WidgetType {
  constructor(items, captions = []) { super(); this.items = items; this.captions = captions; }
  eq(other) { return other instanceof FigureGroupWidget && this.items.length === other.items.length &&
    this.captions.length===other.captions.length && this.captions.every((c,i)=>c ? c.eq(other.captions[i]) : !other.captions[i]) &&
    this.items.every((item, i) => item.eq(other.items[i])); }
  toDOM(view) {
    const dom = view.dom.ownerDocument.createElement('div'); dom.className = 'pcp-figure-group';
    for (const [i,item] of this.items.entries()) {
      const child=item.toDOM(view);
      if(this.captions[i]) child.append(this.captions[i].toDOM(view));
      dom.append(child);
    }
    return dom;
  }
  updateDOM(dom) {
    if(this.captions.some(Boolean)) return false;
    if (dom.children.length !== this.items.length || this.items.some((item, i) => dom.children[i]._pcpWidget?.renderKey !== item.renderKey)) return false;
    return this.items.every((item, i) => item.updateDOM(dom.children[i]));
  }
  destroy(dom) { for (const child of dom.children) child._pcpDispose?.(); }
  ignoreEvent() { return true; }
}

class ReferenceWidget extends WidgetType {
  constructor(reference, prefix) { super(); this.reference = reference; this.prefix = prefix; }
  eq(other) { return other instanceof ReferenceWidget && other.reference.id === this.reference.id &&
    other.reference.type === this.reference.type && other.reference.number === this.reference.number &&
    !!other.reference.numberOnly === !!this.reference.numberOnly && other.reference.raw === this.reference.raw && other.prefix === this.prefix; }
  toDOM(view) {
    const el = view.dom.ownerDocument.createElement('span'); el.className = 'pcp-reference';
    if (this.reference.number == null) {
      el.textContent = this.reference.raw || ((this.reference.numberOnly ? '[-@' : '@') + (this.reference.type || 'fig') + ':' + this.reference.id
        + (this.reference.numberOnly ? ']' : ''));
      el.classList.add('pcp-unresolved-citation'); el.title = '未找到图表或公式标签';
    } else el.textContent = this.reference.numberOnly ? String(this.reference.number) : numberedLabel(this.prefix, this.reference.number);
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
  if (plugin.performanceFor(state.doc,file).lite) return Decoration.none;
  const analysis = plugin.documentAnalysis(state.doc), {text, parsed} = analysis, widgets = [];
  plugin.rememberSize(file, state.doc, analysis.imageCount);
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
    const {lines, rawLines} = analysis;
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
    let offset = 0, mathMarks = 0, fence = null, figureIndex = 0, tableIndex = 0, captionIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      while (figureIndex < parsed.figures.length && parsed.figures[figureIndex].to <= offset) figureIndex++;
      while (tableIndex < parsed.tables.length && parsed.tables[tableIndex].to <= offset) tableIndex++;
      const inFigure = parsed.figures[figureIndex]?.from <= offset && offset < parsed.figures[figureIndex].to;
      const inTable = parsed.tables[tableIndex]?.from <= offset && offset < parsed.tables[tableIndex].to;
      while (captionIndex < parsed.captionDivs.length && parsed.captionDivs[captionIndex].to <= offset) captionIndex++;
      const inCaptionDiv = parsed.captionDivs[captionIndex]?.from <= offset && offset < parsed.captionDivs[captionIndex].to;
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
        !inFigure && !inTable && !inCaptionDiv)
        widgets.push(Decoration.line({class:'pcp-prose-line'}).range(offset));
      // A line starts a paragraph when the previous line is blank (or it is the
      // first line). Blank caret lines only indent when typing there would form
      // a real new paragraph, so preview never diverges from what exports show.
      const startsParagraph = i === 0 || !lines[i - 1].trim();
      if (plugin.settings.indentParagraphs && offset > frontmatterEnd && !inMath && !inFence && !structural &&
        (content ? startsParagraph : (startsParagraph && !hasText && i === caretIndex)) &&
        !inFigure && !inTable && !inCaptionDiv) {
        widgets.push(Decoration.line({class: 'pcp-paragraph-start'}).range(offset));
      }
      offset += lines[i].length + 1;
    }
  }
  // Warn about blank lines pandoc needs: a missing one turns images inline,
  // kills headings, and turns table captions into definition lists.
  const blankViolations = plugin.settings.blankLineWarnings ? (analysis.blanks ??= blankLineViolations(text).violations) : [];
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
  const groupedCaptionDivs=new Set();
  for (const group of figureGroups.values()) {
    const visible = group.filter(f => f.id || plugin.settings.showUnlabelled);
    if (!visible.length || visible.length !== group.length) continue;
    const from = group[0].groupFrom;
    let to = group[0].groupTo;
    let plans=[];
    if(group.length>1 && !plugin.legacy()) {
      try {
        const prepared={parsed,targets:captionTargets(text,parsed)};
        plans=group.map(figure=>captionTranslationPlan(text,{...figure,type:'fig'},'association',prepared));
        to=plans[0].end;
      } catch { plans=[]; }
    }
    const lineFrom = state.doc.lineAt(from).from, lineTo = state.doc.lineAt(to).to;
    if (touches(lineFrom, lineTo)) continue;
    const captions=plans.map(plan=>{
      const div=plan.existing;
      if(!div)return null;
      groupedCaptionDivs.add(div.from);
      return new FigureWidget(plugin,{from:div.from,to:div.to,caption:div.content,
        src:null,id:null,number:null,rescue:false,captionDiv:div.style,
        tableNumbers:parsed.tableNumbers,eqNumbers:parsed.eqNumbers},file,text,prefix,parsed.numbers);
    });
    const items = visible.map(figure => {
    // Use one image renderer and toolbar for every standalone Markdown figure.
    const rescue = true;
    const blankWarning = !plugin.settings.quietBlankWarnings && blankViolations.some(v => (v.from >= figure.from && v.from <= figure.to) || (v.prev === 'image' && v.from === lineTo + 1));
    const widget = new FigureWidget(plugin, {...figure, rescue, blankWarning, tableNumbers: parsed.tableNumbers, eqNumbers: parsed.eqNumbers}, file, text, prefix, parsed.numbers);
    return widget;
    });
    const widget = items.length === 1 ? items[0] : new FigureGroupWidget(items,captions);
    widgets.push(Decoration.replace({widget, block: true, inclusive: true}).range(from, to));
  }
  if (!plugin.legacy()) for (const table of parsed.tables) {
    const line = state.doc.lineAt(table.from);
    if (touches(line.from, line.to)) continue;
    widgets.push(Decoration.replace({widget: new FigureWidget(plugin,
      {...table, type: 'tbl', rescue: false, tableNumbers: parsed.tableNumbers, eqNumbers: parsed.eqNumbers}, file, text, tablePrefix, parsed.numbers),
      block: true, inclusive: false}).range(table.from, table.to));
  }
  // Pandoc fenced caption divs (::: {custom-style="Figure Caption EN"}) render
  // fences and inner caption as one caption block; the suppressed reference
  // form resolves to a bare number ("Fig. [-@fig:a]" shows "Fig. 1").
  if (!plugin.legacy()) for (const div of parsed.captionDivs) {
    if (groupedCaptionDivs.has(div.from)) continue;
    if (touches(div.from, div.to)) continue;
    widgets.push(Decoration.replace({widget: new FigureWidget(plugin,
      {from: div.from, to: div.to, caption: text.slice(div.contentFrom, div.contentTo).trim(),
        src: null, width: null, id: null, number: null, rescue: false, captionDiv: div.style,
        tableNumbers: parsed.tableNumbers, eqNumbers: parsed.eqNumbers},
      file, text, prefix, parsed.numbers), block: true, inclusive: false}).range(div.from, div.to));
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

function reviewList(content, items, selected, renderRow) {
  const paged=items.length>100, pager=paged?content.createDiv({cls:'pcp-zoom-controls'}):null;
  const list=content.createDiv({cls:'pcp-review-list'});
  let page=0, previous, next, label;
  const describe=()=>{if(label)label.setText(`第 ${page+1} / ${Math.ceil(items.length/100)} 页 · 已选 ${selected.size} / ${items.length} 处（跨页保留）`);};
  const draw=()=>{
    list.empty();
    for(const item of items.slice(page*100,page*100+100))renderRow(list.createDiv({cls:'pcp-review-row'}),item,describe);
    if(paged){previous.disabled=page===0;next.disabled=(page+1)*100>=items.length;describe();}
  };
  if(paged){
    previous=pager.createEl('button',{text:'上一页'});previous.onclick=()=>{page--;draw();};
    label=pager.createEl('span');
    next=pager.createEl('button',{text:'下一页'});next.onclick=()=>{page++;draw();};
    pager.createEl('button',{text:'全选'}).onclick=()=>{items.forEach(i=>selected.add(i));draw();};
    pager.createEl('button',{text:'清空选择'}).onclick=()=>{selected.clear();draw();};
  }
  draw();
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
    if(this.editLanguage==='zh') {
    const translation=el.createEl('details',{cls:'pcp-settings-section'});
    translation.open=!this.plugin.settings.translationModel;
    translation.createEl('summary',{text:'AI 英文题注翻译（按需）'});
    translation.createEl('p',{text:'支持 Chat Completions 兼容接口和本地模型。仅点击生成时发送文字语境，不发送图片。批量窗口自动保存 API 配置，密钥使用 Obsidian 密钥存储。'});
    for(const [key,title,placeholder] of [['translationEndpoint','API 基础地址','https://api.example.com/v1'],['translationModel','模型名称','服务商提供的模型 ID']])
      new Setting(translation).setName(title).addText(t=>t.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange(async v=>{this.plugin.settings[key]=v.trim();await this.plugin.saveData(this.plugin.settings);}));
    new Setting(translation).setName('API 密钥').setDesc('本地无鉴权模型可留空。自动保存到 Obsidian 密钥存储，下次自动读取。')
      .addText(t=>{t.inputEl.type='password';t.setValue(this.plugin.translationApiKey||'').onChange(async v=>{try{await this.plugin.saveTranslationDefaults(this.plugin.settings.translationEndpoint,this.plugin.settings.translationModel,this.plugin.settings.translationReasoning,v.trim());}catch{new Notice('密钥未保存，请检查 Obsidian 密钥存储是否可用。');}});});
    new Setting(translation).setName('翻译当前稿件题注').addButton(b=>b.setButtonText('选择题注').onClick(()=>this.plugin.openCaptionTranslation()));
    new Setting(translation).setName('整篇英文图表题').setDesc('批量生成、逐条编辑和勾选，确认后统一写入。仅中文稿可用。')
      .addButton(b=>b.setButtonText('批量生成英文图表题').onClick(()=>this.plugin.openBatchCaptionTranslation()));
    }
    new Setting(el).setName('稿件性能模式').setDesc('自动：达到 8 万字符或约 60 个图片标记时启用轻量写作：暂停复杂图注、交叉引用替换和自动全文检查；手动检查仍可用。不会更改稿件内容。')
      .addDropdown(d=>d.addOptions({auto:'自动（大稿件优先轻量）',normal:'普通',lite:'轻量写作（手动检查）'}).setValue(this.plugin.settings.performanceMode==='large'?'lite':this.plugin.settings.performanceMode).onChange(async value=>{
        await this.plugin.setPerformanceMode(value);
      }));
    new Setting(el).setName('全文检查与刷新').setDesc('立即检查空行和虚假上下标；普通模式同时更新图表预览。轻量写作保持原生显示。')
      .addButton(b=>b.setButtonText('立即检查').onClick(()=>this.plugin.checkWholeDocument()));
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
    try {this.translationApiKey=await this.app.secretStorage?.getSecret('paper-writing-view-translation')||'';}catch {this.translationApiKey='';}
    this.analysisCache = new Map(); this.sizeSnapshots = new Map(); this.languageCache = new Map(); this.largePending = new Map();
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
        const file=transaction.state.field(editorInfoField,false)?.file;
        if (this.performanceFor(transaction.state.doc,file).lite) return Decoration.none;
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
    this.performanceStatus = this.addStatusBarItem();
    this.performanceStatus.classList.add('pcp-performance-status');
    this.performanceStatus.setAttribute('role','button'); this.performanceStatus.setAttribute('tabindex','0');
    this.registerDomEvent(this.performanceStatus,'click',()=>this.selectPerformanceMode());
    this.registerDomEvent(this.performanceStatus,'keydown',event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();this.selectPerformanceMode();}
    });
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
      const view=info?.editor && info?.file ? info : this.markdownView();
      const doc=view?.editor?.cm?.state?.doc;
      if(doc && this.performanceFor(doc,view.file).lite){
        this.queueLiteStatus(view);
        return;
      }
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
    this.addCommand({id:'performance-mode',name:'选择稿件性能模式',callback:()=>this.selectPerformanceMode()});
    this.addCommand({id:'lightweight-writing',name:'启用轻量写作（卡顿时使用）',callback:()=>this.setPerformanceMode('lite')});
    this.addCommand({id:'check-whole-document',name:'全文检查与刷新',callback:()=>this.checkWholeDocument()});
    this.addCommand({id: 'diagnose-captions', name: '检查当前笔记图注', callback: () => this.diagnose()});
    this.addCommand({id: 'figure-navigation', name: '图表与公式导航', callback: () => this.openNavigation()});
    const chineseCommand=(id,name,run)=>this.addCommand({id,name,checkCallback:checking=>{
      const view=this.markdownView(),doc=view?.editor?.cm?.state?.doc;
      const sample=doc?doc.sliceString(0,Math.min(doc.length,30000)):view?.editor?.getValue()||'';
      if(!view?.file || this.languageFor(view.file,sample)!=='zh')return false;
      if(!checking)run(view);return true;
    }});
    chineseCommand('translate-caption','翻译英文图题／表题',view=>this.openCaptionTranslation(view));
    chineseCommand('batch-translate-captions','批量生成英文图表题',view=>this.openBatchCaptionTranslation(view));
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
  documentAnalysis(doc) {
    if (this.analysisCache.has(doc)) return this.analysisCache.get(doc);
    const text=doc.toString();
    const analysis={text,parsed:scanDocument(text),lines:maskExamples(text).split('\n'),rawLines:text.split('\n'),
      imageCount:(text.match(/!\[/g)||[]).length};
    this.analysisCache.set(doc,analysis);
    while(this.analysisCache.size>4)this.analysisCache.delete(this.analysisCache.keys().next().value);
    return analysis;
  }
  rememberSize(file,doc,imageCount) {
    if(!file?.path)return;
    this.sizeSnapshots.set(file.path,{doc,imageCount});
    while(this.sizeSnapshots.size>12)this.sizeSnapshots.delete(this.sizeSnapshots.keys().next().value);
  }
  performanceFor(doc,file) {
    if(this.settings.performanceMode==='lite')return performanceDecision('lite',doc?.length??0,0);
    const snapshot=this.sizeSnapshots.get(file?.path);
    const length=doc?.length ?? doc?.toString().length ?? 0;
    let images=snapshot?.imageCount;
    if(images==null){images=(doc?.toString().match(/!\[/g)||[]).length;this.rememberSize(file,doc,images);}
    else if(snapshot.doc!==doc)this.rememberSize(file,doc,images);
    return performanceDecision(this.settings.performanceMode,length,images);
  }
  isLiteFile(file) {
    if(this.settings.performanceMode==='lite')return true;
    const snapshot=this.sizeSnapshots.get(file?.path);
    return !!snapshot && performanceDecision(this.settings.performanceMode,snapshot.doc?.length ?? 0,snapshot.imageCount).lite;
  }
  queueLiteStatus(view) {
    globalThis.clearTimeout(this.blankStatusTimer);
    this.blankStatusTimer=globalThis.setTimeout(()=>{
      if(!this.disposed)this.updateBlankStatus(view);
    },250);
  }
  async setPerformanceMode(value) {
    this.settings.performanceMode=value==='large'?'lite':['normal','lite'].includes(value)?value:'auto';
    for(const entry of this.largePending.values())globalThis.clearTimeout(entry.timer);
    this.largePending.clear();
    await this.saveData(this.settings);this.refresh();
  }
  selectPerformanceMode() {
    const modal=new Modal(this.app),view=this.markdownView(),doc=view?.editor?.cm?.state?.doc || view?.editor?.getValue() || '';
    const decision=this.performanceFor(doc,view?.file);
    modal.contentEl.createEl('h2',{text:'稿件性能模式'});
    modal.contentEl.createEl('p',{text:`当前：${decision.lite?'轻量写作':decision.large?'大稿件':'普通'}；${decision.length.toLocaleString()} 字符。${decision.reason}。`});
    modal.contentEl.createEl('p',{text:'卡顿时优先选择轻量写作：保留字体、行距、原生图片与表格样式；暂停复杂图注、交叉引用显示替换和自动全文检查。检查由你手动触发，避免打字或停笔时重建全文。'});
    modal.contentEl.createEl('p',{text:'旧版“大稿件”选择同样启用轻量路径。模式应用到整个库，不修改正文或导出格式。'});
    for(const [value,label] of [['lite','轻量写作（卡顿时推荐）'],['auto','自动（大稿件优先轻量）'],['normal','普通']])
      new Setting(modal.contentEl).setName(label).addButton(b=>b.setButtonText(this.settings.performanceMode===value?'当前选择':'使用').onClick(async()=>{
        await this.setPerformanceMode(value);modal.close();
      }));
    modal.contentEl.createEl('button',{text:'立即全文检查'}).onclick=()=>{modal.close();this.checkWholeDocument();};
    modal.open();return modal;
  }
  checkWholeDocument(sourceView) {
    const view=sourceView || this.markdownView();
    if(!view?.file || !view.editor)return new Notice('请先打开 Markdown 笔记。');
    if(view.editor.cm?.composing)return new Notice('请先完成当前输入，再运行全文检查。');
    globalThis.clearTimeout(this.largePending.get(view.file.path)?.timer);this.largePending.delete(view.file.path);
    if(view.editor.cm?.state)view.editor.cm.dispatch({effects:refreshEffect.of(null)});
    this.updateBlankStatus(view,true);this.applyAppearance();this.queueTables();
    new Notice(this.isLiteFile(view.file)?'已检查空行和上下标；轻量写作保持原生显示。':'当前稿件全文检查与排版已刷新。');
  }
  updateBlankStatus(sourceView, forceChecks=false) {
    if (this.disposed || !this.blankStatus) return;
    const view = sourceView || this.markdownView();
    this.blankStatusView = view;
    const lite=view?.file&&view.editor&&this.performanceFor(view.editor.cm?.state?.doc || view.editor.getValue(),view.file).lite;
    const pending=!!this.largePending.get(view?.file?.path)?.dirty || !!lite && !forceChecks;
    if(this.performanceStatus){
      this.performanceStatus.style.display=view?.file&&view.editor?'':'none';
      if(view?.file&&view.editor){
        const mode=this.performanceFor(view.editor.cm?.state?.doc || view.editor.getValue(),view.file);
        this.performanceStatus.setText(`${mode.lite?'轻量写作':mode.large?'大稿件':'普通'} · ${mode.mode==='auto'?'自动':'手动'}${pending?' · 手动检查':''}`);
        this.performanceStatus.setAttribute('title',mode.reason+'；点击选择模式或立即检查全文');
      }
    }
    const analysis=view?.file&&view.editor&&!pending ? lite ? {text:view.editor.getValue()} : this.documentAnalysis(view.editor.cm?.state?.doc || view.editor.getValue()) : null;
    if (this.scriptStatus) {
      this.scriptStatus.style.display = view?.file && view.editor && this.settings.fakeScriptWarnings ? '' : 'none';
      if (view?.file && view.editor && this.settings.fakeScriptWarnings) {
        const count = pending ? 0 : (analysis.scripts ??= fakeScriptViolations(analysis.text)).length;
        this.scriptStatus.setText(pending ? '上下标待检查' : count ? `虚假上下标 ${count} 处 · 点击检查` : '上下标检查 ✓');
        this.scriptStatus.classList.toggle('pcp-has-script-issues', count > 0);
        this.scriptStatus.setAttribute('aria-label', pending ? '输入后等待检查，点击立即检查' : count ? `发现 ${count} 处虚假上下标，打开修复预览` : '未发现 Unicode 虚假上下标');
        this.scriptStatus.setAttribute('title', view.file.path + '\n检查 Unicode 上下标；不检查普通数字和公式，不会自动修改正文');
      }
    }
    this.languageStatusView=view;
    if(this.languageStatus) {
      this.languageStatus.style.display=view?.file&&view.editor?'':'none';
      if(view?.file&&view.editor){
        const doc=view.editor.cm?.state?.doc;
        const languageText=analysis?.text ?? this.languageCache.get(view.file.path)?.text ??
          (doc?.sliceString ? doc.sliceString(0,Math.min(doc.length,30000)) : '');
        const manual=['en','zh'].includes(this.settings.manuscriptLanguages[view.file.path]);
        this.languageStatus.setText((this.languageFor(view.file,languageText)==='en'?'英文稿':'中文稿')+' · '+(manual?'手动':'自动'));
        const decision=this.languageDecisionFor(view.file,languageText);
        this.languageStatus.setAttribute('title',view.file.path+'\n识别依据：'+decision.source+(decision.uncertain?'；正文较短或中英混排，建议手动确认':'')+'\n点击选择稿件语言');
      }
    }
    if (!view?.file || !view.editor) { this.blankStatus.style.display = 'none'; return; }
    this.blankStatus.style.display = '';
    const count = pending ? 0 : (analysis.blanks ??= blankLineViolations(analysis.text).violations).length;
    this.blankStatus.setText(pending ? '空行待检查' : count ? `缺空行 ${count} 处 · 点击检查` : '空行检查 ✓');
    this.blankStatus.classList.toggle('pcp-has-blank-issues', count > 0);
    this.blankStatus.setAttribute('aria-label', pending ? '输入后等待检查，点击立即检查' : count ? `缺少 ${count} 处空行，打开修复预览` : '未发现缺失空行');
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
    const fm=file?this.app.metadataCache.getFileCache(file)?.frontmatter:{};
    const manual=this.settings.manuscriptLanguages?.[file?.path],signature=JSON.stringify([fm?.lang,fm?.['citation-language'],fm?.cssclasses,manual]);
    const path=file?.path || '',previous=this.languageCache.get(path);
    if(previous?.signature===signature && (previous.text===text || this.largePending.get(path)?.dirty))return previous.decision;
    const decision=languageDecision(fm,text,manual);
    this.languageCache.set(path,{text,signature,decision});
    while(this.languageCache.size>12)this.languageCache.delete(this.languageCache.keys().next().value);
    return decision;
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
      if(this.isLiteFile(leaf.view.file))continue;
      const root=leaf.view.containerEl;
      for (const host of root.querySelectorAll('.image-embed')) {
        const nativeImage=host.querySelector('img');
        if(nativeImage){nativeImage.loading='lazy';nativeImage.decoding='async';}
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
    const chinese=this.languageFor(view.file,view.editor.getValue())==='zh';
    if(chinese)modal.contentEl.createEl('button',{text:'批量生成英文图表题'}).onclick=()=>{modal.close();this.openBatchCaptionTranslation(view);};
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
      for(const row of filtered) {
        const setting=new Setting(list).setName(`${row.type}${row.number??''} · ${row.title}`).setDesc(`第 ${text.slice(0,row.from).split('\n').length} 行${row.id?' · '+row.id:''}`)
        .addButton(b=>b.setButtonText('跳转').onClick(()=>{
          if(view.file?.path!==path || view.editor.getValue()!==text) {draw();return new Notice('笔记已变化，已刷新导航，请重新选择。');}
          modal.close();const pos=view.editor.offsetToPos(row.from);view.editor.setCursor(pos);view.editor.scrollIntoView({from:pos,to:pos},true);view.editor.focus();
        }));
        if(chinese && row.id && ['图','表'].includes(row.type)) setting.addButton(b=>b.setButtonText('翻译英文题注').onClick(()=>{
          if(view.file?.path!==path || view.editor.getValue()!==text) {draw();return new Notice('笔记已变化，请重新选择。');}
          modal.close();this.openCaptionTranslation(view,row.from);
        }));
      }
    };
    search.oninput=draw;modal.contentEl.createEl('button',{text:'刷新列表'}).onclick=draw;draw();modal.open();return modal;
  }
  async waitTranslationRetry(seconds, cancelled) {
    for(let i=0;i<seconds;i++){
      if(cancelled())throw new Error('翻译服务重试已取消。');
      await new Promise(resolve=>globalThis.setTimeout(resolve,1000));
    }
    if(cancelled())throw new Error('翻译服务重试已取消。');
  }
  async translationText(request, apiKey, progress=()=>{}, cancelled=()=>this.disposed) {
    const options={...request,headers:{...request.headers,...(apiKey?{Authorization:'Bearer '+apiKey}:{})}};
    let timeout;
    try {
      for(let attempt=0;attempt<3;attempt++){
      if(cancelled())throw new Error('翻译服务请求已取消。');
      const response=await Promise.race([requestUrl(options),new Promise((_,reject)=>{
        timeout=globalThis.setTimeout(()=>reject(new Error('翻译服务等待超过 60 秒，请稍后重试。')),60000);
      })]);
      globalThis.clearTimeout(timeout);
      if(response.status<200 || response.status>=300){
        const failure=translationFailure(response,apiKey);
        if(failure.retry && attempt<2){
          const header=Object.entries(response.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
          const parsed=header?(Number.isFinite(Number(header))?Number(header):Math.ceil((Date.parse(header)-Date.now())/1000)):NaN;
          const delay=Number.isFinite(parsed)&&parsed>0?Math.ceil(parsed):15*(attempt+1);
          if(delay>120)throw new Error(failure.message+'。服务商要求等待超过两分钟，请稍后重试。');
          progress(failure.message+'。将在 '+delay+' 秒后重试（'+(attempt+1)+'/2），可关闭窗口停止。');
          await this.waitTranslationRetry(delay,cancelled);continue;
        }
        throw new Error(failure.message);
      }
      const value=response.json?.choices?.[0]?.message?.content;
      if(typeof value!=='string')throw new Error('服务未返回兼容的文本译文。');
      return value;
      }
    } catch(error) {
      throw new Error(error.message?.startsWith('翻译服务') || /兼容/.test(error.message)?error.message:'请求失败，请检查网络、API 地址和模型配置。');
    } finally {globalThis.clearTimeout(timeout);}
  }
  async saveTranslationDefaults(endpoint,model,reasoning,key) {
    const base=translationBase(endpoint);
    const storage=this.app.secretStorage;
    if(key && !storage?.setSecret)throw new Error('当前 Obsidian 不支持密钥存储，未保存；请更新 Obsidian。');
    if(key)await storage.setSecret('paper-writing-view-translation',key);
    else if(storage?.deleteSecret)await storage.deleteSecret('paper-writing-view-translation');
    this.settings.translationEndpoint=base;this.settings.translationModel=model.trim();this.settings.translationReasoning=reasoning;
    this.translationApiKey=key;
    await this.saveData(this.settings);
  }
  openBatchCaptionTranslation(sourceView) {
    const view=sourceView || this.markdownView();
    if(!view?.file || !view.editor)return new Notice('请先打开 Markdown 稿件。');
    const text=view.editor.getValue(),path=view.file.path;
    if(this.languageFor(view.file,text)!=='zh')return new Notice('批量英文图表题仅用于中文稿件。');
    const parsed=scanDocument(text),prepared={parsed,targets:captionTargets(text,parsed),masked:maskExamples(text)};
    if(!prepared.targets.length)return new Notice('未找到带标签的独立 Markdown 图题或标准表题。');
    const entries=prepared.targets.map(row=>{
      try {protectCaption(row.caption);const plan=captionTranslationPlan(text,row,'excerpt',prepared);return {row,plan,translation:plan.existing?.content.replace(/^(?:Fig\.?|Figure|Table)\s+\[-@(?:fig|tbl):[\w:-]+\]\s*/i,'')||'',status:plan.existing?'已有英文题注，默认保留':'待生成'};}
      catch(error){return {row,problem:error.message,translation:''};}
    });
    const selected=new Set(entries.filter(e=>!e.problem && !e.plan.existing));
    const modal=new Modal(this.app);modal.modalEl.classList.add('pcp-translation-modal','pcp-batch-translation-modal');
    modal.contentEl.createEl('h2',{text:'批量生成英文图表题 · 中文稿'});
    modal.contentEl.createEl('p',{text:'可一次选择整篇图题和表题，插件自动排队处理，无总条数限制。已有英文题注默认保留；译文可逐条修改，确认后统一写入、一次撤销。重新生成会覆盖勾选项的当前草稿。'});
    const handoff=modal.contentEl.createDiv({cls:'pcp-review-actions'});
    const copyTask=handoff.createEl('button',{text:'复制全文与翻译要求（无需 API）'});
    const importTask=handoff.createEl('button',{text:'导入 AI 译文'});
    modal.contentEl.createEl('p',{text:'无需 API：复制任务交给你正在使用的 AI 对话，让 AI 阅读全文并返回题名译文，再导入此处集中检查、修改。插件不会自动打开或操作其他 AI 应用。'});
    let busy=false,closed=false,page=0,requests=[],requestKey='',scope='full';
    const apiSection=modal.contentEl.createEl('details');apiSection.createEl('summary',{text:'直接调用 API（可选）'});
    const controls=apiSection.createDiv({cls:'pcp-batch-api'});
    const select=(parent,label,options,value)=>{
      const wrap=parent.createEl('label',{text:label+' '}),element=wrap.createEl('select');
      for(const [key,title] of Object.entries(options))element.createEl('option',{text:title,attr:{value:key}});
      element.value=value;return element;
    };
    const input=(label,value,type='text')=>{const wrap=controls.createEl('label',{text:label});const element=wrap.createEl('input',{attr:{type}});element.value=value;return element;};
    const endpoint=input('API 地址',this.settings.translationEndpoint),model=input('模型名称',this.settings.translationModel),key=input('API 密钥',this.translationApiKey||'','password');
    const modelSelect=select(controls,'可用模型（先获取列表）',{'':'保留手动填写'},'');
    const fetchModels=controls.createEl('button',{text:'获取模型列表'});
    const reasoning=select(controls,'推理模式',{'default':'模型默认（推荐）'},'default');
    reasoning.parentElement?.hide();
    reasoning.style.display='none';
    const effortBox=controls.createDiv({cls:'pcp-effort-control'}),effortLabel=effortBox.createEl('div',{text:'Effort · 模型默认'});
    const effort=effortBox.createEl('input',{attr:{type:'range',min:'0',max:'6',step:'1','aria-label':'推理强度'}});
    effortBox.createDiv({cls:'pcp-effort-ends',text:'更快 ←                         → 更充分思考'});
    let effortValues=[];
    const syncEffort=()=>{effort.value=String(Math.max(0,effortValues.indexOf(reasoning.value)));const value=effortValues[Number(effort.value)];effortLabel.setText('Effort · '+({default:'模型默认',enabled:'开启深度思考',disabled:'关闭思考'}[value]||value));};
    const reasoningHint=controls.createEl('small',{text:'推理设置不等于模型能力排名；深度思考通常更慢。'});
    const updateReasoning=()=>{
      const old=reasoning.value;reasoning.empty();
      const zhipu=/^https:\/\/open\.bigmodel\.cn(?:\/|$)/i.test(endpoint.value.trim());
      const options=zhipu?{disabled:'关闭思考，优先速度（模型需支持）',default:'模型默认（推荐）',enabled:'开启深度思考（模型需支持）'}:
        {default:'模型默认',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'XHigh',max:'Max'};
      for(const [value,title] of Object.entries(options))reasoning.createEl('option',{text:title,attr:{value}});
      reasoning.value=Object.hasOwn(options,old)?old:'default';
      effortValues=Object.keys(options);effort.max=String(effortValues.length-1);syncEffort();
      reasoningHint.setText(zhipu?'智谱只有默认／开启思考／关闭思考三档，不支持通用 Max 等级。':'非默认档位按原值发送 reasoning_effort；Max / XHigh 等需服务商明确支持，报错请调回默认。滑块不表示模型智力排名。');
    };
    updateReasoning();
    if([...reasoning.children].some(o=>o.value===this.settings.translationReasoning))reasoning.value=this.settings.translationReasoning;
    syncEffort();
    const scopeSelect=select(controls,'语境范围',{full:'全文（默认，受模型上下文上限约束）',excerpt:'摘要＋各图表附近正文'},scope);
    modal.contentEl.createEl('p',{text:'在线 API 会接收预览中的文字，可能产生费用；本地模型可不填密钥。不读取图片文件。关闭后停止后续批次，已发送的请求无法撤回。'});
    const status=modal.contentEl.createEl('p'),details=modal.contentEl.createEl('details');details.createEl('summary',{text:'查看将发送的请求正文（不含密钥）'});
    const savedStatus=controls.createEl('small',{text:'API 地址、模型、密钥和推理模式修改后自动保存。密钥使用 Obsidian 密钥存储。'});
    let saveTimer,savePending=false;
    const persist=()=>{
      globalThis.clearTimeout(saveTimer);if(!savePending)return;
      savePending=false;
      const values=[endpoint.value,model.value,reasoning.value,key.value.trim()];
      savedStatus.setText('正在保存 API 配置……');
      const job=async()=>{
        try {await this.saveTranslationDefaults(...values);if(!closed)savedStatus.setText('API 配置已自动保存，下次自动填入。');}
        catch {if(!closed)savedStatus.setText('配置未保存：请检查地址是否完整，或 Obsidian 密钥存储是否可用。');}
      };
      this.translationSaveQueue=(this.translationSaveQueue||Promise.resolve()).catch(()=>{}).then(job);
      return this.translationSaveQueue;
    };
    const queueSave=()=>{savePending=true;globalThis.clearTimeout(saveTimer);savedStatus.setText('修改待保存……');saveTimer=globalThis.setTimeout(persist,600);};
    const sent=details.createEl('pre');
    const actions=modal.contentEl.createDiv({cls:'pcp-review-actions'});
    const button=(label,fn)=>{const b=actions.createEl('button',{text:label});b.onclick=fn;return b;};
    const invalidate=()=>{requests=[];sent.setText('选择或 API 已变化，请重新预览。');generate.disabled=true;};
    const stale=()=>this.disposed || view.file?.path!==path || view.editor.getValue()!==text || this.languageFor(view.file,text)!=='zh';
    copyTask.onclick=async()=>{
      if(busy)return;if(stale())return new Notice('稿件已变化，请重新打开。');
      try {
        const rows=entries.filter(e=>selected.has(e)&&!e.problem).map(e=>e.row),prompt=captionHandoff(text,rows);
        await navigator.clipboard.writeText(prompt);status.setText('已复制全文与 '+rows.length+' 条题名。粘贴到 AI 对话，取得 JSON 译文后点击“导入 AI 译文”。原稿尚未修改。');
      }catch(error){status.setText(error.message||'复制失败，请检查剪贴板权限。');}
    };
    importTask.onclick=()=>{
      if(busy)return;if(stale())return new Notice('稿件已变化，请重新打开。');
      const review=new Modal(this.app);review.modalEl.classList.add('pcp-translation-modal');
      review.contentEl.createEl('h2',{text:'导入 AI 返回的英文图表题'});
      review.contentEl.createEl('p',{text:'粘贴完整 JSON，导入只更新待审阅草稿，不直接修改笔记。可关闭主窗口后再打开导入，原题名必须仍与任务一致。'});
      const input=review.contentEl.createEl('textarea',{cls:'pcp-translation-output',attr:{rows:'12','aria-label':'AI 译文 JSON'}});
      const notice=review.contentEl.createEl('p');
      review.contentEl.createEl('button',{text:'导入到审阅列表'}).onclick=()=>{
        if(closed||stale()){notice.setText('稿件或主窗口已变化，请重新打开。');return;}
        try {
          const results=importCaptionHandoff(input.value,entries.filter(e=>!e.problem).map(e=>e.row));
          selected.clear();
          for(const entry of entries){const key=entry.row.type+':'+entry.row.id;if(results.has(key)){entry.translation=results.get(key);entry.status='AI 对话译文，待审阅';selected.add(entry);}}
          invalidate();page=0;draw();review.close();status.setText('已导入 '+results.size+' 条译文。请逐条检查、修改，再确认写入勾选项；原稿尚未修改。');
        }catch(error){notice.setText(error.message);}
      };
      review.open();return review;
    };
    const preview=button('预览发送内容',()=>{
      if(busy)return;if(stale())return new Notice('稿件或语言已变化，请重新打开。');
      try {
        const chosen=entries.filter(e=>selected.has(e)&&!e.problem);
        if(!chosen.length)throw new Error('请先勾选需要生成的图表题。');
        for(const entry of chosen)entry.plan=captionTranslationPlan(text,entry.row,scope,prepared);
        const settings={translationEndpoint:endpoint.value,translationModel:model.value,translationReasoning:reasoning.value};requests=[];
        for(let i=0;i<chosen.length;i+=20){const batch=chosen.slice(i,i+20);requests.push({entries:batch,request:captionBatchRequest(settings,batch.map(e=>e.plan))});}
        requestKey=key.value.trim();
        sent.setText(requests.map((r,i)=>'批次 '+(i+1)+' · '+r.request.url+'\n'+r.request.body).join('\n\n'));
        status.setText('已准备 '+chosen.length+' 条题注，共 '+requests.length+' 次 API 请求。全文语境 '+(scope==='full'?prepared.masked.length:'未启用')+' 字符；每批会重复发送语境，字符数不等于 token 数，超限请切换节选。');generate.disabled=false;
      } catch(error){requests=[];generate.disabled=true;status.setText(error.message);}
    });
    const generate=button('生成所选英文图表题',async()=>{
      if(busy||!requests.length)return;if(stale())return new Notice('稿件已变化，请重新打开。');
      busy=true;setBusy();let done=0;
      try {
        for(const batch of requests){
          if(closed||stale())break;
          status.setText('正在生成：已完成 '+done+' / '+requests.reduce((n,b)=>n+b.entries.length,0)+' 条……');
          const {protections,...request}=batch.request;
          const response=await this.translationText(request,requestKey,message=>{if(!closed)status.setText(message);},()=>closed||stale());
          if(closed||stale())break;
          const translations=parseCaptionBatch(response,protections);
          for(const entry of batch.entries){entry.translation=translations.get(entry.row.type+':'+entry.row.id);entry.status='已生成，请核对并编辑';}done+=batch.entries.length;
          draw();
        }
        if(!closed)status.setText(stale()?'稿件已变化，停止生成；请重新打开。':'已生成 '+done+' 条。检查英文题名，可编辑并取消勾选不采用的条目。');
      } catch(error){if(!closed)status.setText('生成已停止：'+error.message+' 已完成的草稿保留，可取消勾选未完成项后写入。');}
      finally {busy=false;if(!closed){setBusy();draw();}}
    });generate.disabled=true;
    const apply=button('确认写入勾选项',()=>{
      if(busy)return;if(stale())return new Notice('稿件或语言已变化，请重新打开，未写入。');
      const chosen=entries.filter(e=>selected.has(e)&&!e.problem);
      if(!chosen.length || chosen.some(e=>!e.translation.trim()))return new Notice('勾选项还有空译文，请生成、填写或取消勾选。');
      if(!view.editor.cm?.dispatch)return new Notice('当前编辑器不支持单次撤销，未写入。');
      try {
        const now=new Date(),pad=n=>String(n).padStart(2,'0');
        const timestamp=`${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const changes=captionBatchEdits(text,chosen,timestamp);
        view.editor.cm.dispatch({changes});modal.close();new Notice('已写入 '+chosen.length+' 条英文图表题，可一次撤销。');
      } catch(error){status.setText(error.message);}
    });
    button('只选缺失英文题注',()=>{if(busy)return;selected.clear();entries.filter(e=>!e.problem&&!e.plan.existing).forEach(e=>selected.add(e));invalidate();draw();});
    button('只选未完成草稿',()=>{if(busy)return;selected.clear();entries.filter(e=>!e.problem&&!e.translation.trim()).forEach(e=>selected.add(e));invalidate();draw();});
    button('全部选择',()=>{if(busy)return;entries.filter(e=>!e.problem).forEach(e=>selected.add(e));invalidate();draw();});
    button('清空选择',()=>{if(busy)return;selected.clear();invalidate();draw();});
    const pager=modal.contentEl.createDiv({cls:'pcp-review-actions'}),summary=pager.createEl('span');
    const previous=pager.createEl('button',{text:'上一页'}),next=pager.createEl('button',{text:'下一页'}),rowsHost=modal.contentEl.createDiv({cls:'pcp-review-list'});
    const draw=()=>{
      rowsHost.empty();summary.setText('已选 '+selected.size+' / '+entries.length+' 条 · 第 '+(page+1)+' / '+Math.ceil(entries.length/30)+' 页');
      previous.disabled=page===0;next.disabled=(page+1)*30>=entries.length;
      for(const entry of entries.slice(page*30,page*30+30)){
        const row=rowsHost.createDiv({cls:'pcp-review-row'}),label=row.createEl('label',{cls:'pcp-caption-review-heading'});
        const check=label.createEl('input',{attr:{type:'checkbox'}});check.checked=selected.has(entry);check.disabled=busy||!!entry.problem;
        label.appendText((entry.row.type==='fig'?'图 ':'表 ')+(entry.row.number??'')+' '+entry.row.caption);
        check.onchange=()=>{if(check.checked)selected.add(entry);else selected.delete(entry);invalidate();summary.setText('已选 '+selected.size+' / '+entries.length+' 条');};
        row.createEl('p',{cls:'pcp-caption-review-status',text:entry.problem||entry.status});
        const output=row.createEl('textarea',{cls:'pcp-translation-output',attr:{rows:'2','aria-label':'英文题名 '+(entry.row.type==='fig'?'图 ':'表 ')+(entry.row.number??'')+' '+entry.row.caption}});output.value=entry.translation;output.disabled=busy||!!entry.problem;
        output.oninput=()=>{entry.translation=output.value;entry.status='已手动编辑';};
      }
    };
    const setBusy=()=>{preview.disabled=generate.disabled=apply.disabled=copyTask.disabled=importTask.disabled=busy;scopeSelect.disabled=reasoning.disabled=effort.disabled=modelSelect.disabled=fetchModels.disabled=busy;endpoint.disabled=model.disabled=key.disabled=busy;draw();};
    previous.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};
    scopeSelect.onchange=()=>{scope=scopeSelect.value;invalidate();};
    for(const field of [endpoint,model,key])field.oninput=()=>{if(field===endpoint){key.value='';updateReasoning();modelSelect.empty();modelSelect.createEl('option',{text:'保留手动填写',attr:{value:''}});}invalidate();queueSave();};
    reasoning.onchange=()=>{invalidate();queueSave();};
    effort.oninput=()=>{reasoning.value=effortValues[Number(effort.value)];syncEffort();invalidate();queueSave();};
    modelSelect.onchange=()=>{if(modelSelect.value){model.value=modelSelect.value;invalidate();queueSave();}};
    fetchModels.onclick=async()=>{
      if(busy)return;
      let base;
      try {base=translationBase(endpoint.value);}catch(error){status.setText(error.message);return;}
      const source=endpoint.value,credential=key.value.trim();
      fetchModels.disabled=true;status.setText('正在获取服务商模型列表……');
      let timeout;
      try {
        const response=await Promise.race([requestUrl({url:base+'/models',method:'GET',headers:credential?{Authorization:'Bearer '+credential}:{},throw:false}),new Promise((_,reject)=>{timeout=globalThis.setTimeout(()=>reject(new Error('获取模型超时，请重试或手动填写。')),20000);})]);
        if(closed||source!==endpoint.value)return;
        if(response.status!==200)throw new Error('模型列表返回 HTTP '+response.status+'；部分服务不提供列表，可手动填写模型 ID。');
        const ids=[...new Set((response.json?.data||[]).map(row=>row?.id).filter(id=>typeof id==='string'&&id.length<250))].sort();
        if(!ids.length)throw new Error('服务未返回兼容的模型列表，请手动填写模型 ID。');
        modelSelect.empty();modelSelect.createEl('option',{text:'选择模型',attr:{value:''}});
        ids.forEach(id=>modelSelect.createEl('option',{text:id,attr:{value:id}}));
        if(ids.includes(model.value))modelSelect.value=model.value;
        status.setText('已获取 '+ids.length+' 个模型。列表不代表账号调用权限，也不提供智力排名；请选支持文本对话的模型。');
      } catch(error){if(!closed)status.setText(/模型|HTTP|兼容/.test(error.message)?error.message:'获取失败，请检查地址和密钥，或手动填写模型 ID。');}
      finally{globalThis.clearTimeout(timeout);fetchModels.disabled=busy;}
    };
    const oldClose=modal.onClose?.bind(modal);modal.onClose=()=>{persist();closed=true;requestKey='';key.value='';oldClose?.();};
    status.setText('默认勾选缺少英文题注的图表。先检查 API 配置，再预览发送内容。');draw();modal.open();return modal;
  }
  openCaptionTranslation(sourceView, targetOffset) {
    const view=sourceView || this.markdownView();
    if(!view?.file || !view.editor) return new Notice('请先打开 Markdown 稿件。');
    if(this.languageFor(view.file,view.editor.getValue())!=='zh')return new Notice('英文图表题翻译仅用于中文稿件。');
    const text=view.editor.getValue(), path=view.file.path, rows=captionTargets(text);
    if(!rows.length) return new Notice('未找到带有唯一标签的 Markdown 图题或表题。Wiki 图片请先使用带图题和 {#fig:id} 的 Markdown 图片。');
    const modal=new Modal(this.app); modal.modalEl.classList.add('pcp-translation-modal');
    modal.contentEl.createEl('h2',{text:'结合稿件语境翻译英文题注'});
    modal.contentEl.createEl('button',{text:'配置 API 与模型'}).onclick=()=>{
      modal.close();this.app.setting.open();this.app.setting.openTabById(this.manifest.id);
    };
    modal.contentEl.createEl('p',{text:'只在点击“发送并生成译文”后请求所选服务。先核对下面的发送内容，确认译文后才会写入笔记。'});
    let index=Math.max(0,rows.findIndex(r=>r.from===targetOffset)), scope='full', plan, request, busy=false, accepted=false, generation=0, closed=false;
    const selection=new Setting(modal.contentEl).setName('选择图题／表题');
    selection.addDropdown(d=>d.addOptions(Object.fromEntries(rows.map((r,i)=>[String(i),(r.type==='fig'?'图':'表')+' '+r.id+' · '+r.caption.slice(0,65)]))).setValue(String(index)).onChange(v=>{index=Number(v);draw();}));
    new Setting(modal.contentEl).setName('语境范围').addDropdown(d=>d.addOptions({full:'全文（默认，受模型上下文上限约束）',excerpt:'摘要＋附近正文＋已有英文题注'}).setValue('full').onChange(v=>{scope=v;draw();}));
    const info=modal.contentEl.createDiv(), original=modal.contentEl.createEl('pre');
    const details=modal.contentEl.createEl('details');details.createEl('summary',{text:'查看实际发送的请求正文'});
    const sent=details.createEl('pre');
    const status=modal.contentEl.createEl('p');
    modal.contentEl.createEl('p',{text:'英文译文（生成后可编辑；保留数字、引用和上下标）'});
    const output=modal.contentEl.createEl('textarea',{cls:'pcp-translation-output',attr:{rows:'5','aria-label':'英文题注译文'}});
    const controls=modal.contentEl.createDiv({cls:'pcp-review-actions'});
    const generate=controls.createEl('button',{text:'发送并生成译文'});
    const apply=controls.createEl('button',{text:'确认写入英文题注'});apply.disabled=true;
    controls.createEl('button',{text:'关闭'}).onclick=()=>modal.close();
    const stale=()=>this.disposed || view.file?.path!==path || view.editor.getValue()!==text;
    const draw=()=>{
      generation++; accepted=false;output.value='';apply.disabled=true;plan=null;request=null;
      original.setText(rows[index].caption);
      try {
        plan=captionTranslationPlan(text,rows[index],scope);
        request=captionTranslationRequest(this.settings,plan);
        info.setText('服务：'+request.url+' · 模型：'+this.settings.translationModel+' · 语境 '+plan.context.length+' 字符'+(plan.existing?' · 写入时将替换已有英文题注':' · 写入时新增英文题注'));
        sent.setText(request.body);status.setText('请核对发送内容；原稿中代码、注释和 frontmatter 已屏蔽。不读取图片或链接文件。');generate.disabled=busy;
      } catch(error) {info.setText('');sent.setText('');status.setText(error.message);generate.disabled=true;}
    };
    const close=modal.onClose?.bind(modal);
    modal.onClose=()=>{closed=true;generation++;close?.();};
    generate.onclick=async()=>{
      if(busy || !request) return;
      if(stale()) return new Notice('笔记已变化，请重新打开翻译窗口。');
      const token=++generation, current=request;
      busy=true;generate.disabled=true;apply.disabled=true;accepted=false;status.setText('正在生成译文，可关闭窗口忽略结果……');
      let timeout;
      try {
        const {protectedCaption,...options}=current;
        options.headers={...options.headers,...(this.translationApiKey?{Authorization:'Bearer '+this.translationApiKey}:{})};
        const response=await Promise.race([requestUrl(options),new Promise((_,reject)=>{
          timeout=globalThis.setTimeout(()=>reject(new Error('翻译服务等待超过 60 秒，请稍后重试。')),60000);
        })]);
        if(token!==generation || this.disposed) return;
        if(response.status<200 || response.status>=300) throw new Error('翻译服务返回 HTTP '+response.status+'，请检查地址、模型和密钥。');
        const data=response.json;
        const value=data?.choices?.[0]?.message?.content;
        if(typeof value!=='string') throw new Error('服务未返回兼容的文本译文，请检查接口类型。');
        output.value=validateCaptionTranslation(value,protectedCaption);accepted=true;
        status.setText(stale()?'笔记已变化：译文可查看，但不能写入，请重新翻译。':'译文已生成，请核对术语和原意后确认写入。');
        apply.disabled=stale();
      } catch(error) {
        if(token===generation) status.setText(error.message?.startsWith('翻译服务') || /译文|兼容/.test(error.message)?error.message:'请求失败，请检查网络、API 地址和模型配置。');
      } finally {globalThis.clearTimeout(timeout);busy=false;if(!closed){if(token===generation)generate.disabled=false;else if(plan)draw();}}
    };
    apply.onclick=()=>{
      if(!accepted || busy) return;
      if(stale()) return new Notice('笔记已变化，请重新翻译，未写入。');
      if(!view.editor.cm?.dispatch) return new Notice('当前编辑器不支持单次撤销，未写入。');
      try {
        const now=new Date(),pad=n=>String(n).padStart(2,'0');
        const timestamp=`${now.getFullYear()}.${pad(now.getMonth()+1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        view.editor.cm.dispatch({changes:captionTranslationEdits(text,plan,output.value,timestamp)});
        modal.close();new Notice('已写入英文题注，可 Ctrl+Z / Cmd+Z 撤销。轻量模式保留源码显示。');
      } catch(error) {status.setText(error.message);}
    };
    draw();modal.open();return modal;
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
      if(this.isLiteFile(view.file)){this.restoreTableCitations(root);continue;}
      if(this.largePending.get(view.file?.path)?.dirty)continue;
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
      if(this.largePending.get(leaf.view.file?.path)?.dirty)continue;
      let changed=root.classList.contains('pcp-word-spacing')!==!!this.settings.wordSpacing;
      root.classList.toggle('pcp-word-spacing', this.settings.wordSpacing);
      const doc=leaf.view.editor?.cm?.state?.doc;
      const text=this.isLiteFile(leaf.view.file)&&doc ? doc.sliceString(0,Math.min(doc.length,30000)) : leaf.view.editor?.getValue()||'';
      const fm={lang:this.languageFor(leaf.view.file,text)==='en'?'en-US':'zh-CN'};
      changed ||= root.classList.contains('pcp-english')!==(fm.lang==='en-US');
      root.classList.toggle('pcp-english',manuscriptLanguage(fm)==='en');
      for (const [key,value] of Object.entries(manuscriptVariables(this.appearanceFor(leaf.view.file,text),fm))) {
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
      const doc=leaf.view.editor?.cm?.state?.doc;
      const lite=this.performanceFor(doc || leaf.view.editor?.getValue() || '',leaf.view.file).lite;
      const text=lite&&doc ? doc.sliceString(0,Math.min(doc.length,30000)) : leaf.view.editor?.getValue()||'';
      const fm={lang:this.languageFor(leaf.view.file,text)==='en'?'en-US':'zh-CN'};
      root.classList.toggle('pcp-english',manuscriptLanguage(fm)==='en');
      for (const [key,value] of Object.entries(manuscriptVariables(this.appearanceFor(leaf.view.file,text),fm))) root.style.setProperty(key,value);
      if(lite){
        this.tableObservers.get(root)?.disconnect();this.tableObservers.delete(root);
        this.restoreTableCitations(root);
        const cm=leaf.view.editor?.cm;
        if(cm?.state)cm.dispatch({effects:refreshEffect.of(null)});
        continue;
      }
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
      if (cm?.dispatch && cm.state && !this.largePending.get(leaf.view.file?.path)?.dirty)
        cm.dispatch({effects: refreshEffect.of(null), selection: cm.state.selection});
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
    reviewList(modal.contentEl,issues,selected,(row,issue,describe)=>{
      const label = row.createEl('label');
      const check = label.createEl('input', {attr: {type: 'checkbox'}}); check.checked = selected.has(issue);
      check.onchange = () => {check.checked ? selected.add(issue) : selected.delete(issue);describe();};
      label.appendText(` 第 ${issue.line+1} 行，第 ${issue.column+1} 列：${issue.original} → ${issue.replacement}`);
      row.createEl('pre', {text: lines[issue.line]});
      row.createEl('button', {text: '仅修此处'}).onclick = () => apply([issue]);
      row.createEl('button', {text: '定位'}).onclick = () => {
        modal.close(); editor.setSelection(editor.offsetToPos(issue.from), editor.offsetToPos(issue.to)); editor.focus();
      };
    });
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
    reviewList(modal.contentEl,violations,selected,(row,v,describe)=>{
      const label = row.createEl('label'), check = label.createEl('input', {attr: {type: 'checkbox'}}); check.checked = selected.has(v);
      check.onchange = () => {check.checked ? selected.add(v) : selected.delete(v);describe();};
      label.appendText(` 第 ${v.line+1} 行：${names[v.prev]}后直接跟${names[v.cur]}`);
      row.createEl('pre', {text: lines.slice(Math.max(0,v.line-1), v.line+1).join('\n')});
      row.createEl('button', {text: '仅补此处'}).onclick = () => apply([v]);
      row.createEl('button', {text: '定位'}).onclick = () => { modal.close(); editor.setCursor(editor.offsetToPos(v.from)); editor.focus(); };
    });
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
    this.translationApiKey='';
    this.restoreScopedCitationPaths?.();
    this.disposed = true; globalThis.clearTimeout(this.refreshTimer); globalThis.clearTimeout(this.tableTimer);
    globalThis.clearTimeout(this.blankStatusTimer);
    for(const entry of this.largePending.values())globalThis.clearTimeout(entry.timer);
    this.largePending.clear();this.analysisCache.clear();this.languageCache.clear();this.sizeSnapshots.clear();
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
