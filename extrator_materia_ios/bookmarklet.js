/**
 * bookmarklet.js — Extrator de Matérias para WhatsApp (Safari iOS)
 *
 * Versão legível/fonte. O arquivo bookmarklet.min.js contém a versão
 * compactada pronta para uso como bookmarklet no Safari.
 *
 * Como funciona:
 *   1. Carrega o Readability.js da Mozilla via CDN (jsDelivr)
 *   2. Extrai título, subtítulo, autor, data, veículo e corpo da matéria
 *   3. Exibe um modal com o texto já formatado para WhatsApp
 *   4. Botão "Copiar" transfere para o clipboard do iOS
 */

(function () {
  'use strict';

  // Evita execução dupla
  if (window.__extrator_whatsapp_running) return;
  window.__extrator_whatsapp_running = true;

  // ─── Constantes ────────────────────────────────────────────────────────────

  const READABILITY_CDN =
    'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.min.js';

  // ─── Helpers de metadata ───────────────────────────────────────────────────

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
        day: '2-digit', month: '2-digit', year: 'numeric',
      });
    } catch (_) { return raw; }
  }

  // ─── Extração ──────────────────────────────────────────────────────────────

  function extract() {
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone, { keepClasses: false });
    const article = reader.parse();

    if (!article) return null;

    const title    = article.title || getMeta(['og:title', 'twitter:title']) || document.title || '';
    const excerpt  = article.excerpt || getMeta(['og:description', 'description', 'twitter:description']) || '';
    const author   = article.byline || getMeta(['author', 'article:author', 'DC.creator']) || getJsonLd('author') || '';
    const dateRaw  = getMeta(['article:published_time', 'datePublished', 'DC.date']) || getJsonLd('datePublished') || '';
    const date     = formatDate(dateRaw);
    const siteName = article.siteName || getMeta(['og:site_name']) || getJsonLd('publisher') || window.location.hostname.replace(/^www\./, '');
    const url      = window.location.href;

    const tmp = document.createElement('div');
    tmp.innerHTML = article.content || '';
    tmp.querySelectorAll('figure,figcaption,img,video,iframe,aside,[class*="ad"],[class*="banner"],[id*="ad"]').forEach(el => el.remove());
    const bodyText = (tmp.innerText || tmp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();

    return { title, excerpt, author, date, siteName, url, bodyText };
  }

  // ─── Formatação WhatsApp ───────────────────────────────────────────────────

  function formatForWhatsApp(d) {
    const lines = [];
    lines.push(d.url || '');
    lines.push('');
    if (d.title)    lines.push(`*${d.title}*`);
    if (d.excerpt)  lines.push(`_${d.excerpt}_`);
    const meta = [d.date, d.author].filter(Boolean).join(' | ');
    if (meta)       lines.push(meta);
    if (d.siteName) lines.push(d.siteName);
    lines.push('');
    lines.push('—');
    lines.push('');
    if (d.bodyText) lines.push(d.bodyText);
    return lines.join('\n');
  }

  // ─── Modal ─────────────────────────────────────────────────────────────────

  function showModal(text, isError) {
    // Remove modal anterior se existir
    const existing = document.getElementById('__extrator_modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '__extrator_modal';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(0,0,0,0.75)', 'display:flex',
      'align-items:flex-end', 'justify-content:center',
      'padding:0', 'font-family:-apple-system,sans-serif',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#1c1c1e', 'border-radius:20px 20px 0 0',
      'width:100%', 'max-width:700px', 'padding:20px 16px 40px',
      'display:flex', 'flex-direction:column', 'gap:14px',
      'max-height:85vh',
    ].join(';');

    const handle = document.createElement('div');
    handle.style.cssText = 'width:36px;height:4px;background:#48484a;border-radius:2px;margin:0 auto 4px';

    const title = document.createElement('div');
    title.style.cssText = 'color:#fff;font-size:16px;font-weight:700;text-align:center';
    title.textContent = isError ? '⚠️ Não foi possível extrair' : '📋 Pronto para o WhatsApp';

    if (isError) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#ff453a;font-size:13px;text-align:center;padding:10px';
      msg.textContent = text;
      card.append(handle, title, msg);
      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Fechar';
      styleBtn(closeBtn, '#48484a');
      closeBtn.addEventListener('click', () => overlay.remove());
      card.appendChild(closeBtn);
    } else {
      const textarea = document.createElement('textarea');
      textarea.readOnly = true;
      textarea.value = text;
      textarea.style.cssText = [
        'background:#2c2c2e', 'border:none', 'border-radius:12px',
        'color:#e5e5ea', 'font-size:12px', 'line-height:1.6',
        'padding:12px', 'resize:none', 'flex:1',
        'min-height:180px', 'max-height:50vh',
        'overflow-y:auto', 'font-family:-apple-system,sans-serif',
      ].join(';');

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:10px';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copiar para WhatsApp';
      styleBtn(copyBtn, '#25d366', '#000');
      copyBtn.style.flex = '1';
      copyBtn.addEventListener('click', () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flash(copyBtn));
          } else {
            textarea.select();
            document.execCommand('copy');
            flash(copyBtn);
          }
        } catch (e) {
          textarea.select();
        }
      });

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Fechar';
      styleBtn(closeBtn, '#48484a');
      closeBtn.addEventListener('click', () => overlay.remove());

      btnRow.append(copyBtn, closeBtn);
      card.append(handle, title, textarea, btnRow);
    }

    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function styleBtn(btn, bg, color) {
    btn.style.cssText = [
      `background:${bg}`, `color:${color || '#fff'}`,
      'border:none', 'border-radius:12px', 'padding:14px 18px',
      'font-size:15px', 'font-weight:600', 'cursor:pointer',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
  }

  function flash(btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ Copiado!';
    btn.style.background = '#065f46';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = '#25d366';
    }, 2500);
  }

  // ─── Loader: injeta Readability via CDN ────────────────────────────────────

  function loadReadability(callback) {
    if (typeof Readability !== 'undefined') { callback(); return; }

    const script = document.createElement('script');
    script.src = READABILITY_CDN;
    script.onload = callback;
    script.onerror = () => {
      delete window.__extrator_whatsapp_running;
      showModal('Falha ao carregar biblioteca de extração. Verifique a conexão.', true);
    };
    document.head.appendChild(script);
  }

  // ─── Entry point ───────────────────────────────────────────────────────────

  loadReadability(() => {
    const data = extract();

    if (!data || !data.bodyText || data.bodyText.length < 80) {
      delete window.__extrator_whatsapp_running;
      showModal(
        'Não foi possível extrair o conteúdo. A página pode ter paywall, proteção JavaScript ou não ser uma matéria.',
        true
      );
      return;
    }

    const formatted = formatForWhatsApp(data);
    delete window.__extrator_whatsapp_running;
    showModal(formatted, false);
  });

})();
