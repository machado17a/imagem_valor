// content.js - Script injetado na página do PressReader

(function () {
  'use strict';

  // Evita inicialização duplicada
  if (window.__valorExtractorLoaded) return;
  window.__valorExtractorLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Helpers de botão ────────────────────────────────────────────────────

  function isButtonDisabled(btn) {
    return (
      btn.disabled ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.classList.contains('disabled') ||
      btn.classList.contains('is-disabled')
    );
  }

  function findButton(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ─── Tela cheia no visualizador ──────────────────────────────────────────

  async function enterViewerFullscreen() {
    // 1. Tenta clicar no botão de fullscreen do próprio PressReader
    const btn = findButton([
      '[class*="fullscreen"]:not([class*="exit"])',
      '[class*="full-screen"]:not([class*="exit"])',
      '[aria-label*="fullscreen" i]',
      '[aria-label*="full screen" i]',
      '[title*="fullscreen" i]',
      '[title*="full screen" i]',
      '[data-action="fullscreen"]',
      '.viewer-fullscreen',
      '.pr-fullscreen',
    ]);

    if (btn && !isButtonDisabled(btn)) {
      btn.click();
      await sleep(800);
      return { method: 'button' };
    }

    // 2. Fallback: requestFullscreen no elemento viewer
    const viewer =
      document.querySelector('[class*="viewer"]') ||
      document.querySelector('[class*="reader"]') ||
      document.querySelector('[class*="issue"]') ||
      document.documentElement;

    try {
      await viewer.requestFullscreen();
      await sleep(800);
      return { method: 'api', element: viewer.tagName };
    } catch {
      return { method: 'none' };
    }
  }

  // ─── Zoom máximo no visualizador ─────────────────────────────────────────

  async function applyMaxZoom() {
    // Espera os botões de zoom aparecerem
    let zoomInBtn = null;
    let zoomOutBtn = null;

    for (let i = 0; i < 15; i++) {
      zoomInBtn = findButton([
        '[class*="zoom-in"]',
        '[class*="zoomIn"]',
        '[aria-label*="zoom in" i]',
        '[title*="zoom in" i]',
        '[data-action="zoom-in"]',
        'button[class*="zoom"]:not([class*="out"])',
        '.zoom-controls .in',
        '.viewer-zoom-in',
      ]);
      zoomOutBtn = findButton([
        '[class*="zoom-out"]',
        '[class*="zoomOut"]',
        '[aria-label*="zoom out" i]',
        '[title*="zoom out" i]',
        '[data-action="zoom-out"]',
        '.zoom-controls .out',
        '.viewer-zoom-out',
      ]);
      if (zoomInBtn) break;
      await sleep(500);
    }

    if (!zoomInBtn) {
      // Fallback: teclado
      for (let i = 0; i < 15; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: '+', code: 'Equal', keyCode: 187,
          ctrlKey: true, bubbles: true, cancelable: true,
        }));
      }
      return { method: 'keyboard' };
    }

    // ── Passo 1: zoom out até o mínimo ─────────────────────────────────────
    // Garante que partimos do zero para forçar re-request das imagens
    let outClicks = 0;
    if (zoomOutBtn) {
      while (outClicks < 25 && !isButtonDisabled(zoomOutBtn)) {
        zoomOutBtn.click();
        outClicks++;
        await sleep(150);
      }
      // Aguarda o viewer estabilizar com as imagens em baixa resolução
      await sleep(800);
    }

    // ── Passo 2: zoom in até o máximo ──────────────────────────────────────
    let inClicks = 0;
    while (inClicks < 30 && !isButtonDisabled(zoomInBtn)) {
      zoomInBtn.click();
      inClicks++;
      await sleep(250);
    }
    // Aguarda o viewer terminar de carregar as imagens em alta resolução
    await sleep(1000);

    return { method: 'button', outClicks, inClicks };
  }

  // ─── Scroll pela página para carregar todas as imagens ───────────────────

  async function scrollToLoadAllImages() {
    const viewerEl =
      document.querySelector('[class*="viewer"]') ||
      document.querySelector('[class*="page"]') ||
      document.documentElement;

    const totalHeight = Math.max(
      document.body.scrollHeight,
      viewerEl.scrollHeight
    );
    const step = window.innerHeight * 0.8;
    let current = 0;

    while (current < totalHeight) {
      window.scrollBy(0, step);
      current += step;
      await sleep(300);
    }

    // Volta ao topo
    await sleep(500);
    window.scrollTo(0, 0);
  }

  // ─── Captura imagens via Performance API ─────────────────────────────────

  function getImagesFromPerformance() {
    const entries = performance.getEntriesByType('resource');
    return entries
      .filter((e) => {
        const isImage =
          e.initiatorType === 'img' ||
          /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(e.name);
        const notUI =
          !e.name.includes('favicon') &&
          !e.name.includes('icon') &&
          !e.name.includes('logo');
        return isImage && notUI;
      })
      .map((e) => {
        // transferSize > 0  → veio da rede (bytes reais trafegados)
        // transferSize === 0 e decodedBodySize > 0 → veio do disk cache
        const fromCache = e.transferSize === 0 && e.decodedBodySize > 0;
        const size = fromCache
          ? e.decodedBodySize
          : e.transferSize || e.encodedBodySize || 0;
        return {
          url: e.name,
          size,
          source: fromCache ? 'disk_cache' : 'network',
          duration: e.duration,
        };
      })
      .filter((e) => e.size > 0);
  }

  // ─── Listener de mensagens do popup ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ alive: true, url: window.location.href });

    } else if (message.action === 'enterFullscreen') {
      enterViewerFullscreen().then((result) => sendResponse({ success: true, result }));

    } else if (message.action === 'clearPerformanceTiming') {
      performance.clearResourceTimings();
      sendResponse({ success: true });

    } else if (message.action === 'applyMaxZoom') {
      applyMaxZoom().then((result) => sendResponse({ success: true, result }));

    } else if (message.action === 'scrollAndLoad') {
      scrollToLoadAllImages().then(() => sendResponse({ success: true }));

    } else if (message.action === 'getPerformanceImages') {
      const images = getImagesFromPerformance();
      sendResponse({ images, total: images.length });
    }

    return true;
  });
})();
