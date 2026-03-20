// extractor.js — injetado na aba para extrair o conteúdo da matéria
// Usa Mozilla Readability (já injetado antes deste script).

(function () {
  'use strict';

  // --- Helpers de metadata ---

  function getMeta(names) {
    for (const name of names) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`);
      if (el) {
        const v = el.getAttribute('content');
        if (v && v.trim()) return v.trim();
      }
    }
    return '';
  }

  function getJsonLd(field) {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const candidates = Array.isArray(data) ? data : [data];
        for (const obj of candidates) {
          if (obj[field]) {
            const val = obj[field];
            if (typeof val === 'string') return val.trim();
            if (typeof val === 'object' && val.name) return val.name.trim();
          }
        }
      } catch (_) {}
    }
    return '';
  }

  function formatDate(raw) {
    if (!raw) return '';
    try {
      return new Date(raw).toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      });
    } catch (_) {
      return raw;
    }
  }

  // --- Extração via Readability ---

  const docClone = document.cloneNode(true);
  const reader = new Readability(docClone, { keepClasses: false });
  const article = reader.parse();

  if (!article) {
    return { error: 'Não foi possível extrair o conteúdo desta página. Tente em uma matéria aberta.' };
  }

  // --- Metadata complementar ---

  const title   = article.title || getMeta(['og:title', 'twitter:title']) || document.title || '';
  const excerpt = article.excerpt
    || getMeta(['og:description', 'description', 'twitter:description'])
    || '';
  const author  = article.byline
    || getMeta(['author', 'article:author', 'DC.creator'])
    || getJsonLd('author')
    || '';
  const dateRaw = getMeta(['article:published_time', 'datePublished', 'DC.date'])
    || getJsonLd('datePublished')
    || '';
  const date    = formatDate(dateRaw);
  const siteName = article.siteName
    || getMeta(['og:site_name'])
    || getJsonLd('publisher')
    || window.location.hostname.replace(/^www\./, '');
  const url     = window.location.href;

  // --- Texto limpo do corpo ---

  const tmp = document.createElement('div');
  tmp.innerHTML = article.content || '';

  // Remove elementos residuais indesejados
  tmp.querySelectorAll('figure, figcaption, img, video, iframe, aside, .related, [class*="ad"], [class*="banner"], [id*="ad"]').forEach(el => el.remove());

  const bodyText = (tmp.innerText || tmp.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, excerpt, author, date, siteName, url, bodyText };
})();
