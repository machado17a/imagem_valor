// popup.js - Lógica da interface do popup

'use strict';

// ─── Estado ──────────────────────────────────────────────────────────────────
let currentTabId = null;
let capturedImages = [];
let selectedImageUrl = null;

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(message, type = 'info', loading = false) {
  const bar = document.getElementById('statusBar');
  const dotClass = {
    info: 'blue',
    ok: 'green',
    warn: 'orange',
    error: 'red',
  }[type] || 'gray';

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
    return last.length > 30 ? '...' + last.slice(-27) : last || u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function renderImageList(images) {
  const list = document.getElementById('imageList');
  const counter = document.getElementById('imageCounter');
  const section = document.getElementById('imageSection');
  const empty = document.getElementById('emptySection');

  if (!images || images.length === 0) {
    section.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  section.style.display = 'block';
  empty.style.display = 'none';
  counter.textContent = `${images.length} imagem(ns) encontrada(s)`;
  list.innerHTML = '';

  images.forEach((img, index) => {
    const item = document.createElement('div');
    item.className = 'image-item' + (index === 0 ? ' selected' : '');
    const isLarge = img.size > 300 * 1024; // >300KB
    item.innerHTML = `
      <span class="img-name" title="${img.url}">${extractFilename(img.url)}</span>
      <span class="img-size ${isLarge ? 'large' : ''}">${formatSize(img.size)}</span>
    `;
    item.addEventListener('click', () => selectImage(img.url, item));
    list.appendChild(item);
  });

  // Seleciona automaticamente a maior (primeira)
  if (images.length > 0) {
    selectImage(images[0].url, list.firstChild);
  }
}

function selectImage(url, element) {
  selectedImageUrl = url;
  document.querySelectorAll('.image-item').forEach((el) => el.classList.remove('selected'));
  if (element) element.classList.add('selected');
  document.getElementById('btnDownload').disabled = false;
}

// ─── Comunicação com a aba ────────────────────────────────────────────────────

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Processo principal ───────────────────────────────────────────────────────

async function runCapture() {
  const tab = await getCurrentTab();
  if (!tab) {
    setStatus('Erro: nenhuma aba ativa encontrada.', 'error');
    return;
  }

  currentTabId = tab.id;
  const isPressReader = tab.url && tab.url.includes('pressreader.com');

  if (!isPressReader) {
    setStatus('Abra a página do Valor Econômico no PressReader primeiro.', 'warn');
    return;
  }

  // Desabilita botão durante o processo
  const btn = document.getElementById('btnCapture');
  btn.disabled = true;

  try {
    // 1. Inicia captura no background
    setStatus('Iniciando monitoramento de rede...', 'info', true);
    await sendToBackground({ action: 'clearImages', tabId: currentTabId });
    await sendToBackground({ action: 'startCapture', tabId: currentTabId });

    // 2. Verifica se o content script está ativo
    const ping = await sendToContent(currentTabId, { action: 'ping' });

    if (!ping) {
      // Tenta injetar o script manualmente
      setStatus('Injetando script na página...', 'info', true);
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    // 3. Aplica zoom máximo
    setStatus('Aplicando zoom máximo no visualizador...', 'info', true);
    await sendToContent(currentTabId, { action: 'applyMaxZoom' });
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Scroll para carregar todas as imagens
    setStatus('Percorrendo a página para carregar imagens...', 'info', true);
    await sendToContent(currentTabId, { action: 'scrollAndLoad' });
    await new Promise((r) => setTimeout(r, 3000));

    // 5. Coleta imagens do background (via webRequest)
    setStatus('Coletando imagens capturadas...', 'info', true);
    const bgResult = await sendToBackground({ action: 'getImages', tabId: currentTabId });
    let images = bgResult ? bgResult.images || [] : [];

    // 6. Complementa com Performance API (content script)
    const perfResult = await sendToContent(currentTabId, { action: 'getPerformanceImages' });
    if (perfResult && perfResult.images) {
      // Merge: adiciona URLs não presentes ainda
      const existingUrls = new Set(images.map((i) => i.url));
      for (const img of perfResult.images) {
        if (!existingUrls.has(img.url)) {
          images.push(img);
        } else {
          // Atualiza tamanho se Performance API tem info melhor
          const existing = images.find((i) => i.url === img.url);
          if (existing && img.size > existing.size) {
            existing.size = img.size;
          }
        }
      }
    }

    // 7. Para a captura e ordena por tamanho
    await sendToBackground({ action: 'stopCapture', tabId: currentTabId });
    images.sort((a, b) => b.size - a.size);
    capturedImages = images;

    if (images.length > 0) {
      const largest = images[0];
      setStatus(
        `${images.length} imagem(ns) capturada(s) · Maior: ${formatSize(largest.size)}`,
        'ok'
      );
    } else {
      setStatus('Nenhuma imagem de tamanho relevante encontrada.', 'warn');
    }

    renderImageList(images);
  } catch (err) {
    setStatus('Erro inesperado: ' + err.message, 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function downloadSelected() {
  if (!selectedImageUrl) return;

  const btn = document.getElementById('btnDownload');
  btn.disabled = true;
  setStatus('Baixando imagem...', 'info', true);

  // Gera nome de arquivo com timestamp
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const filename = `valor_economico_${timestamp}.jpg`;

  const result = await sendToBackground({
    action: 'downloadImage',
    url: selectedImageUrl,
    filename,
  });

  if (result && result.success) {
    setStatus('Download iniciado! Verifique sua pasta de downloads.', 'ok');
  } else {
    // Fallback: abre a URL diretamente
    chrome.tabs.create({ url: selectedImageUrl });
    setStatus('Imagem aberta em nova aba (salve como JPG).', 'warn');
  }

  setTimeout(() => {
    btn.disabled = false;
  }, 2000);
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.getElementById('btnCapture').addEventListener('click', runCapture);

document.getElementById('btnDownload').addEventListener('click', downloadSelected);

document.getElementById('btnClear').addEventListener('click', async () => {
  if (currentTabId) {
    await sendToBackground({ action: 'clearImages', tabId: currentTabId });
  }
  capturedImages = [];
  selectedImageUrl = null;
  document.getElementById('imageSection').style.display = 'none';
  document.getElementById('emptySection').style.display = 'none';
  setStatus('Dados limpos. Pronto para nova captura.', 'info');
  document.getElementById('btnCapture').disabled = false;
});

document.getElementById('btnRetry').addEventListener('click', runCapture);
