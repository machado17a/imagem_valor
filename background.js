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

// ─── Remontagem de página a partir de blocos (tiles) ───────────────────────
// O visualizador atual não serve mais a página como um arquivo único: ele
// pede recortes retangulares via query string (left/top/right/bottom) na
// escala pedida. Aqui juntamos todos os recortes de uma mesma página/escala
// de volta em uma única imagem.

function parseTileUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)prcdn\.co$/i.test(u.hostname)) return null;
    if (!u.pathname.endsWith('/img')) return null;

    const p = u.searchParams;
    const left = parseFloat(p.get('left'));
    const top = parseFloat(p.get('top'));
    const right = parseFloat(p.get('right'));
    const bottom = parseFloat(p.get('bottom'));
    if ([left, top, right, bottom].some((n) => Number.isNaN(n))) return null;

    return {
      url,
      file: p.get('file'),
      page: p.get('page'),
      scale: p.get('scale'),
      left, top, right, bottom,
    };
  } catch {
    return null;
  }
}

function pickBestTileGroup(images) {
  const tiles = (images || []).map((i) => parseTileUrl(i.url)).filter(Boolean);
  if (tiles.length < 2) return null;

  const groups = {};
  for (const t of tiles) {
    const key = `${t.file}|${t.page}|${t.scale}`;
    (groups[key] = groups[key] || []).push(t);
  }

  // Escolhe o grupo de maior escala (maior resolução); empate → mais blocos
  let best = null;
  for (const key in groups) {
    const g = groups[key];
    const scale = parseFloat(g[0].scale) || 0;
    if (!best || scale > best.scale || (scale === best.scale && g.length > best.tiles.length)) {
      best = { scale, tiles: g };
    }
  }
  return best ? best.tiles : null;
}

async function blobToDataURL(blob) {
  // URL.createObjectURL não existe no contexto de service worker (MV3),
  // então convertemos manualmente para data: URL via base64.
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

async function stitchTiles(tiles) {
  const minLeft = Math.min(...tiles.map((t) => t.left));
  const minTop = Math.min(...tiles.map((t) => t.top));
  const maxRight = Math.max(...tiles.map((t) => t.right));
  const maxBottom = Math.max(...tiles.map((t) => t.bottom));

  const width = Math.round(maxRight - minLeft);
  const height = Math.round(maxBottom - minTop);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  for (const t of tiles) {
    const res = await fetch(t.url);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(
      bitmap,
      Math.round(t.left - minLeft),
      Math.round(t.top - minTop),
      Math.round(t.right - t.left),
      Math.round(t.bottom - t.top)
    );
    bitmap.close();
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
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

  } else if (message.action === 'stitchAndDownload') {
    (async () => {
      try {
        const tiles = pickBestTileGroup(message.images);
        if (!tiles) {
          sendResponse({ success: false, error: 'Nenhum conjunto de blocos da mesma página/escala encontrado.' });
          return;
        }
        const blob = await stitchTiles(tiles);
        const url = await blobToDataURL(blob);
        chrome.downloads.download(
          { url, filename: message.filename || `valor_economico_pagina_${Date.now()}.jpg`, saveAs: true },
          (downloadId) => {
            if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
            else sendResponse({ success: true, downloadId, tileCount: tiles.length });
          }
        );
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
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
