// popup.js - Lógica da interface do popup

'use strict';

// ─── Estado ──────────────────────────────────────────────────────────────────
let currentTabId = null;
let topCacheImage = null;
let topNetworkImage = null;

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(message, type = 'info', loading = false) {
  const bar = document.getElementById('statusBar');
  const dotClass = { info: 'blue', ok: 'green', warn: 'orange', error: 'red' }[type] || 'gray';
  bar.className = `status-bar ${type}`;
  bar.innerHTML = loading
    ? `<span class="spinner"></span><span>${message}</span>`
    : `<span class="dot ${dotClass}"></span><span>${message}</span>`;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '? KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function extractFilename(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1];
    return last.length > 32 ? '...' + last.slice(-29) : last || u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

// ─── Renderização ─────────────────────────────────────────────────────────────

function renderGroup(listElId, images, sizeColorClass) {
  const list = document.getElementById(listElId);
  list.innerHTML = '';
  images.forEach((img) => {
    const item = document.createElement('div');
    item.className = 'image-item';
    const isLarge = img.size > 300 * 1024;
    const sizeClass = isLarge ? sizeColorClass : '';
    item.innerHTML = `
      <span class="img-name" title="${img.url}">${extractFilename(img.url)}</span>
      <span class="img-size ${sizeClass}">${formatSize(img.size)}</span>
    `;
    list.appendChild(item);
  });
}

function renderCompareBar(cacheImg, networkImg) {
  const bar = document.getElementById('compareBar');
  if (!cacheImg && !networkImg) { bar.style.display = 'none'; return; }

  bar.style.display = 'flex';

  const cacheSize   = cacheImg   ? cacheImg.size   : 0;
  const networkSize = networkImg ? networkImg.size  : 0;
  const cacheWins   = cacheSize >= networkSize;

  const cacheHtml = cacheImg
    ? `<div class="side">
        <span class="side-label cache-label">Disk Cache</span>
        <span class="side-size cache-size">${formatSize(cacheSize)}</span>
        <span class="side-name" title="${cacheImg.url}">${extractFilename(cacheImg.url)}</span>
        ${cacheWins ? '<span class="winner-tag cache">RECOMENDADA</span>' : ''}
       </div>`
    : `<div class="side"><span class="side-label cache-label">Disk Cache</span>
       <span style="color:#555;font-size:11px">Nenhuma</span></div>`;

  const networkHtml = networkImg
    ? `<div class="side">
        <span class="side-label network-label">Rede</span>
        <span class="side-size network-size">${formatSize(networkSize)}</span>
        <span class="side-name" title="${networkImg.url}">${extractFilename(networkImg.url)}</span>
        ${!cacheWins ? '<span class="winner-tag network">RECOMENDADA</span>' : ''}
       </div>`
    : `<div class="side"><span class="side-label network-label">Rede</span>
       <span style="color:#555;font-size:11px">Nenhuma</span></div>`;

  bar.innerHTML = cacheHtml + '<div class="divider"></div>' + networkHtml;
}

function renderResults(allImages) {
  const section = document.getElementById('imageSection');
  const empty   = document.getElementById('emptySection');

  if (!allImages || allImages.length === 0) {
    section.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  section.style.display = 'block';
  empty.style.display = 'none';

  const cacheImages   = allImages.filter((i) => i.source === 'disk_cache').sort((a, b) => b.size - a.size);
  const networkImages = allImages.filter((i) => i.source !== 'disk_cache').sort((a, b) => b.size - a.size);

  topCacheImage   = cacheImages[0]   || null;
  topNetworkImage = networkImages[0] || null;

  renderCompareBar(topCacheImage, topNetworkImage);

  const cacheGroup = document.getElementById('cacheGroup');
  if (cacheImages.length > 0) {
    cacheGroup.style.display = 'block';
    document.getElementById('cacheBadge').textContent = cacheImages.length;
    renderGroup('cacheList', cacheImages, 'large');
    document.getElementById('btnDownloadCache').disabled = false;
  } else {
    cacheGroup.style.display = 'none';
  }

  const networkGroup = document.getElementById('networkGroup');
  if (networkImages.length > 0) {
    networkGroup.style.display = 'block';
    document.getElementById('networkBadge').textContent = networkImages.length;
    renderGroup('networkList', networkImages, 'network');
    document.getElementById('btnDownloadNetwork').disabled = false;
  } else {
    networkGroup.style.display = 'none';
  }
}

// ─── Comunicação ──────────────────────────────────────────────────────────────

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (r) => {
      resolve(chrome.runtime.lastError ? null : r);
    });
  });
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (r) => {
      resolve(chrome.runtime.lastError ? null : r);
    });
  });
}

async function downloadImage(img, label) {
  if (!img) return;
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const filename = `valor_economico_${label}_${timestamp}.jpg`;
  const result = await sendToBackground({ action: 'downloadImage', url: img.url, filename });
  if (result && result.success) {
    setStatus(`Download (${label}) iniciado!`, 'ok');
  } else {
    chrome.tabs.create({ url: img.url });
    setStatus('Imagem aberta em nova aba — salve como JPG.', 'warn');
  }
}

// ─── Processo principal ───────────────────────────────────────────────────────

async function runCapture() {
  const tab = await getCurrentTab();
  if (!tab) { setStatus('Nenhuma aba ativa encontrada.', 'error'); return; }

  currentTabId = tab.id;
  if (!tab.url || !tab.url.includes('pressreader.com')) {
    setStatus('Abra a página do Valor Econômico no PressReader primeiro.', 'warn');
    return;
  }

  const btn = document.getElementById('btnCapture');
  btn.disabled = true;

  try {
    // 1. Garante content script ativo
    setStatus('Conectando ao visualizador...', 'info', true);
    let ping = await sendToContent(currentTabId, { action: 'ping' });
    if (!ping) {
      await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 600));
    }

    // 2. Inicia CDP (deve vir ANTES do zoom para capturar todas as requisições) (equivalente a abrir o DevTools Network antes do zoom)
    //    Isso garante que TODAS as requisições feitas durante o zoom
    //    sejam interceptadas, incluindo Service Worker, blobs e canvas.
    setStatus('Ativando monitor de rede (CDP)...', 'info', true);
    const captureStart = await sendToBackground({ action: 'startCapture', tabId: currentTabId });
    const usingCDP = captureStart && captureStart.result && captureStart.result.method === 'cdp';
    if (!usingCDP) {
      setStatus('CDP indisponível, usando fallback webRequest...', 'warn', true);
    }
    await new Promise((r) => setTimeout(r, 400));

    // 3. Zoom: sai do mínimo → vai ao máximo (forçando re-download das imagens)
    setStatus('Aplicando zoom máximo na página 1...', 'info', true);
    await sendToContent(currentTabId, { action: 'applyMaxZoom' });
    await new Promise((r) => setTimeout(r, 1500));

    // 4. Scroll para garantir que todas as partes da página 1 são carregadas
    setStatus('Carregando toda a página 1...', 'info', true);
    await sendToContent(currentTabId, { action: 'scrollAndLoad' });
    await new Promise((r) => setTimeout(r, 2000));

    // 5. Para o CDP e coleta todas as imagens interceptadas
    setStatus('Coletando imagens da página 1...', 'info', true);
    const stopResult = await sendToBackground({ action: 'stopCapture', tabId: currentTabId });
    const cdpImages  = (stopResult && stopResult.images) ? stopResult.images : [];

    const allImages = cdpImages.filter((i) => i.size > 0);

    if (allImages.length > 0) {
      const cacheCount   = allImages.filter((i) => i.source === 'disk_cache').length;
      const networkCount = allImages.length - cacheCount;
      setStatus(
        `Pág. 1 · ${allImages.length} imagens · ${cacheCount} cache · ${networkCount} rede`,
        'ok'
      );
    } else {
      setStatus('Nenhuma imagem encontrada. Tente novamente.', 'warn');
    }

    renderResults(allImages);
  } catch (err) {
    setStatus('Erro inesperado: ' + err.message, 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.getElementById('btnCapture').addEventListener('click', runCapture);

document.getElementById('btnDownloadCache').addEventListener('click', () => {
  downloadImage(topCacheImage, 'cache');
});

document.getElementById('btnDownloadNetwork').addEventListener('click', () => {
  downloadImage(topNetworkImage, 'rede');
});

document.getElementById('btnClear').addEventListener('click', async () => {
  if (currentTabId) await sendToBackground({ action: 'clearImages', tabId: currentTabId });
  topCacheImage = null;
  topNetworkImage = null;
  document.getElementById('imageSection').style.display = 'none';
  document.getElementById('emptySection').style.display = 'none';
  setStatus('Dados limpos. Pronto para nova captura.', 'info');
  document.getElementById('btnCapture').disabled = false;
  document.getElementById('btnDownloadCache').disabled = true;
  document.getElementById('btnDownloadNetwork').disabled = true;
});

document.getElementById('btnRetry').addEventListener('click', runCapture);
