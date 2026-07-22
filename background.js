// background.js - Service Worker

'use strict';

// ─── Estado ───────────────────────────────────────────────────────────────────

// CDP sessions: tabId → { images: { requestId → {...} }, attached: bool }
const debuggerSessions = {};

// Fallback webRequest (caso o debugger falhe em alguma edge case)
const webRequestImages = {};
const capturingTabs = new Set();

// ─── Filtro de imagem ─────────────────────────────────────────────────────────

const IMAGE_URL_PATTERNS = [
  /\.jpg(\?.*)?$/i,
  /\.jpeg(\?.*)?$/i,
  /\.png(\?.*)?$/i,
  /\.webp(\?.*)?$/i,
  /pressreader\.com.*image/i,
  /presscdn\.com/i,
  /pressdisplay\.com/i,
  /prcdn\.co/i,
];
const UI_EXCLUDE = /favicon|\/icon|logo|sprite|placeholder/i;

function isNewspaperImage(url, mimeType) {
  if (UI_EXCLUDE.test(url)) return false;
  if (mimeType && mimeType.startsWith('image/')) return true;
  return IMAGE_URL_PATTERNS.some((p) => p.test(url));
}

// ─── CDP helpers ─────────────────────────────────────────────────────────────

function cdpAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function cdpDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      chrome.runtime.lastError; // consume
      resolve();
    });
  });
}

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

// ─── CDP event listener ───────────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const session = debuggerSessions[tabId];
  if (!session) return;

  if (method === 'Network.responseReceived') {
    const { requestId, response } = params;
    if (!isNewspaperImage(response.url, response.mimeType)) return;

    const contentLength = response.headers
      ? parseInt(response.headers['content-length'] || response.headers['Content-Length'] || '0', 10)
      : 0;

    session.images[requestId] = {
      url: response.url,
      size: contentLength,
      contentType: response.mimeType,
      source: response.fromDiskCache ? 'disk_cache' : 'network',
    };
  }

  if (method === 'Network.loadingFinished') {
    const { requestId, encodedDataLength } = params;
    const img = session.images[requestId];
    if (img && encodedDataLength > 0) {
      // encodedDataLength = bytes reais recebidos da rede (0 para disco)
      if (img.source === 'network') {
        img.size = encodedDataLength;
      } else if (img.size === 0) {
        // Cache: se ainda sem tamanho, usa como estimativa
        img.size = encodedDataLength;
      }
    }
  }
});

// Limpa sessão se o debugger for desconectado externamente (ex: usuário abre DevTools)
chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (debuggerSessions[tabId]) {
    debuggerSessions[tabId].attached = false;
  }
});

// ─── Operações de captura ─────────────────────────────────────────────────────

async function startDebugCapture(tabId) {
  // Se já está attached, apenas limpa imagens
  if (debuggerSessions[tabId] && debuggerSessions[tabId].attached) {
    debuggerSessions[tabId].images = {};
    return { method: 'cdp_reused' };
  }

  debuggerSessions[tabId] = { images: {}, attached: false };

  try {
    await cdpAttach(tabId);
    debuggerSessions[tabId].attached = true;
    await cdpSend(tabId, 'Network.enable', {
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxTotalBufferSize:    200 * 1024 * 1024,
    });
    return { method: 'cdp' };
  } catch (err) {
    delete debuggerSessions[tabId];
    // Fallback para webRequest
    webRequestImages[tabId] = {};
    capturingTabs.add(tabId);
    return { method: 'webRequest', error: err.message };
  }
}

async function stopDebugCapture(tabId) {
  const session = debuggerSessions[tabId];
  if (!session) {
    const images = webRequestImages[tabId] ? Object.values(webRequestImages[tabId]) : [];
    capturingTabs.delete(tabId);
    delete webRequestImages[tabId];
    return images;
  }

  const images = Object.values(session.images);

  if (session.attached) {
    await cdpDetach(tabId);
  }
  delete debuggerSessions[tabId];

  return images;
}

// ─── Fallback: webRequest ─────────────────────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0 || !capturingTabs.has(tabId)) return;

    let contentLength = 0;
    let contentType = '';
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'content-length') contentLength = parseInt(h.value, 10) || 0;
      if (name === 'content-type') contentType = h.value.split(';')[0].trim();
    }

    if (!isNewspaperImage(details.url, contentType)) return;
    if (!webRequestImages[tabId]) webRequestImages[tabId] = {};

    const existing = webRequestImages[tabId][details.url];
    if (!existing || contentLength > existing.size) {
      webRequestImages[tabId][details.url] = {
        url: details.url,
        size: contentLength,
        contentType,
        source: 'network',
      };
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ─── Mensagens ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);

  if (message.action === 'startCapture') {
    startDebugCapture(tabId)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

  } else if (message.action === 'stopCapture') {
    stopDebugCapture(tabId)
      .then((images) => sendResponse({ success: true, images }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

  } else if (message.action === 'getImages') {
    // Retorna imagens acumuladas sem parar
    const session = debuggerSessions[tabId];
    const images = session
      ? Object.values(session.images)
      : (webRequestImages[tabId] ? Object.values(webRequestImages[tabId]) : []);
    images.sort((a, b) => b.size - a.size);
    sendResponse({ images, total: images.length });

  } else if (message.action === 'clearImages') {
    if (debuggerSessions[tabId]) debuggerSessions[tabId].images = {};
    if (webRequestImages[tabId]) webRequestImages[tabId] = {};
    sendResponse({ success: true });

  } else if (message.action === 'downloadImage') {
    const { url, filename } = message;
    chrome.downloads.download(
      { url, filename: filename || `valor_economico_${Date.now()}.jpg`, saveAs: true },
      (downloadId) => {
        if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        else sendResponse({ success: true, downloadId });
      }
    );

  } else if (message.action === 'fetchAndCheckSize') {
    fetch(message.url, { method: 'HEAD' })
      .then((res) => sendResponse({
        size: parseInt(res.headers.get('content-length') || '0', 10),
        contentType: res.headers.get('content-type') || '',
        success: true,
      }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
  }

  return true;
});

// ─── Limpeza ao fechar aba ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (debuggerSessions[tabId]) {
    if (debuggerSessions[tabId].attached) await cdpDetach(tabId);
    delete debuggerSessions[tabId];
  }
  delete webRequestImages[tabId];
  capturingTabs.delete(tabId);
});
