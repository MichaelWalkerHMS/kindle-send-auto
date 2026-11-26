// Turns a page Document into a clean article. Runs both inside the page (popup "Save
// article", where the live, logged-in DOM is available) and in the queue page for URLs
// fetched later. Requires lib/Readability.js to be loaded first.
(function (global) {
  'use strict';

  const FOOTNOTE_MARKER = /^[\[(]?([0-9]{1,3}|[*†‡§]+)[\])]?$/;

  function extract(doc, url) {
    if (typeof Readability === 'undefined') {
      throw new Error('Readability is not loaded');
    }
    // Cloned so the live page is never modified; Readability mutates its input, hence a
    // second clone, keeping `source` intact for footnote lookups.
    const source = doc.cloneNode(true);
    resolveStreamedContent(source);
    const parsed = new Readability(source.cloneNode(true)).parse();
    if (!parsed || !parsed.content) {
      throw new Error('Could not find article content on this page');
    }

    // An inert document: images inserted here don't start downloading, unlike a
    // detached element owned by the live page.
    const work = doc.implementation.createHTMLDocument('');
    const container = work.createElement('div');
    container.innerHTML = parsed.content;

    addFootnotes(container, source, url);
    container.querySelectorAll('img').forEach((img) => promoteLargestSrcset(img, url));

    return {
      title: (parsed.title || doc.title || url).trim(),
      byline: (parsed.byline || '').trim(),
      siteName: (parsed.siteName || '').trim(),
      url,
      html: container.innerHTML,
    };
  }

  // React streaming server rendering (Next.js, LessWrong) sends page content in hidden
  // <div hidden id="S:n"> chunks and relies on inline scripts to move each into its
  // <template> placeholder: $RC("B:x","S:y") completes a loading boundary, $RS("S:y","P:x")
  // fills a plain slot. Fetched pages never run those scripts and Readability skips hidden
  // elements, so without this the article comes out empty.
  function resolveStreamedContent(doc) {
    const swaps = [];
    for (const script of Array.from(doc.querySelectorAll('script:not([src])'))) {
      for (const m of script.textContent.matchAll(/\$R([CS])\("([^"]+)","([^"]+)"/g)) {
        if (m[1] === 'C') swaps.push({ placeholderId: m[2], chunkId: m[3], boundary: true });
        else swaps.push({ placeholderId: m[3], chunkId: m[2], boundary: false });
      }
    }
    // Pages whose scripts use other names still number chunks and placeholders alike
    if (!swaps.length) {
      for (const chunk of Array.from(doc.querySelectorAll('div[hidden][id^="S:"]'))) {
        const n = chunk.id.slice(2);
        swaps.push({ placeholderId: 'B:' + n, chunkId: chunk.id, boundary: true });
        swaps.push({ placeholderId: 'P:' + n, chunkId: chunk.id, boundary: false });
      }
    }

    let pending = swaps;
    // A chunk can carry placeholders for chunks listed before it, so repeat until stuck
    while (pending.length) {
      const stuck = [];
      for (const swap of pending) {
        const chunk = doc.getElementById(swap.chunkId);
        const placeholder = doc.getElementById(swap.placeholderId);
        if (!chunk) continue;
        if (!placeholder || placeholder.tagName !== 'TEMPLATE') {
          stuck.push(swap);
          continue;
        }
        if (swap.boundary) removeBoundaryFallback(placeholder);
        placeholder.replaceWith(...Array.from(chunk.childNodes));
        chunk.remove();
      }
      if (stuck.length === pending.length) break;
      pending = stuck;
    }
  }

  // A boundary's loading fallback sits between its placeholder and the matching <!--/$-->
  function removeBoundaryFallback(placeholder) {
    let depth = 0;
    let node = placeholder.nextSibling;
    while (node) {
      const next = node.nextSibling;
      if (node.nodeType === Node.COMMENT_NODE) {
        if (node.data === '/$') {
          if (depth === 0) return;
          depth--;
        } else if (node.data.startsWith('$')) {
          depth++;
        }
      }
      node.remove();
      node = next;
    }
  }

  function stripHash(href) {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  }

  // Readability rewrites "#id" links to absolute "page-url#id" when the document's base
  // differs from its URL (as with fetched pages), so both forms count as in-page links.
  function localTarget(href, pageURL) {
    if (!href) return null;
    try {
      if (href.startsWith('#')) return decodeURIComponent(href.slice(1)) || null;
      const u = new URL(href, pageURL);
      if (u.hash && stripHash(u.href) === pageURL) return decodeURIComponent(u.hash.slice(1)) || null;
    } catch (e) {
      // Malformed href or escape sequence: not an in-page link
    }
    return null;
  }

  function findById(root, id) {
    return root.querySelector('[id="' + CSS.escape(id) + '"]');
  }

  // The id often sits on just the note's number (Substack: <a id="footnote-1">1</a>,
  // sometimes wrapped in <sup>/<p>); climb until the element holds the note's text.
  function noteElement(target, root) {
    let el = target;
    while (el.parentElement && el !== root) {
      const text = el.textContent.trim();
      if (text && !FOOTNOTE_MARKER.test(text)) break;
      el = el.parentElement;
    }
    return el === root ? null : el;
  }

  function markReference(ref) {
    ref.setAttribute('epub:type', 'noteref');
    ref.removeAttribute('target');
    if (ref.parentElement && !ref.closest('sup')) {
      const sup = ref.ownerDocument.createElement('sup');
      ref.replaceWith(sup);
      sup.append(ref);
    }
  }

  // Footnotes become EPUB3 noteref/footnote pairs, which Kindle shows as popups; the
  // two-way links are what older Kindle firmware keys on. Readability sometimes keeps a
  // page's notes as ordinary paragraphs and sometimes drops them (leaving references that
  // point nowhere), so notes are converted in place or recovered from the original page.
  function addFootnotes(container, originalDoc, url) {
    const work = container.ownerDocument;
    const pageURL = stripHash(url);
    const handled = new Set();
    const recovered = [];

    for (const ref of Array.from(container.querySelectorAll('a[href]'))) {
      // Links inside notes converted earlier in this loop are gone from the container
      if (!container.contains(ref)) continue;
      const targetId = localTarget(ref.getAttribute('href'), pageURL);
      if (!targetId) continue;
      ref.setAttribute('href', '#' + targetId);

      const marker = ref.textContent.trim();
      if (!FOOTNOTE_MARKER.test(marker)) continue;
      if (handled.has(targetId)) {
        markReference(ref);
        continue;
      }

      const inArticle = findById(container, targetId);
      const source = inArticle || originalDoc.getElementById(targetId);
      if (!source) continue;
      const sourceNote = noteElement(source, inArticle ? container : originalDoc.body);
      // A note "containing" its own reference means this link is a note's back-link
      // pointing into running text, not a reference
      if (!sourceNote || (inArticle && sourceNote.contains(ref))) continue;

      const note = inArticle ? sourceNote : work.importNode(sourceNote, true);
      note.querySelectorAll('a[href]').forEach((a) => {
        if (localTarget(a.getAttribute('href'), pageURL)) a.remove();
      });
      // Removing the number can leave an empty paragraph the back-link would land in
      note.querySelectorAll('p, sup, span, div').forEach((el) => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
      });
      if (!note.textContent.trim()) continue;

      let refId = ref.getAttribute('id');
      if (!refId) {
        refId = 'noteref-' + targetId;
        ref.setAttribute('id', refId);
      }

      const aside = work.createElement('aside');
      aside.setAttribute('epub:type', 'footnote');
      aside.setAttribute('id', targetId);
      // Children only: the note element may be an <li>, or carry an id that would clash
      aside.append(...Array.from(note.childNodes));
      const backlink = work.createElement('a');
      backlink.setAttribute('href', '#' + refId);
      backlink.textContent = marker;
      const firstParagraph = aside.querySelector('p');
      (firstParagraph || aside).prepend(backlink, ' ');

      if (!inArticle) {
        recovered.push(aside);
      } else if (note.tagName === 'LI') {
        // Keep the list valid; the aside now carries the id
        note.removeAttribute('id');
        note.append(aside);
      } else {
        note.replaceWith(aside);
      }
      handled.add(targetId);
      markReference(ref);
    }

    if (recovered.length) {
      container.append(work.createElement('hr'), ...recovered);
    }
  }

  // Download the highest-resolution srcset candidate rather than the (often small) src
  function promoteLargestSrcset(img, url) {
    const srcset = img.getAttribute('srcset');
    if (!srcset) return;
    let bestURL = '';
    let bestWidth = 0;
    // Substack-style URLs contain commas, so candidates are split on comma + whitespace
    for (const candidate of srcset.split(/,\s+/)) {
      const [candidateURL, descriptor] = candidate.trim().split(/\s+/);
      if (!descriptor || !descriptor.endsWith('w')) continue;
      const width = parseInt(descriptor, 10);
      if (width > bestWidth) {
        bestURL = candidateURL;
        bestWidth = width;
      }
    }
    if (bestURL) {
      try {
        img.setAttribute('src', new URL(bestURL, url).href);
      } catch (e) {
        // Keep the original src
      }
    }
  }

  global.KindleArticle = { extract };
})(globalThis);
