'use strict';

// Pure parser: offsets always refer to the original document.
function escaped(text, at) {
  let n = 0;
  while (at > 0 && text[--at] === '\\') n++;
  return n % 2 === 1;
}

function maskExamples(text) {
  const blank = s => s.replace(/[^\r\n]/g, ' ');
  let masked = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, blank)
    .replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, blank);
  let fence = null;
  masked = masked.split(/(?<=\n)/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) fence = null;
      return blank(line);
    }
    if (match) { fence = match[1]; return blank(line); }
    if (/^(?: {4}|\t)/.test(line)) return blank(line);
    return line.replace(/(`+)([^\r\n]*?)\1/g, blank);
  }).join('');
  return masked;
}

function imageAt(text, at) {
  if (!text.startsWith('![', at) || escaped(text, at)) return null;
  let cursor = at + 2, depth = 1;
  const altStart = cursor;
  for (; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') { cursor++; continue; }
    if (text[cursor] === '[') depth++;
    if (text[cursor] === ']' && --depth === 0) break;
  }
  if (depth || text[cursor + 1] !== '(') return null;
  const caption = text.slice(altStart, cursor);
  cursor += 2;
  const pathStart = cursor;
  depth = 1;
  let angle = false, quote = null;
  for (; cursor < text.length; cursor++) {
    const c = text[cursor];
    if (c === '\\') { cursor++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (angle) { if (c === '>') angle = false; continue; }
    if (c === '<' && cursor === pathStart) { angle = true; continue; }
    if ((c === '"' || c === "'") && /\s/.test(text[cursor - 1])) { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) break;
    if (c === '\n' || c === '\r') return null;
  }
  if (depth) return null;
  const rawPath = text.slice(pathStart, cursor).trim();
  const titled = /\s+(["'])([\s\S]*?)\1$/.exec(rawPath);
  let src = titled ? rawPath.slice(0, titled.index).trim() : rawPath;
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  src = src.replace(/\\([()\[\] ])/g, '$1');
  if (!src) return null;
  return {from: at, imageTo: cursor + 1, caption, src};
}

function scanDocument(text) {
  const masked = maskExamples(text);
  const definitions = [], numbers = new Map(), duplicates = new Set();
  const defRegex = /\{#fig:([\w:-]+)(?:[ \t]+[^}\r\n]*)?\}/g;
  let match;
  while ((match = defRegex.exec(masked))) {
    const id = match[1], number = definitions.length + 1;
    if (numbers.has(id)) duplicates.add(id); else numbers.set(id, number);
    definitions.push({id, number, from: match.index, to: defRegex.lastIndex});
  }
  const figures = [];
  for (let at = masked.indexOf('!['); at >= 0; at = masked.indexOf('![', at + 2)) {
    let row = imageAt(masked, at);
    if (!row) continue;
    // Own image-only paragraphs, including several images on one line.
    const lineStart = masked.lastIndexOf('\n', at - 1) + 1;
    if (!/^ {0,3}$/.test(masked.slice(lineStart, at))) continue;
    const group = [];
    let to, lineEnd;
    while (row) {
    const rest = masked.slice(row.imageTo);
    const attr = /^[ \t]*(?:\r?\n[ \t]*)?(\{#fig:([\w:-]+)(?:[ \t]+[^}\r\n]*)?\})/.exec(rest);
    to = row.imageTo + (attr ? attr[0].length : 0);
    const eol = masked.indexOf('\n', to); lineEnd = eol < 0 ? masked.length : eol;
    const id = attr?.[2] || null;
    const widthMatch = attr && /\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(%|px)?/i.exec(attr[1]);
    const width = widthMatch && Number(widthMatch[1]) > 0 ? widthMatch[1] + (widthMatch[2] || 'px') : null;
    group.push({...row, from: group.length ? row.from : lineStart, to, id, number: id ? numbers.get(id) : null,
      caption: text.slice(row.from + 2, row.from + 2 + row.caption.length), width});
    const tail = masked.slice(to, lineEnd);
    if (!tail.trim()) break;
    row = imageAt(masked, to + (/^[ \t]*/.exec(tail)[0].length));
    if (!row) break;
    }
    if (masked.slice(to, lineEnd).trim()) continue;
    for (const figure of group) figures.push({...figure, groupFrom: lineStart, groupTo: to});
    at = to - 2;
  }
  const tables = [], tableNumbers = new Map();
  const tableRegex = /\{#tbl:([\w:-]+)(?:[ \t]+[^}\r\n]*)?\}/g;
  let tableCount = 0;
  while ((match = tableRegex.exec(masked))) {
    tableCount++;
    if (!tableNumbers.has(match[1])) tableNumbers.set(match[1], tableCount);
    const lineStart = masked.lastIndexOf('\n', match.index - 1) + 1;
    const before = masked.slice(lineStart, match.index);
    const caption = /^ {0,3}:[ \t]+(.*?)[ \t]*$/.exec(before);
    if (caption) tables.push({from: lineStart, to: tableRegex.lastIndex, id: match[1],
      number: tableNumbers.get(match[1]), caption: text.slice(lineStart + before.indexOf(caption[1]), match.index).trim()});
  }
  // pandoc-crossref equation labels: the {#eq:id} line right after a $$ block.
  const equations = [], eqNumbers = new Map();
  const eqRegex = /\{#eq:([\w:-]+)(?:[ \t]+[^}\r\n]*)?\}/g;
  let eqCount = 0;
  while ((match = eqRegex.exec(masked))) {
    eqCount++;
    if (!eqNumbers.has(match[1])) eqNumbers.set(match[1], eqCount);
    const lineStart = masked.lastIndexOf('\n', match.index - 1) + 1;
    if (masked.slice(lineStart, match.index).trim()) continue;  // label must start its own line
    const eol = masked.indexOf('\n', eqRegex.lastIndex);
    equations.push({from: lineStart, to: eol < 0 ? masked.length : eol, id: match[1], number: eqNumbers.get(match[1])});
  }
  const references = [];
  const refRegex = /@(fig|tbl|eq):([\w:-]+)/g;
  while ((match = refRegex.exec(masked))) {
    if (escaped(masked, match.index) || figures.some(f => match.index >= f.from && match.index < f.to)) continue;
    if (tables.some(t => match.index >= t.from && match.index < t.to)) continue;
    if (equations.some(e => match.index >= e.from && match.index < e.to)) continue;
    references.push({from: match.index, to: refRegex.lastIndex, type: match[1], id: match[2],
      number: (match[1] === 'fig' ? numbers : match[1] === 'tbl' ? tableNumbers : eqNumbers).get(match[2])});
  }
  return {figures, tables, equations, numbers, tableNumbers, eqNumbers, references, duplicates};
}

function citationMap(cache) {
  const result = new Map();
  for (const c of cache?.citations || []) {
    const raw = c.data?.map(t => t.val).join('');
    if (raw && c.val && !result.has(raw)) result.set(raw, {value: c.val, keys: c.citations.map(x => x.id)});
  }
  return result;
}

// Inventory also includes native embeds without replacing list/inline source.
function imageInventory(text) {
  const masked=maskExamples(text), parsed=scanDocument(text), figures=parsed.figures;
  const result=figures.map(f=>({...f}));
  for (const match of masked.matchAll(/!\[\[([^\]\r\n]+)\]\]|!\[/g)) {
    if (escaped(masked,match.index) || figures.some(f=>match.index>=f.from && match.index<f.to)) continue;
    let image;
    if(match[1]) {
      const [src,...alias]=match[1].split('|');
      if(!/\.(?:png|jpe?g|gif|svg|webp|bmp|avif)(?:#.*)?$/i.test(src))continue;
      image={from:match.index,to:match.index+match[0].length,src,caption:alias.join('|').replace(/^\d+(?:x\d+)?$/,'')||src};
    } else {
      const row=imageAt(masked,match.index);if(!row)continue;
      image={...row,to:row.imageTo};
    }
    const attr=/^[ \t]*(\{#fig:([\w:-]+)(?:[ \t]+[^}\r\n]*)?\})/.exec(masked.slice(image.to));
    if(attr) {image.to+=attr[0].length;image.id=attr[2];image.number=parsed.numbers.get(image.id);}
    result.push(image);
  }
  return result.sort((a,b)=>a.from-b.from);
}

// Detects lines that pandoc will mis-parse because a blank line is missing:
// prose directly followed by an image/table caption/table row/heading (the
// image inlines into the paragraph, the caption becomes a definition list,
// the table rows become text, the heading degrades into body text), and an
// image line directly followed by prose/heading/image (same merging).
function blankLineViolations(text) {
  const lines = text.split('\n');
  const masked = maskExamples(text).split('\n');
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(text);
  const fmEnd = fm ? fm[0].length : -1;
  let offset = 0, mathMarks = 0, fence = null;
  const kinds = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], t = (masked[i] || '').trim();
    const inMath = mathMarks % 2 === 1;
    mathMarks += (t.match(/\$\$/g) || []).length;
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    const inFence = !!fence;
    if (fence) {
      if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(raw)) fence = null;
    } else if (fenceMark) fence = fenceMark[1];
    let kind;
    if (offset <= fmEnd || inFence || inMath || t.startsWith('$$')) kind = 'skip';
    else if (!t) kind = 'blank';
    else if (/^#{1,6}\s/.test(t)) kind = 'heading';
    else if (/^!\[/.test(t)) kind = 'image';
    else if (/^:.*\{#tbl:/.test(t)) kind = 'tablecap';
    else if (/^\|/.test(t)) kind = 'tablerow';
    else if (/^(?:>|[-+*]\s|\d+[.)]\s|\{#|:{1,3}(?:\s|$)|<|[-*_]{3,}\s*$)/.test(t)) kind = 'other';
    else kind = 'prose';
    kinds.push({kind, lineStart: offset});
    offset += lines[i].length + 1;
  }
  const violations = [];
  for (let i = 1; i < kinds.length; i++) {
    const prev = kinds[i - 1].kind, cur = kinds[i].kind;
    const risky = cur === 'heading' || cur === 'image' || cur === 'tablecap' || cur === 'tablerow';
    if ((prev === 'prose' && risky) || (prev === 'image' && (risky || cur === 'prose'))) {
      violations.push({line: i, from: kinds[i].lineStart, cur, prev});
    }
  }
  return {violations, kinds};
}

function plainCaption(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\[@[^\]]*\]/g, '').replace(/==|[*`]/g, '').replace(/\s+/g, ' ').trim();
}

function referenceItems(text, query = '@') {
  const parsed = scanDocument(text);
  const prefix = /^@(fig|tbl|eq):/.exec(query);
  const term = (prefix ? query.slice(prefix[0].length) : '').toLocaleLowerCase().trim();
  const items = [['fig', '图', parsed.numbers, parsed.figures], ['tbl', '表', parsed.tableNumbers, parsed.tables], ['eq', '式', parsed.eqNumbers, parsed.equations]]
    .flatMap(([kind, unit, map, rows]) => [...map].map(([id, number]) => {
      const row = rows.find(r => r.id === id);
      const before = kind === 'eq' && row ? text.slice(0, row.from).trimEnd() : '';
      const body = before.endsWith('$$') ? before.slice(0, -2) : '';
      const formula = body ? body.slice(body.lastIndexOf('$$') + 2).trim() : '';
      const title = plainCaption(row?.caption || formula || '未找到标题');
      return {value: '@' + kind + ':' + id, detail: unit + number, title, kind, from: row?.from};
    }));
  return items.filter(item => prefix ? item.kind === prefix[1] && (item.value.toLocaleLowerCase().includes(term) || item.title.toLocaleLowerCase().includes(term)) : item.value.startsWith(query));
}

function documentIssues(text, resolve = () => true) {
  const parsed = scanDocument(text), masked = maskExamples(text), issues = [], labels = new Map();
  const images = imageInventory(text);
  const lineAt = offset => text.slice(0, offset).split('\n').length;
  for (const match of masked.matchAll(/\{#(fig|tbl|eq):([\w:-]+)(?:[ \t]+[^}\r\n]*)?\}/g)) {
    const key = match[1] + ':' + match[2];
    if (labels.has(key)) issues.push({type: 'duplicate-label', line: lineAt(match.index), from: match.index, message: '重复标签：' + key});
    labels.set(key, match.index);
    if (match[1] === 'fig' && !images.some(f => f.id === match[2] && match.index >= f.from && match.index < f.to))
      issues.push({type: 'orphan-label', line: lineAt(match.index), from: match.index, message: '图标签未关联独立图片：' + key});
  }
  for (const match of masked.matchAll(/@(fig|tbl|eq):([\w:-]+)/g)) {
    if (!escaped(masked, match.index) && !labels.has(match[1] + ':' + match[2]))
      issues.push({type: 'missing-reference', line: lineAt(match.index), from: match.index, message: '引用目标不存在（可能已删除）：' + match[0]});
  }
  const seen = new Set();
  for (const figure of images) {
    if (!/^https?:\/\//i.test(figure.src) && !resolve(figure.src)) issues.push({type: 'missing-image', line: lineAt(figure.from), from: figure.from, message: '图片路径缺失或不支持：' + figure.src});
    if (seen.has(figure.src)) issues.push({type: 'reused-image', line: lineAt(figure.from), from: figure.from, message: '同一路径被多次引用（请核实是否有意复用）：' + figure.src});
    seen.add(figure.src);
  }
  return issues;
}

function blankLineEdits(text, violations, timestamp) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return timestampedEdits(text, violations.map(v => ({from: v.from, insert: eol})), timestamp);
}

function timestampedEdits(text, edits, timestamp) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const changes = [...edits];
  if (!changes.length) return changes;
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(text);
  if (fm) {
    const field = /^(?:date modified|date-modified|modified):[^\r\n]*/m.exec(fm[0]);
    if (field) changes.push({from: field.index, to: field.index + field[0].length, insert: field[0].split(':')[0] + ': ' + timestamp});
    else changes.push({from: fm[0].length - 3, insert: 'date modified: ' + timestamp + eol});
  } else changes.push({from: 0, insert: '---' + eol + 'date modified: ' + timestamp + eol + '---' + eol});
  return changes.sort((a, b) => a.from - b.from);
}

// Scan characters, never guess whether ordinary baseline numbers are scientific notation.
// Keep offsets in the original document so previewed edits remain selective and undoable.
function fakeScriptViolations(text) {
  const blank = s => s.replace(/[^\r\n]/g, ' ');
  let masked = maskExamples(text)
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>|<sub\b[^>]*>[\s\S]*?<\/sub>/gi, blank)
    .replace(/\[\[[^\r\n]*?\]\]|\{[^{}\r\n]*\}|<[^>\r\n]*>/g, blank)
    .replace(/\[[^\]\r\n]*@[^\]\r\n]*\]|@[^\s\[\]{}<>;,]+/g, blank)
    .replace(/^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*/gm, blank);
  // Link/image destinations may contain nested parentheses; keep visible captions.
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ']' || masked[i+1] !== '(' || escaped(masked, i)) continue;
    let end = i+2, depth = 1;
    for (; end < masked.length && depth; end++) {
      if (masked[end] === '\\') {end++; continue;}
      if (masked[end] === '(') depth++;
      if (masked[end] === ')') depth--;
    }
    masked = masked.slice(0,i+1) + blank(masked.slice(i+1,end)) + masked.slice(end);
    i = end-1;
  }
  masked = masked.replace(/(?:https?:\/\/|obsidian:\/\/)[^\s<>]+/g, blank);
  // Protect LaTeX math. This repair writes HTML only in Markdown prose.
  for (let i = 0; i < masked.length; i++) {
    let open, close;
    if (masked[i] === '$' && !escaped(masked,i)) {open = masked[i+1] === '$' ? '$$' : '$'; close = open;}
    else if (masked[i] === '\\' && !escaped(masked,i) && /[([]/.test(masked[i+1] || '')) {
      open = masked.slice(i,i+2); close = open === '\\(' ? '\\)' : '\\]';
    }
    if (!open) continue;
    let end = masked.indexOf(close,i+open.length);
    while (end >= 0 && escaped(masked,end)) end = masked.indexOf(close,end+close.length);
    if (end < 0) { if (open !== '$') end = masked.length; else continue; }
    else end += close.length;
    masked = masked.slice(0,i) + blank(masked.slice(i,end)) + masked.slice(end);
    i = end-1;
  }
  const supers = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ',
    subs = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜᵢᵣᵤᵥᵦᵧᵨᵩᵪ';
  const kind = c => supers.includes(c) ? 'sup' : subs.includes(c) ? 'sub' : null;
  const issues = [];
  let line = 0, lineStart = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '\n') {line++; lineStart = i+1; continue;}
    const tag = kind(masked[i]);
    if (!tag) continue;
    const from = i;
    while (i+1 < masked.length && kind(masked[i+1]) === tag) i++;
    const original = text.slice(from,i+1);
    issues.push({from, to:i+1, line, column:from-lineStart, original,
      replacement:`<${tag}>${original.normalize('NFKC')}</${tag}>`});
  }
  return issues;
}

function performanceDecision(mode, length, imageCount = 0) {
  const large = mode === 'large' || (mode !== 'normal' && (length >= 80000 || imageCount >= 60));
  return {large, mode:['normal','large'].includes(mode)?mode:'auto', length, imageCount,
    reason:mode === 'large' ? '手动选择' : mode === 'normal' ? '手动选择' :
      length >= 80000 ? '正文达到 8 万字符' : imageCount >= 60 ? '图片标记达到 60 处' : '未达到大稿件阈值'};
}

function fakeScriptEdits(text, issues, timestamp) {
  return timestampedEdits(text, issues.map(v => ({from:v.from,to:v.to,insert:v.replacement})), timestamp);
}

module.exports = {scanDocument, imageAt, imageInventory, maskExamples, citationMap, blankLineViolations, referenceItems, documentIssues, blankLineEdits, fakeScriptViolations, fakeScriptEdits, performanceDecision};
