// background.js - Service Worker para monitorar requisições de imagem

// Mapa de imagens capturadas por tabId: { url, size, contentType, timestamp }
const capturedImages = {};
// Estado de captura por tabId
const capturingTabs = new Set();

// Padrões que indicam que a URL é uma imagem de página de jornal
const IMAGE_URL_PATTERNS = [
  /\.jpg(\?.*)?$/i,
  /\.jpeg(\?.*)?$/i,
  /\.png(\?.*)?$/i,
  /\.webp(\?.*)?$/i,
  /pressreader\.com.*image/i,
  /presscdn\.com/i,
  /pressdisplay\.com/i,
];

function isLikelyNewspaperImage(url, contentType) {
  if (contentType && contentType.startsWith('image/')) {
    // Exclui ícones pequenos e imagens de UI
    if (url.includes('favicon') || url.includes('icon') || url.includes('logo')) {
      return false;
    }
    return true;
  }
  return IMAGE_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// Monitora headers de resposta para capturar tamanho das imagens
chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    const tabId = details.tabId;
    if (tabId < 0 || !capturingTabs.has(tabId)) return;

    let contentLength = 0;
    let contentType = '';

    for (const header of details.responseHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === 'content-length') {
        contentLength = parseInt(header.value, 10) || 0;
      }
      if (name === 'content-type') {
        contentType = header.value.split(';')[0].trim();
      }
    }

    if (!isLikelyNewspaperImage(details.url, contentType)) return;

    if (!capturedImages[tabId]) {
      capturedImages[tabId] = {};
    }

    // Atualiza se for maior ou nova
    const existing = capturedImages[tabId][details.url];
    if (!existing || contentLength > existing.size) {
      capturedImages[tabId][details.url] = {
        url: details.url,
        size: contentLength,
        contentType: contentType,
        timestamp: Date.now(),
      };
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Listener de mensagens do popup e content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);

  if (message.action === 'startCapture') {
    if (tabId) {
      capturedImages[tabId] = {};
      capturingTabs.add(tabId);
    }
    sendResponse({ success: true });

  } else if (message.action === 'stopCapture') {
    if (tabId) capturingTabs.delete(tabId);
    sendResponse({ success: true });

  } else if (message.action === 'getImages') {
    const images = capturedImages[tabId] ? Object.values(capturedImages[tabId]) : [];
    // Ordena por tamanho decrescente
    images.sort((a, b) => b.size - a.size);
    sendResponse({ images, total: images.length });

  } else if (message.action === 'getLargestImage') {
    const images = capturedImages[tabId] ? Object.values(capturedImages[tabId]) : [];
    if (images.length === 0) {
      sendResponse({ image: null, total: 0 });
      return true;
    }
    images.sort((a, b) => b.size - a.size);
    sendResponse({ image: images[0], total: images.length });

  } else if (message.action === 'downloadImage') {
    const { url, filename } = message;
    chrome.downloads.download(
      {
        url: url,
        filename: filename || `valor_economico_${Date.now()}.jpg`,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );

  } else if (message.action === 'clearImages') {
    if (tabId) capturedImages[tabId] = {};
    sendResponse({ success: true });

  } else if (message.action === 'fetchAndCheckSize') {
    // Para URLs sem content-length, faz um HEAD request para checar tamanho real
    const { url } = message;
    fetch(url, { method: 'HEAD' })
      .then((res) => {
        const size = parseInt(res.headers.get('content-length') || '0', 10);
        const contentType = res.headers.get('content-type') || '';
        sendResponse({ size, contentType, success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
  }

  return true; // Mantém o canal aberto para respostas assíncronas
});

// Limpa dados quando a tab é fechada
chrome.tabs.onRemoved.addListener((tabId) => {
  delete capturedImages[tabId];
  capturingTabs.delete(tabId);
});
