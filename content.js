// content.js - Script injetado na página do PressReader

(function () {
  'use strict';

  // Evita inicialização duplicada
  if (window.__valorExtractorLoaded) return;
  window.__valorExtractorLoaded = true;

  // ─── Zoom máximo no visualizador ─────────────────────────────────────────

  function findZoomInButton() {
    // PressReader usa vários seletores possíveis para o botão de zoom
    const selectors = [
      '[class*="zoom-in"]',
      '[class*="zoomIn"]',
      '[aria-label*="zoom in" i]',
      '[title*="zoom in" i]',
      '[data-action="zoom-in"]',
      'button[class*="zoom"]:not([class*="out"])',
      '.zoom-controls .in',
      '.viewer-zoom-in',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findZoomOutButton() {
    const selectors = [
      '[class*="zoom-out"]',
      '[class*="zoomOut"]',
      '[aria-label*="zoom out" i]',
      '[title*="zoom out" i]',
      '[data-action="zoom-out"]',
      '.zoom-controls .out',
      '.viewer-zoom-out',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function simulateCtrlPlus(times = 5) {
    // Simula Ctrl+= (zoom in do navegador/viewer)
    for (let i = 0; i < times; i++) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '+',
          code: 'Equal',
          keyCode: 187,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '=',
          code: 'Equal',
          keyCode: 187,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  async function applyMaxZoom() {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 15;

      const tryZoom = () => {
        const btn = findZoomInButton();

        if (btn) {
          // Clica repetidamente no botão de zoom in (até 10 vezes)
          let clicks = 0;
          const clickInterval = setInterval(() => {
            btn.click();
            clicks++;
            if (clicks >= 10) {
              clearInterval(clickInterval);
              resolve({ method: 'button', clicks });
            }
          }, 200);
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(tryZoom, 500);
        } else {
          // Fallback: usa Ctrl+= via teclado
          simulateCtrlPlus(8);
          resolve({ method: 'keyboard' });
        }
      };

      tryZoom();
    });
  }

  // ─── Scroll pela página para carregar todas as imagens ───────────────────

  async function scrollToLoadAllImages() {
    return new Promise((resolve) => {
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

      const scrollStep = () => {
        window.scrollBy(0, step);
        current += step;
        if (current < totalHeight) {
          setTimeout(scrollStep, 300);
        } else {
          // Volta ao topo
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve();
          }, 500);
        }
      };

      scrollStep();
    });
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
      .map((e) => ({
        url: e.name,
        size: e.transferSize || e.encodedBodySize || 0,
        decodedSize: e.decodedBodySize || 0,
        duration: e.duration,
      }))
      .sort((a, b) => b.size - a.size);
  }

  // ─── Listener de mensagens do popup ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ alive: true, url: window.location.href });

    } else if (message.action === 'applyMaxZoom') {
      applyMaxZoom().then((result) => sendResponse({ success: true, result }));

    } else if (message.action === 'scrollAndLoad') {
      scrollToLoadAllImages().then(() => sendResponse({ success: true }));

    } else if (message.action === 'getPerformanceImages') {
      const images = getImagesFromPerformance();
      sendResponse({ images, total: images.length });

    } else if (message.action === 'fullProcess') {
      // Executa zoom + scroll + retorna imagens da Performance API
      applyMaxZoom()
        .then(() => new Promise((r) => setTimeout(r, 1500)))
        .then(() => scrollToLoadAllImages())
        .then(() => new Promise((r) => setTimeout(r, 2000)))
        .then(() => {
          const images = getImagesFromPerformance();
          sendResponse({ success: true, images });
        });
    }

    return true;
  });
})();
