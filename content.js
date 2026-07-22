// content.js - Script injetado na página do PressReader

(function () {
  'use strict';

  // Evita inicialização duplicada
  if (window.__valorExtractorLoaded) return;
  window.__valorExtractorLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Rastreia se a página já foi ampliada por nós (o clique é um toggle:
  // clicar de novo sem isso desfaria o zoom em vez de aplicar).
  let pageIsZoomed = false;

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

  // ─── Zoom da página (clique único na área da página) ─────────────────────
  // O visualizador atual não tem mais botões de zoom-in/zoom-out: a página
  // inteira é clicável (cursor de mão) e alterna entre normal e ampliada.

  function simulateClick(el, x, y) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function findPageZoomTarget() {
    const container =
      document.querySelector('.layout') ||
      document.querySelector('[class*="viewer"]') ||
      document.querySelector('[class*="reader"]') ||
      document.querySelector('[class*="page"]') ||
      document.documentElement;

    const rect = container.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Evita cair em cima do hotspot de um artigo específico (.block) —
    // sobe pro container da página para simular um clique em área neutra.
    let el = document.elementFromPoint(x, y) || container;
    while (el && el.classList && el.classList.contains('block') && el.parentElement) {
      el = el.parentElement;
    }
    return { el: el || container, x, y };
  }

  async function applyMaxZoom() {
    if (pageIsZoomed) {
      // Já ampliada por uma captura anterior nesta mesma página — clicar de
      // novo desfaria o zoom (é um toggle), então não repete o clique.
      return { method: 'already-zoomed' };
    }

    const { el, x, y } = findPageZoomTarget();
    simulateClick(el, x, y);
    pageIsZoomed = true;
    // Aguarda a imagem em alta resolução carregar após o clique
    await sleep(1500);
    return {
      method: 'click',
      target: el.tagName + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''),
    };
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
