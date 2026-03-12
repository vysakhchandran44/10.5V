'use strict';

const DB_NAME = 'GS1VaultProDB';
const DB_VERSION = 1;
const SOON_DAYS = 90;
const FUZZY_THRESHOLD = 0.85;

const state = {
  db: null,
  products: [],
  scans: [],
  latest: null,
  scanner: null,
  deferredPrompt: null,
  indexes: {
    byBarcode: new Map(),
    byGTIN: new Map(),
    byLast8: new Map(),
    bySeq6: new Map()
  }
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

const DB = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id' });
          s.createIndex('barcode', 'barcode', { unique: false });
          s.createIndex('gtin', 'gtin', { unique: false });
          s.createIndex('description', 'description', { unique: false });
        }
        if (!db.objectStoreNames.contains('scans')) {
          const s = db.createObjectStore('scans', { keyPath: 'id' });
          s.createIndex('scannedAt', 'scannedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(store, mode);
      const os = tx.objectStore(store);
      const res = fn(os);
      tx.oncomplete = () => resolve(res?.result ?? true);
      tx.onerror = () => reject(tx.error);
      if (res && 'onsuccess' in res) {
        res.onsuccess = () => resolve(res.result);
        res.onerror = () => reject(res.error);
      }
    });
  },
  getAll: store => DB.tx(store, 'readonly', s => s.getAll()),
  put: (store, obj) => DB.tx(store, 'readwrite', s => s.put(obj)),
  clear: store => DB.tx(store, 'readwrite', s => s.clear()),
  get: (store, key) => DB.tx(store, 'readonly', s => s.get(key))
};

function uid(prefix='id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDigits(v) { return String(v || '').replace(/\D+/g, ''); }
function normalizeGTIN(digits) {
  const clean = normalizeDigits(digits);
  if (clean.length === 13) return `0${clean}`;
  return clean;
}
function gtinVariants(digits) {
  const clean = normalizeDigits(digits);
  if (!clean) return [];
  const variants = new Set([clean]);
  if (clean.length === 13) variants.add(`0${clean}`);
  if (clean.length === 14 && clean.startsWith('0')) variants.add(clean.slice(1));
  return [...variants];
}
function normalizeText(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseBool(v) {
  const t = String(v ?? '').trim().toUpperCase();
  return ['YES','TRUE','1','Y'].includes(t) ? 'YES' : ['NO','FALSE','0','N'].includes(t) ? 'NO' : '';
}
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const now = new Date(); now.setHours(0,0,0,0);
  const d = new Date(dateStr); if (isNaN(d)) return Infinity; d.setHours(0,0,0,0);
  return Math.round((d - now)/86400000);
}
function expiryStatus(dateStr) {
  if (!dateStr) return 'none';
  const days = daysUntil(dateStr);
  if (days < 0) return 'expired';
  if (days <= SOON_DAYS) return 'soon';
  return 'ok';
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString();
}
function parseDateFlexible(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split('/'); return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{2}\/\d{4}$/.test(s)) {
    const [mm, yyyy] = s.split('/'); return `${yyyy}-${mm}-01`;
  }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0,10);
}

function splitLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

function parseDelimited(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const headers = splitLine(lines[0], delim).map(h => normalizeText(h));
  return lines.slice(1).map(line => {
    const cells = splitLine(line, delim);
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i] ?? '');
    return row;
  });
}

function findKey(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const norm = normalizeText(cand);
    const hit = keys.find(k => k === norm || k.includes(norm));
    if (hit) return hit;
  }
  return '';
}

function productFromRow(row) {
  const barcodeKey = findKey(row, ['BARCODE', 'COMPANY BARCODE', 'COMPANY_BARCODE']);
  const gtinKey = findKey(row, ['GTIN', 'EAN', 'UPC']);
  const rmsKey = findKey(row, ['RMS CODE', 'RMS_CODE', 'RMS']);
  const descKey = findKey(row, ['DESCRIPTION', 'PRODUCT NAME', 'PRODUCT']);
  const brandKey = findKey(row, ['BRAND']);
  const supplierKey = findKey(row, ['SUPPLIER NAME', 'SUPPLIER']);
  const policyKey = findKey(row, ['RETURN POLICY', 'RETURN_POLICY']);
  const returnableKey = findKey(row, ['RETURNABLE']);
  const alshayaKey = findKey(row, ['ALSHAYA CODE', 'ALSHAYA_CODE']);
  const notesKey = findKey(row, ['NOTES', 'REMARKS', 'RERUN STATUS', 'STATUS']);
  const conceptKey = findKey(row, ['CONCEPT GROUP', 'CONCEPT_GROUP']);

  const barcode = normalizeDigits(row[barcodeKey]);
  const gtin = normalizeGTIN(row[gtinKey]);
  const description = String(row[descKey] || '').trim().toUpperCase();
  const extras = {};
  Object.entries(row).forEach(([k, v]) => {
    if (![barcodeKey, gtinKey, rmsKey, descKey, brandKey, supplierKey, policyKey, returnableKey, alshayaKey, notesKey, conceptKey].includes(k) && String(v || '').trim()) {
      extras[k] = v;
    }
  });
  return {
    id: uid('prd'),
    barcode,
    gtin,
    rmsCode: String(row[rmsKey] || '').trim(),
    description,
    conceptGroup: String(row[conceptKey] || '').trim(),
    brand: String(row[brandKey] || '').trim(),
    supplierName: String(row[supplierKey] || '').trim(),
    returnPolicy: String(row[policyKey] || '').trim(),
    returnable: parseBool(row[returnableKey]),
    alshayaCode: String(row[alshayaKey] || '').trim(),
    notes: String(row[notesKey] || '').trim(),
    extras
  };
}

function attachRefs(product) {
  product.last8 = product.gtin ? product.gtin.slice(-8) : '';
  product.seq6 = product.gtin ? product.gtin.slice(-6) : '';
  product.descNorm = normalizeText(product.description);
  return product;
}

function rebuildIndexes() {
  state.indexes = { byBarcode: new Map(), byGTIN: new Map(), byLast8: new Map(), bySeq6: new Map() };
  for (const p of state.products) {
    attachRefs(p);
    if (p.barcode) state.indexes.byBarcode.set(p.barcode, p);
    if (p.gtin) {
      gtinVariants(p.gtin).forEach(g => state.indexes.byGTIN.set(g, p));
      if (p.last8) (state.indexes.byLast8.get(p.last8) || state.indexes.byLast8.set(p.last8, []).get(p.last8)).push(p);
      if (p.seq6) (state.indexes.bySeq6.get(p.seq6) || state.indexes.bySeq6.set(p.seq6, []).get(p.seq6)).push(p);
    }
  }
}

function readVariableValue(code, start) {
  const GS = String.fromCharCode(29);
  const knownAIs = ['01', '10', '17', '21', '30', '37', '240', '241', '250', '251', '7003'];
  let i = start;
  while (i < code.length) {
    if (code[i] === GS) break;
    const next4 = code.slice(i, i + 4);
    const next3 = code.slice(i, i + 3);
    const next2 = code.slice(i, i + 2);
    if (knownAIs.includes(next4) || knownAIs.includes(next3) || knownAIs.includes(next2)) break;
    i++;
  }
  return { value: code.slice(start, i), next: i };
}

async function seedIfNeeded() {
  const seeded = await DB.get('meta', 'seeded_v3');
  const products = await DB.getAll('products');
  if (seeded || products.length) return;
  try {
    const resp = await fetch('./data/master-seed.csv');
    const text = await resp.text();
    const rows = parseDelimited(text).map(productFromRow).filter(p => p.barcode || p.gtin || p.description);
    for (const p of rows) await DB.put('products', attachRefs(p));
    await DB.put('meta', { key: 'seeded_v3', value: new Date().toISOString(), count: rows.length });
  } catch (err) {
    console.warn('Seed failed', err);
  }
}

function renderMetrics() {
  $('#metricScans').textContent = String(state.scans.length);
  $('#metricProducts').textContent = String(state.products.length);
  $('#metricFuzzy').textContent = String(state.scans.filter(s => s.matchType === 'fuzzy-review').length);
  $('#metricAmbiguous').textContent = String(state.scans.filter(s => s.matchType === 'ambiguous').length);
}

function badge(type, text) { return `<span class="badge ${esc(type)}">${esc(text)}</span>`; }

function similarity(a, b) {
  a = normalizeText(a); b = normalizeText(b);
  if (!a || !b) return 0;
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size || 1;
  const jaccard = inter / union;
  const la = a.length, lb = b.length;
  let matches = 0;
  for (const tok of sa) if (b.includes(tok)) matches += Math.min(tok.length, 10);
  const tokenCoverage = matches / Math.max(la, lb);
  return Math.max(jaccard, tokenCoverage);
}

function findFuzzyByDescription(input) {
  const q = normalizeText(input);
  if (!q || q.length < 4) return [];
  return state.products.map(p => ({ p, score: similarity(q, p.description) }))
    .filter(x => x.score >= FUZZY_THRESHOLD)
    .sort((a,b) => b.score - a.score)
    .slice(0, 5);
}

function parseGS1(raw) {
  let code = String(raw || '').trim();
  if (!code) return null;
  code = code.replace(/^\]C1|^\]d2|^\]Q3/, '');
  const result = { raw, format: 'plain', barcode: '', gtin: '', expiry: '', batch: '', serial: '', quantity: '', isGS1: false };

  const hri = code.includes('(01)') || code.includes('(17)') || code.includes('(10)');
  if (hri) {
    result.isGS1 = true; result.format = 'GS1-HRI';
    const g = code.match(/\(01\)(\d{13,14})/); if (g) result.gtin = normalizeGTIN(g[1]);
    const e = code.match(/\(17\)(\d{6})/); if (e) result.expiry = gs1Date(e[1]);
    const b = code.match(/\(10\)([^\(\u001d]+)/); if (b) result.batch = b[1].trim();
    const s = code.match(/\(21\)([^\(\u001d]+)/); if (s) result.serial = s[1].trim();
    const q = code.match(/\((30|37)\)([^\(\u001d]+)/); if (q) result.quantity = q[2].trim();
    return result;
  }

  const clean = code.replace(/[\u001d\u001e\u001c]/g, String.fromCharCode(29));
  if (/^01\d{14}/.test(clean)) {
    result.isGS1 = true; result.format = 'GS1-raw';
    let i = 0;
    while (i < clean.length) {
      if (clean[i] === String.fromCharCode(29)) { i++; continue; }
      const ai4 = clean.slice(i, i+4), ai3 = clean.slice(i, i+3), ai2 = clean.slice(i, i+2);
      let ai = '';
      if (['7003'].includes(ai4)) ai = ai4;
      else if (['240','241','250','251'].includes(ai3)) ai = ai3;
      else ai = ai2;
      i += ai.length;
      if (ai === '01') { result.gtin = normalizeGTIN(clean.slice(i, i+14)); i += 14; }
      else if (ai === '17') { result.expiry = gs1Date(clean.slice(i, i+6)); i += 6; }
      else if (ai === '10') { const val = readVariableValue(clean, i); result.batch = val.value; i = val.next; }
      else if (ai === '21') { const val = readVariableValue(clean, i); result.serial = val.value; i = val.next; }
      else if (ai === '30' || ai === '37') { const start=i; while (i<clean.length && /\d/.test(clean[i])) i++; result.quantity = clean.slice(start,i); }
      else if (ai === '7003') { i += 10; }
      else { break; }
    }
    return result;
  }

  const digits = normalizeDigits(code);
  if (/^\d{8,14}$/.test(digits)) {
    result.barcode = digits;
    result.format = `numeric-${digits.length}`;
    return result;
  }

  return { ...result, format: 'text' };
}

function gs1Date(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return '';
  const yy = +yymmdd.slice(0,2), mm = yymmdd.slice(2,4), dd = yymmdd.slice(4,6);
  return `${2000+yy}-${mm}-${dd}`;
}

function matchProduct(parsed) {
  const rawDigits = normalizeDigits(parsed.raw);
  let match = null, matchType = 'none', suggestions = [];

  if (rawDigits && state.indexes.byBarcode.has(rawDigits)) {
    match = state.indexes.byBarcode.get(rawDigits);
    matchType = 'barcode-exact';
  } else if (parsed.gtin && state.indexes.byGTIN.has(parsed.gtin)) {
    match = state.indexes.byGTIN.get(parsed.gtin);
    matchType = 'gtin-exact';
  } else if (rawDigits.length >= 13 && rawDigits.length <= 14 && state.indexes.byGTIN.has(rawDigits)) {
    match = state.indexes.byGTIN.get(rawDigits);
    matchType = 'gtin-exact';
    parsed.gtin = rawDigits;
  } else if ((parsed.gtin || rawDigits).length >= 8) {
    const base = parsed.gtin || rawDigits;
    const last8 = base.slice(-8), seq6 = base.slice(-6);
    const a = state.indexes.byLast8.get(last8) || [];
    const b = state.indexes.bySeq6.get(seq6) || [];
    const merged = [...new Map([...a, ...b].map(x => [x.id, x])).values()];
    if (merged.length === 1) {
      match = merged[0];
      matchType = a.length === 1 ? 'last8' : 'seq6';
    } else if (merged.length > 1) {
      suggestions = merged.slice(0,5);
      matchType = 'ambiguous';
    }
  }

  if (!match && !suggestions.length && /[A-Za-z]/.test(parsed.raw)) {
    const fuzzy = findFuzzyByDescription(parsed.raw);
    if (fuzzy.length) {
      suggestions = fuzzy.map(x => ({ ...x.p, score: x.score }));
      matchType = 'fuzzy-review';
    }
  }

  return { match, matchType, suggestions };
}

function makeScanRecord(parsed, resolved) {
  const { match, matchType, suggestions } = resolved;
  const barcodeDigits = normalizeDigits(parsed.raw);
  return {
    id: uid('scan'),
    scannedAt: new Date().toISOString(),
    inputRaw: parsed.raw,
    inputDigits: barcodeDigits,
    barcode: match?.barcode || (state.indexes.byBarcode.has(barcodeDigits) ? barcodeDigits : ''),
    gtin: parsed.gtin || match?.gtin || ((barcodeDigits.length >= 13 && barcodeDigits.length <= 14 && !state.indexes.byBarcode.has(barcodeDigits)) ? barcodeDigits : ''),
    description: match?.description || '',
    brand: match?.brand || '',
    rmsCode: match?.rmsCode || '',
    supplierName: match?.supplierName || '',
    returnPolicy: match?.returnPolicy || '',
    notes: match?.notes || '',
    expiry: parsed.expiry || '',
    batch: parsed.batch || '',
    serial: parsed.serial || '',
    quantity: parsed.quantity || '1',
    format: parsed.format,
    matchType,
    suggestionIds: suggestions.map(s => s.id)
  };
}

function renderLatest(scan, resolved) {
  const tpl = $('#resultTemplate').content.cloneNode(true);
  tpl.querySelector('#rawValue').textContent = scan.inputRaw;
  tpl.querySelector('#resBarcode').textContent = scan.barcode || '—';
  tpl.querySelector('#resGtin').textContent = scan.gtin || '—';
  tpl.querySelector('#resExpiry').textContent = scan.expiry || '—';
  tpl.querySelector('#resBatch').textContent = scan.batch || '—';
  tpl.querySelector('#resSerial').textContent = scan.serial || '—';
  tpl.querySelector('#resQty').textContent = scan.quantity || '1';
  tpl.querySelector('#resFormat').textContent = scan.format || '—';
  tpl.querySelector('#resRms').textContent = scan.rmsCode || '—';
  tpl.querySelector('#resBrand').textContent = scan.brand || '—';

  const box = tpl.querySelector('#matchBox');
  const cls = resolved.match ? 'match-hit' : resolved.matchType === 'ambiguous' ? 'match-ambiguous' : 'match-miss';
  box.classList.add(cls);
  let html = '';
  if (resolved.match) {
    html += `<h3>${esc(resolved.match.description || 'Matched product')}</h3>`;
    html += `<p>${badge('hit','Matched')} ${badge('info', resolved.matchType)}</p>`;
    html += `<p><strong>Barcode:</strong> ${esc(resolved.match.barcode || '—')}<br><strong>GTIN:</strong> ${esc(resolved.match.gtin || '—')}<br><strong>Supplier:</strong> ${esc(resolved.match.supplierName || '—')}</p>`;
    if (resolved.match.notes) html += `<hr class="soft"><p><strong>Notes:</strong> ${esc(resolved.match.notes)}</p>`;
  } else if (resolved.suggestions.length) {
    html += `<h3>${resolved.matchType === 'fuzzy-review' ? '85%+ fuzzy review' : 'Ambiguous candidates'}</h3>`;
    html += `<p>${badge(resolved.matchType === 'fuzzy-review' ? 'warn':'danger', resolved.matchType)}</p>`;
    html += resolved.suggestions.map(s => `<div style="margin-top:8px"><strong>${esc(s.description)}</strong><br><span class="tiny">BARCODE ${esc(s.barcode||'—')} · GTIN ${esc(s.gtin||'—')} ${s.score ? `· ${(s.score*100).toFixed(0)}%` : ''}</span></div>`).join('');
    html += `<hr class="soft"><p class="tiny">Uncertain match left unresolved. Blank stays blank. That is a feature, not a bug.</p>`;
  } else {
    html += `<h3>No reliable match</h3><p>${badge('info','blank left blank')}</p>`;
  }
  box.innerHTML = html;
  const target = $('#latestResult');
  target.innerHTML = '';
  target.appendChild(tpl);
}

async function handleInput(raw) {
  const parsed = parseGS1(raw);
  const resolved = matchProduct(parsed);
  const scan = makeScanRecord(parsed, resolved);
  state.latest = scan;
  await DB.put('scans', scan);
  state.scans.unshift(scan);
  renderLatest(scan, resolved);
  renderHistory();
  renderMetrics();
}

function exportData(kind='csv') {
  const delim = kind === 'tsv' ? '\t' : ',';
  const rows = [
    ['SCANNED_AT','INPUT_RAW','BARCODE','GTIN','RMS_CODE','DESCRIPTION','BRAND','SUPPLIER_NAME','QUANTITY','EXPIRY','BATCH','SERIAL','MATCH_TYPE','RETURN_POLICY','NOTES']
  ];
  state.scans.forEach(s => rows.push([s.scannedAt,s.inputRaw,s.barcode,s.gtin,s.rmsCode,s.description,s.brand,s.supplierName,s.quantity,s.expiry,s.batch,s.serial,s.matchType,s.returnPolicy,s.notes]));
  download(`gs1-history.${kind}`, rows.map(r => r.map(v => {
    const x = String(v ?? '');
    return kind === 'csv' ? '"' + x.replace(/"/g, '""') + '"' : x;
  }).join(delim)).join('\n'));
}

function exportMaster() {
  const rows = [['BARCODE','GTIN','RMS_CODE','DESCRIPTION','CONCEPT_GROUP','BRAND','RETURN_POLICY','SUPPLIER_NAME','ALSHAYA_CODE','RETURNABLE','NOTES']];
  state.products.forEach(p => rows.push([p.barcode,p.gtin,p.rmsCode,p.description,p.conceptGroup,p.brand,p.returnPolicy,p.supplierName,p.alshayaCode,p.returnable,p.notes]));
  download('gs1-master.tsv', rows.map(r => r.join('\t')).join('\n'));
}

function download(name, text) {
  const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function renderProducts() {
  const q = normalizeText($('#productSearch').value);
  const rows = state.products.filter(p => !q || [p.barcode,p.gtin,p.rmsCode,p.description,p.brand,p.supplierName,p.returnPolicy,p.notes].some(v => normalizeText(v).includes(q)))
    .sort((a,b) => a.description.localeCompare(b.description))
    .slice(0, 1500)
    .map(p => `<tr><td>${esc(p.barcode||'')}</td><td>${esc(p.gtin||'')}</td><td>${esc(p.rmsCode||'')}</td><td>${esc(p.description||'')}</td><td>${esc(p.brand||'')}</td><td>${esc(p.supplierName||'')}</td><td>${esc(p.returnPolicy||'')}</td></tr>`).join('');
  $('#productTableBody').innerHTML = rows || `<tr><td colspan="7">No products</td></tr>`;
}

function renderHistory() {
  const q = normalizeText($('#historySearch').value);
  const statusFilter = $('#historyStatusFilter').value;
  const sort = $('#historySort').value;
  let rows = [...state.scans].filter(s => {
    const st = expiryStatus(s.expiry);
    const okStatus = statusFilter === 'all' ? true : st === statusFilter;
    const okSearch = !q || [s.inputRaw,s.barcode,s.gtin,s.description,s.batch,s.serial,s.matchType].some(v => normalizeText(v).includes(q));
    return okStatus && okSearch;
  });
  rows.sort((a,b) => sort === 'oldest' ? a.scannedAt.localeCompare(b.scannedAt) : sort === 'expiry' ? String(a.expiry).localeCompare(String(b.expiry)) : b.scannedAt.localeCompare(a.scannedAt));
  $('#historyTableBody').innerHTML = rows.map(s => {
    const st = expiryStatus(s.expiry);
    return `<tr>
      <td>${esc(fmtDateTime(s.scannedAt))}</td>
      <td class="mono">${esc(s.inputRaw)}</td>
      <td>${esc(s.barcode||'')}</td>
      <td>${esc(s.gtin||'')}</td>
      <td>${esc(s.description||'')}</td>
      <td>${esc(s.expiry||'')}</td>
      <td>${badge(st, st.toUpperCase())}</td>
      <td>${esc(s.batch||'')}</td>
      <td>${esc(s.quantity||'1')}</td>
      <td>${badge(s.matchType === 'none' ? 'info' : s.matchType === 'ambiguous' ? 'warn' : 'hit', s.matchType)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="10">No scan history</td></tr>`;
}

async function saveFormProduct() {
  const product = attachRefs({
    id: uid('prd'),
    barcode: normalizeDigits($('#formBarcode').value),
    gtin: normalizeGTIN($('#formGtin').value),
    rmsCode: $('#formRms').value.trim(),
    description: $('#formDesc').value.trim().toUpperCase(),
    brand: $('#formBrand').value.trim(),
    supplierName: $('#formSupplier').value.trim(),
    returnPolicy: $('#formPolicy').value.trim(),
    returnable: '',
    alshayaCode: '',
    conceptGroup: '',
    notes: $('#formNotes').value.trim(),
    extras: {}
  });
  if (!product.barcode && !product.gtin && !product.description) return;
  const existing = state.products.find(p => (product.barcode && p.barcode === product.barcode) || (product.gtin && p.gtin === product.gtin));
  if (existing) product.id = existing.id;
  await DB.put('products', product);
  state.products = await DB.getAll('products');
  rebuildIndexes(); renderProducts(); renderMetrics();
  ['#formBarcode','#formGtin','#formRms','#formDesc','#formBrand','#formSupplier','#formPolicy','#formNotes'].forEach(id => $(id).value = '');
}

async function importMasterFile(file) {
  const text = await file.text();
  const rows = parseDelimited(text);
  const imported = rows.map(productFromRow).filter(p => p.barcode || p.gtin || p.description);
  const merged = new Map(state.products.map(p => [p.id, p]));

  for (const p0 of imported) {
    const p = attachRefs(p0);
    const exact = state.products.find(x => (p.barcode && x.barcode === p.barcode) || (p.gtin && x.gtin === p.gtin));
    if (exact) {
      merged.set(exact.id, attachRefs({ ...exact, ...p, id: exact.id, extras: { ...(exact.extras||{}), ...(p.extras||{}) } }));
      continue;
    }
    if (p.description) {
      const fuzzy = findFuzzyByDescription(p.description)[0];
      if (fuzzy && fuzzy.score >= FUZZY_THRESHOLD && !p.barcode && !p.gtin) {
        const ex = fuzzy.p;
        merged.set(ex.id, attachRefs({ ...ex, notes: [ex.notes, p.notes].filter(Boolean).join(' | '), extras: { ...(ex.extras||{}), ...(p.extras||{}) } }));
        continue;
      }
    }
    merged.set(p.id, p);
  }

  await DB.clear('products');
  for (const p of merged.values()) await DB.put('products', p);
  state.products = await DB.getAll('products');
  rebuildIndexes(); renderProducts(); renderMetrics();
}

function copyLatest() {
  if (!state.latest) return;
  const s = state.latest;
  const txt = `INPUT: ${s.inputRaw}\nBARCODE: ${s.barcode || ''}\nGTIN: ${s.gtin || ''}\nDESCRIPTION: ${s.description || ''}\nEXPIRY: ${s.expiry || ''}\nBATCH: ${s.batch || ''}\nMATCH: ${s.matchType}`;
  navigator.clipboard.writeText(txt).catch(() => {});
}

async function backupJson() {
  const payload = JSON.stringify({ products: state.products, scans: state.scans, exportedAt: new Date().toISOString(), version: 3 }, null, 2);
  download('gs1-vault-pro-backup.json', payload);
}

async function restoreJson(file) {
  const obj = JSON.parse(await file.text());
  await DB.clear('products');
  await DB.clear('scans');
  for (const p of obj.products || []) await DB.put('products', attachRefs(p));
  for (const s of obj.scans || []) await DB.put('scans', s);
  state.products = await DB.getAll('products');
  state.scans = (await DB.getAll('scans')).sort((a,b) => b.scannedAt.localeCompare(a.scannedAt));
  rebuildIndexes(); renderProducts(); renderHistory(); renderMetrics();
}

async function startCamera() {
  if (!window.Html5Qrcode || state.scanner) return;
  state.scanner = new Html5Qrcode('reader');
  await state.scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, async decoded => {
    await handleInput(decoded);
    try { await stopCamera(); } catch {}
  });
}

async function stopCamera() {
  if (!state.scanner) return;
  await state.scanner.stop();
  await state.scanner.clear();
  state.scanner = null;
  $('#reader').innerHTML = '';
}

async function scanImage(file) {
  if (!window.Html5Qrcode) return;
  const scanner = new Html5Qrcode('reader');
  try {
    const decoded = await scanner.scanFile(file, true);
    await handleInput(decoded);
  } finally {
    try { await scanner.clear(); } catch {}
  }
}

function setupInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.deferredPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    $('#installBtn').hidden = true;
  });
}

async function init() {
  state.db = await DB.open();
  await seedIfNeeded();
  state.products = await DB.getAll('products');
  state.scans = (await DB.getAll('scans')).sort((a,b) => b.scannedAt.localeCompare(a.scannedAt));
  rebuildIndexes();
  renderProducts(); renderHistory(); renderMetrics();
  $('#storageStatus').textContent = `IndexedDB ready · ${state.products.length} products loaded`;

  $('#parseManualBtn').addEventListener('click', async () => {
    const v = $('#manualInput').value.trim();
    if (!v) return;
    const lines = v.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const entries = lines.length > 1 ? lines : [v];
    const limitedEntries = entries.slice(0, 1000);
    for (const entry of limitedEntries) await handleInput(entry);
    if (entries.length > 1000) {
      alert(`Only the first 1000 entries were processed. ${entries.length - 1000} extra line(s) were skipped.`);
    }
  });
  $('#clearManualBtn').addEventListener('click', () => $('#manualInput').value = '');
  $('#copyLatestBtn').addEventListener('click', copyLatest);
  $('#productSearch').addEventListener('input', renderProducts);
  $('#historySearch').addEventListener('input', renderHistory);
  $('#historyStatusFilter').addEventListener('change', renderHistory);
  $('#historySort').addEventListener('change', renderHistory);
  $('#saveProductBtn').addEventListener('click', saveFormProduct);
  $('#clearProductBtn').addEventListener('click', () => ['#formBarcode','#formGtin','#formRms','#formDesc','#formBrand','#formSupplier','#formPolicy','#formNotes'].forEach(id => $(id).value = ''));
  $('#exportCsvBtn').addEventListener('click', () => exportData('csv'));
  $('#exportTsvBtn').addEventListener('click', () => exportData('tsv'));
  $('#exportMasterBtn').addEventListener('click', exportMaster);
  $('#backupBtn').addEventListener('click', backupJson);
  $('#downloadTemplateBtn').addEventListener('click', () => download('gs1-template.csv', 'BARCODE,GTIN,RMS_CODE,DESCRIPTION,CONCEPT_GROUP,BRAND,RETURN_POLICY,SUPPLIER_NAME,ALSHAYA_CODE,RETURNABLE,NOTES\n'));
  $('#restoreInput').addEventListener('change', e => e.target.files[0] && restoreJson(e.target.files[0]));
  $('#masterFileInput').addEventListener('change', e => e.target.files[0] && importMasterFile(e.target.files[0]));
  $('#wipeHistoryBtn').addEventListener('click', async () => { await DB.clear('scans'); state.scans = []; renderHistory(); renderMetrics(); });
  $('#wipeMasterBtn').addEventListener('click', async () => { await DB.clear('products'); state.products = []; rebuildIndexes(); renderProducts(); renderMetrics(); });
  $('#startScanBtn').addEventListener('click', startCamera);
  $('#stopScanBtn').addEventListener('click', stopCamera);
  $('#imageScanInput').addEventListener('change', e => e.target.files[0] && scanImage(e.target.files[0]));
  setupInstall();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
