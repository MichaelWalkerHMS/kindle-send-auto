// Builds an EPUB3 file from extracted articles: downloads and compresses images, cleans
// markup into well-formed XHTML, and zips it all. Needs a DOM with canvas (an extension page).
(function (global) {
  'use strict';

  // Leave zoom headroom above current Kindle screens (Paperwhite 1236x1648, Scribe 1860x2480)
  const MAX_IMAGE_WIDTH = 1800;
  const MAX_IMAGE_HEIGHT = 2400;
  const JPEG_QUALITY = 0.9;
  // Tracking pixels and icons
  const MIN_IMAGE_SIZE = 32;
  const IMAGE_CONCURRENCY = 4;

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const REMOVED_ELEMENTS =
    'script, style, noscript, iframe, form, input, button, select, textarea, svg, video, audio, ' +
    'object, embed, canvas, source, template, link, meta';
  // An allowlist keeps the output valid XML: pages carry attribute names like "@click"
  // or ":class" that XMLSerializer would emit verbatim and break the file.
  const KEPT_ATTRIBUTES = new Set([
    'href', 'src', 'alt', 'title', 'id', 'colspan', 'rowspan', 'epub:type', 'lang', 'dir', 'start',
  ]);
  const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

  function escapeXml(text) {
    return String(text)
      .replace(INVALID_XML_CHARS, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unwrap(el) {
    el.replaceWith(...Array.from(el.childNodes));
  }

  function cleanMarkup(body, baseURL) {
    body.querySelectorAll(REMOVED_ELEMENTS).forEach((el) => el.remove());
    body.querySelectorAll('picture').forEach(unwrap);
    // Kindle only opens its image zoom view for images that aren't links
    body.querySelectorAll('a').forEach((a) => {
      if (a.querySelector('img')) unwrap(a);
    });

    for (const el of Array.from(body.querySelectorAll('*'))) {
      // Custom elements aren't valid EPUB content
      if (el.localName.includes('-')) {
        unwrap(el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        if (!KEPT_ATTRIBUTES.has(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.localName === 'a') {
        const href = el.getAttribute('href');
        if (!href) continue;
        if (href.startsWith('#')) continue;
        try {
          const abs = new URL(href, baseURL);
          if (abs.protocol === 'http:' || abs.protocol === 'https:' || abs.protocol === 'mailto:') {
            el.setAttribute('href', abs.href);
          } else {
            el.removeAttribute('href');
          }
        } catch (e) {
          el.removeAttribute('href');
        }
      }
    }
  }

  async function decodeImage(blob) {
    try {
      return await createImageBitmap(blob);
    } catch (e) {
      // createImageBitmap rejects SVG; an <img> element can still rasterize it
      const objectURL = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = objectURL;
        await img.decode();
        if (!img.naturalWidth) {
          img.width = 1200;
          img.height = 900;
        }
        return img;
      } finally {
        URL.revokeObjectURL(objectURL);
      }
    }
  }

  async function compressImage(blob) {
    const source = await decodeImage(blob);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) return null;

    const scale = Math.min(1, MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha; transparent PNGs would otherwise turn black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();

    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!jpeg) throw new Error('JPEG encoding failed');
    return new Uint8Array(await jpeg.arrayBuffer());
  }

  async function defaultFetchBlob(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
    return response.blob();
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await worker(items[i]);
      }
    });
    await Promise.all(runners);
  }

  function sectionXhtml(title, bodyXml) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n' +
      '<head>\n<meta charset="UTF-8"/>\n<title>' + escapeXml(title) + '</title>\n' +
      '<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n' +
      bodyXml + '\n</html>\n'
    );
  }

  const STYLESHEET = [
    'img { max-width: 100%; height: auto; display: block; margin: 1em auto; }',
    'figure { margin: 1em 0; }',
    'figcaption { font-size: 0.85em; text-align: center; }',
    '.byline, .source { font-size: 0.85em; color: #555; margin: 0 0 0.3em 0; }',
    'blockquote { margin: 1em 1.5em; font-style: italic; }',
    'aside { font-size: 0.9em; margin: 0.8em 0; }',
    'pre { white-space: pre-wrap; font-size: 0.85em; }',
  ].join('\n');

  // options.fetchBlob(url) -> Blob lets callers route downloads; options.log(message) reports progress
  async function build(bookTitle, articles, options = {}) {
    const fetchBlob = options.fetchBlob || defaultFetchBlob;
    const log = options.log || (() => {});
    const serializer = new XMLSerializer();
    const encoder = new TextEncoder();

    const images = [];
    const imageNames = new Map();
    const sections = [];

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      log('Formatting "' + article.title + '"');
      const doc = document.implementation.createHTMLDocument(article.title);
      const body = doc.body;
      body.innerHTML = article.html;
      // Pasted articles have no URL; new URL(x, '') throws, so pass no base at all
      const baseURL = article.url || undefined;
      cleanMarkup(body, baseURL);

      const imgs = Array.from(body.querySelectorAll('img'));
      await runPool(imgs, IMAGE_CONCURRENCY, async (img) => {
        let src = img.getAttribute('src');
        try {
          src = new URL(src, baseURL).href;
        } catch (e) {
          img.remove();
          return;
        }
        if (!imageNames.has(src)) {
          // Reserve the slot before awaiting so a duplicate src in flight reuses it
          const pending = (async () => {
            try {
              const data = await compressImage(await fetchBlob(src));
              if (!data) return null;
              const name = 'images/img-' + (images.length + 1) + '.jpg';
              images.push({ name, data });
              return name;
            } catch (e) {
              log('  Skipped image ' + src + ' (' + e.message + ')');
              return null;
            }
          })();
          imageNames.set(src, pending);
        }
        const name = await imageNames.get(src);
        if (name) {
          img.setAttribute('src', '../' + name);
          if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
        } else {
          img.remove();
        }
      });

      const header = doc.createElement('header');
      const h1 = doc.createElement('h1');
      h1.textContent = article.title;
      header.append(h1);
      const credit = [article.byline, article.siteName].filter(Boolean).join(' · ');
      if (credit) {
        const p = doc.createElement('p');
        p.className = 'byline';
        p.textContent = credit;
        header.append(p);
      }
      if (article.url) {
        const p = doc.createElement('p');
        p.className = 'source';
        const a = doc.createElement('a');
        a.setAttribute('href', article.url);
        a.textContent = article.url;
        p.append(a);
        header.append(p);
      }
      body.prepend(header);

      const bodyXml = serializer.serializeToString(body).replace(INVALID_XML_CHARS, '');
      sections.push({
        name: 'text/article-' + (i + 1) + '.xhtml',
        title: article.title,
        xml: sectionXhtml(article.title, bodyXml),
      });
      log('  ' + imgs.length + ' image(s) processed');
    }

    const uuid = crypto.randomUUID();
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const creator =
      articles.length === 1 ? articles[0].byline || articles[0].siteName || 'Kindle Send' : 'Various';

    const opf =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '<dc:identifier id="bookid">urn:uuid:' + uuid + '</dc:identifier>\n' +
      '<dc:title>' + escapeXml(bookTitle) + '</dc:title>\n' +
      '<dc:creator>' + escapeXml(creator) + '</dc:creator>\n' +
      '<dc:language>en</dc:language>\n' +
      '<meta property="dcterms:modified">' + modified + '</meta>\n' +
      '</metadata>\n<manifest>\n' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      '<item id="css" href="style.css" media-type="text/css"/>\n' +
      sections.map((s, i) => '<item id="s' + (i + 1) + '" href="' + s.name + '" media-type="application/xhtml+xml"/>\n').join('') +
      images.map((img, i) => '<item id="i' + (i + 1) + '" href="' + img.name + '" media-type="image/jpeg"/>\n').join('') +
      '</manifest>\n<spine toc="ncx">\n' +
      sections.map((s, i) => '<itemref idref="s' + (i + 1) + '"/>\n').join('') +
      '</spine>\n</package>\n';

    const nav =
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n' +
      '<head><meta charset="UTF-8"/><title>' + escapeXml(bookTitle) + '</title></head>\n<body>\n' +
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n' +
      sections.map((s) => '<li><a href="' + s.name + '">' + escapeXml(s.title) + '</a></li>\n').join('') +
      '</ol></nav>\n</body>\n</html>\n';

    // NCX is EPUB2-era, but older Kindle conversion still reads it for the table of contents
    const ncx =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '<head><meta name="dtb:uid" content="urn:uuid:' + uuid + '"/></head>\n' +
      '<docTitle><text>' + escapeXml(bookTitle) + '</text></docTitle>\n<navMap>\n' +
      sections
        .map(
          (s, i) =>
            '<navPoint id="np' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' +
            escapeXml(s.title) + '</text></navLabel><content src="' + s.name + '"/></navPoint>\n'
        )
        .join('') +
      '</navMap>\n</ncx>\n';

    const container =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      '</container>\n';

    // mimetype must be the first entry, stored uncompressed (the zip writer never compresses)
    const entries = [
      { name: 'mimetype', data: encoder.encode('application/epub+zip') },
      { name: 'META-INF/container.xml', data: encoder.encode(container) },
      { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
      { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
      { name: 'OEBPS/toc.ncx', data: encoder.encode(ncx) },
      { name: 'OEBPS/style.css', data: encoder.encode(STYLESHEET) },
      ...sections.map((s) => ({ name: 'OEBPS/' + s.name, data: encoder.encode(s.xml) })),
      ...images.map((img) => ({ name: 'OEBPS/' + img.name, data: img.data })),
    ];
    log('Packaged ' + sections.length + ' article(s) and ' + images.length + ' image(s)');
    return zipStored(entries);
  }

  // Minimal ZIP writer (store only). JPEGs are already compressed and EPUB requires
  // "mimetype" to be stored, so deflate would save little for the added code.
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStored(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const crc = crc32(entry.data);
      const size = entry.data.length;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, entry.data);

      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 20, true);
      header.setUint16(8, 0, true);
      header.setUint16(10, 0, true);
      header.setUint16(12, dosTime, true);
      header.setUint16(14, dosDate, true);
      header.setUint32(16, crc, true);
      header.setUint32(20, size, true);
      header.setUint32(24, size, true);
      header.setUint16(28, name.length, true);
      header.setUint32(42, offset, true);
      central.push(header.buffer, name);

      offset += 30 + name.length + size;
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/epub+zip' });
  }

  global.KindleEpub = { build };
})(globalThis);
