// The reading queue, kept in extension storage. Items are either saved articles
// ({kind: 'article', title, html, url, byline, siteName}) or links to fetch at build time
// ({kind: 'url', url, title}).
(function (global) {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const KEY = 'queue';

  async function load() {
    const stored = await api.storage.local.get(KEY);
    return stored[KEY] || [];
  }

  async function save(items) {
    await api.storage.local.set({ [KEY]: items });
  }

  // Re-adding a page replaces its earlier entry, so re-saving after a fix doesn't duplicate it
  async function add(item) {
    const items = (await load()).filter((existing) => !item.url || existing.url !== item.url);
    items.push({ id: crypto.randomUUID(), addedAt: new Date().toISOString(), ...item });
    await save(items);
    return items.length;
  }

  async function remove(ids) {
    const drop = new Set(ids);
    const items = (await load()).filter((item) => !drop.has(item.id));
    await save(items);
    return items;
  }

  function onChange(callback) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) callback(changes[KEY].newValue || []);
    });
  }

  global.KindleQueue = { api, load, add, remove, onChange };
})(globalThis);
