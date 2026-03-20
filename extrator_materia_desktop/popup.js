'use strict';

// ─── Estado ──────────────────────────────────────────────────────────────────
let formattedText = '';

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(message, type = 'info', loading = false) {
  const bar = document.getElementById('statusBar');
  const dotClass = { info: 'blue', ok: 'green', warn: 'orange', error: 'red' }[type] || 'gray';
  bar.className = `status-bar ${type}`;
  bar.innerHTML = loading
    ? `<span class="spinner"></span><span>${message}</span>`
    : `<span class="dot ${dotClass}"></span><span>${message}</span>`;
}

function showMeta(data) {
  const box = document.getElementById('metaBox');
  box.style.display = 'flex';
  document.getElementById('mTitle').textContent   = data.title   || '—';
  document.getElementById('mExcerpt').textContent = data.excerpt || '—';
  document.getElementById('mAuthor').textContent  = data.author  || '—';
  document.getElementById('mDate').textContent    = data.date    || '—';
  document.getElementById('mSite').textContent    = data.siteName || '—';
}

function showPreview(text) {
  const box = document.getElementById('previewBox');
  box.style.display = 'flex';
  document.getElementById('previewText').textContent = text.slice(0, 800) + (text.length > 800 ? '\n\n[...]' : '');
}

// ─── Formatação WhatsApp ──────────────────────────────────────────────────────

function formatForWhatsApp(data) {
  const lines = [];

  lines.push(data.url || '');
  lines.push('');

  if (data.title)    lines.push(`*${data.title}*`);
  if (data.excerpt)  lines.push(`_${data.excerpt}_`);

  const meta = [data.date, data.author].filter(Boolean).join(' | ');
  if (meta)          lines.push(meta);
  if (data.siteName) lines.push(data.siteName);

  lines.push('');
  lines.push('—');
  lines.push('');

  if (data.bodyText) lines.push(data.bodyText);

  return lines.join('\n');
}

// ─── Extração ─────────────────────────────────────────────────────────────────

async function extractArticle() {
  const btnExtract = document.getElementById('btnExtract');
  const btnCopy    = document.getElementById('btnCopy');

  btnExtract.disabled = true;
  setStatus('Extraindo conteúdo…', 'info', true);
  document.getElementById('metaBox').style.display  = 'none';
  document.getElementById('previewBox').style.display = 'none';
  btnCopy.style.display = 'none';
  formattedText = '';

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus('Erro ao obter aba ativa.', 'error');
    btnExtract.disabled = false;
    return;
  }

  // Injeta Readability.js primeiro, depois o extractor
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['Readability.js'],
    });
  } catch (e) {
    setStatus('Não foi possível injetar scripts nesta página.', 'error');
    btnExtract.disabled = false;
    return;
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['extractor.js'],
    });
  } catch (e) {
    setStatus('Falha ao executar extração: ' + (e.message || e), 'error');
    btnExtract.disabled = false;
    return;
  }

  const result = results?.[0]?.result;

  if (!result || result.error) {
    setStatus(result?.error || 'Extração falhou. Tente em uma página de matéria.', 'error');
    btnExtract.disabled = false;
    return;
  }

  if (!result.bodyText || result.bodyText.length < 100) {
    setStatus('Conteúdo muito curto — página pode ter paywall ou proteção.', 'warn');
    btnExtract.disabled = false;
    return;
  }

  formattedText = formatForWhatsApp(result);

  showMeta(result);
  showPreview(formattedText);
  setStatus(`Extraído com sucesso (${result.bodyText.length} caracteres)`, 'ok');

  btnCopy.style.display  = '';
  btnCopy.className      = '';
  btnCopy.textContent    = 'Copiar para WhatsApp';
  btnExtract.disabled    = false;
}

// ─── Cópia ────────────────────────────────────────────────────────────────────

async function copyToClipboard() {
  if (!formattedText) return;
  try {
    await navigator.clipboard.writeText(formattedText);
    const btn = document.getElementById('btnCopy');
    btn.textContent = '✓ Copiado!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copiar para WhatsApp';
      btn.classList.remove('copied');
    }, 2500);
  } catch (e) {
    setStatus('Falha ao copiar: ' + (e.message || e), 'error');
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.getElementById('btnExtract').addEventListener('click', extractArticle);
document.getElementById('btnCopy').addEventListener('click', copyToClipboard);
