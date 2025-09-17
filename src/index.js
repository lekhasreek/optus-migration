// src/index.js
import Resolver from '@forge/resolver';
import api, { route, storage } from '@forge/api';

const resolver = new Resolver();

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractHtmlFromNode(node = {}) {
  let html = '';
  if (!node) return '';

  if (node.detail?.title) {
    html += `<h2>${escapeHtml(node.detail.title)}</h2>`;
  }

  if (Array.isArray(node.fields)) {
    for (const f of node.fields) {
      if (!f?.name) continue;
      if (f.name === 'Text' && f.value) {
        html += f.value; // already HTML
      } else if ((f.name === 'DocumentTitle' || f.name === 'ParagraphTitle') && f.value) {
        html += `<h3>${escapeHtml(f.value)}</h3>`;
      }
    }
  }

  if (node.external?.information) {
    for (const info of node.external.information) {
      if (info?.content) html += info.content;
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      html += extractHtmlFromNode(child);
    }
  }
  return html;
}

// Rewrite anchors that carry a data-itemid attribute to point at the app redirect
// Use a relative path; the deployed app will serve this static page at /create
const BASE_REDIRECT_URL = '/create';

function rewriteLinksForRedirect(html = '', spaceId) {
  if (!html) return html;
  // Replace anchors with data-itemid="..." and preserve inner text
  return html.replace(/<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, id, post, inner) => {
    const href = `${BASE_REDIRECT_URL}?itemId=${encodeURIComponent(id)}${spaceId ? `&spaceId=${encodeURIComponent(String(spaceId))}` : ''}&title=${encodeURIComponent(String(inner).slice(0,200))}`;
    return `<a href="${href}">${inner}</a>`;
  });
}

// Internal helper: ensure page exists for an itemId and return page metadata
async function ensurePageForItemInternal(itemId, spaceId, title) {
  if (!itemId) return { error: 'Missing itemId' };
  if (!spaceId) return { error: 'Missing spaceId' };

  const mapKey = `item-map:${itemId}`;
  try {
    const existing = await storage.get(mapKey);
    if (existing && existing.pageId) {
      const webui = `/wiki/spaces/${encodeURIComponent(String(spaceId))}/pages/${encodeURIComponent(String(existing.pageId))}`;
      return { ok: true, pageId: existing.pageId, webui };
    }
  } catch (e) {
    console.log('ensurePageForItemInternal: storage.get failed', e);
  }

  // Create new page with placeholder body and set title based on link text
  const created = await createPage(spaceId, title || `Migrated item ${itemId}`, undefined, 'To be Migrated!');
  const newPageId = created && (created.id || (created.results && created.results[0] && created.results[0].id));
  if (!newPageId) return { error: 'Could not determine created page id' };

  try {
    await storage.set(mapKey, { pageId: String(newPageId), createdAt: new Date().toISOString() });
  } catch (e) {
    console.log('ensurePageForItemInternal: storage.set failed', e);
  }

  const webui = `/wiki/spaces/${encodeURIComponent(String(spaceId))}/pages/${encodeURIComponent(String(newPageId))}`;
  return { ok: true, pageId: String(newPageId), webui };
}

// Replace anchors with data-itemid in HTML with direct webui links by creating/looking up pages
async function replaceItemLinksWithWebui(html = '', spaceId) {
  if (!html) return html;
  const regex = /<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi;
  const ids = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.add(match[2]);
  }

  if (ids.size === 0) return html;

  const mapping = {};
  for (const id of ids) {
    try {
      const res = await ensurePageForItemInternal(id, spaceId, `Migrated item ${id}`);
      if (res && res.ok && res.webui) {
        const page = await getPageById(res.pageId);
        const pageTitle = page.title || `Migrated item ${id}`;
        mapping[id] = { webui: res.webui, title: pageTitle };
      } else {
        mapping[id] = null;
      }
    } catch (e) {
      console.log('replaceItemLinksWithWebui: failed for', id, e);
      mapping[id] = null;
    }
  }

  // Now replace anchors using the mapping
  return html.replace(/<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, id, post, inner) => {
    const entry = mapping[id];
    if (entry && entry.webui) {
      return `<a href="${entry.webui}">${escapeHtml(inner)}</a>`; // Keep link name unchanged
    }
    // Fallback to original anchor if mapping failed
    return m;
  });
}

async function getSpaceIdFromKey(spaceKey) {
  if (!spaceKey) return null;
  const res = await api.asApp().requestConfluence(
    route`/wiki/api/v2/spaces?key=${encodeURIComponent(spaceKey)}`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) return null;
  const j = await res.json();
  if (Array.isArray(j.results) && j.results.length > 0) return j.results[0].id;
  return null;
}

async function getPageById(pageId) {
  // First try as the app installation (default). If the app is not able
  // to see the page (404), try as the current user as a diagnostic/fallback.
  // This helps distinguish "page does not exist" from "app lacks access".
  const asAppRes = await api.asApp().requestConfluence(
    route`/wiki/api/v2/pages/${pageId}`,
    { headers: { 'Accept': 'application/json' } }
  );

  if (asAppRes.ok) {
    return await asAppRes.json();
  }

  const asAppText = await asAppRes.text();
  console.log('getPageById: asApp failed', { pageId, status: asAppRes.status, body: asAppText });

  // If the app returned 404, try asUser to see if the currently signed-in user
  // can access the page (this can indicate a permissions problem for the app).
  if (asAppRes.status === 404) {
    try {
      const asUserRes = await api.asUser().requestConfluence(
        route`/wiki/api/v2/pages/${pageId}`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (asUserRes.ok) {
        console.log('getPageById: asUser succeeded while asApp returned 404', { pageId });
        return await asUserRes.json();
      }
      const asUserText = await asUserRes.text();
      console.log('getPageById: asUser also failed', { pageId, status: asUserRes.status, body: asUserText });
    } catch (e) {
      console.log('getPageById: asUser request errored', e);
    }
  }

  // If we reach here, surface the original asApp error (with body) to the caller.
  throw new Error(`GET page failed: ${asAppRes.status} ${asAppText}`);
}

async function updatePage(pageId, title, spaceId, htmlValue, currentVersionNumber) {
  const bodyData = {
    id: String(pageId),
    status: 'current',
    title,
    spaceId: String(spaceId),
    body: {
      representation: 'storage',
      value: `<div>${htmlValue}</div>`
    },
    version: {
      number: (currentVersionNumber ?? 0) + 1,
      message: 'Updated via Knosys → Confluence migration'
    }
  };

  // Try updating as the app first. If the app can't see the page (404),
  // retry as the current user so we can determine whether the page exists
  // but the app lacks access (Confluence hides existence from unauthorized apps).
  const asAppRes = await api.asApp().requestConfluence(
    route`/wiki/api/v2/pages/${pageId}`,
    {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyData)
    }
  );

  const asAppText = await asAppRes.text();
  if (asAppRes.ok) {
    return JSON.parse(asAppText);
  }

  console.log('updatePage: asApp failed', { pageId, status: asAppRes.status, body: asAppText });

  // If app got 404, try asUser to check if the page exists or user has permissions.
  if (asAppRes.status === 404) {
    try {
      const asUserRes = await api.asUser().requestConfluence(
        route`/wiki/api/v2/pages/${pageId}`,
        {
          method: 'PUT',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(bodyData)
        }
      );

      const asUserText = await asUserRes.text();
      if (asUserRes.ok) {
        console.log('updatePage: asUser update succeeded while asApp returned 404', { pageId });
        return JSON.parse(asUserText);
      }
      console.log('updatePage: asUser also failed', { pageId, status: asUserRes.status, body: asUserText });
    } catch (e) {
      console.log('updatePage: asUser request errored', e);
    }
  }

  // Surface the original asApp error to the caller.
  throw new Error(`PUT page failed: ${asAppRes.status} ${asAppText}`);
}

async function createPage(spaceId, title, parentId, htmlValue) {
  const bodyData = {
    spaceId: String(spaceId),
    status: 'current',
    title,
  ...(parentId ? { parentId: String(parentId) } : {}),
  body: {
      representation: 'storage',
      value: `<div>${htmlValue}</div>`
    },
  // Removing 'subtype: "live"' so pages are created in normal (view) mode
  };

  const res = await api.asApp().requestConfluence(
    route`/wiki/api/v2/pages`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyData)
    }
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST create page failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

resolver.define('listSpaces', async () => {
  try {
    const res = await api.asApp().requestConfluence(
      route`/wiki/api/v2/spaces?limit=50`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) {
      const text = await res.text();
      return { error: `Failed to fetch spaces: ${res.status} ${text}` };
    }

    const data = await res.json();
    const spaces = (data.results || []).map(s => ({
      id: s.id,
      key: s.key,
      name: s.name,
    }));

    return { ok: true, spaces };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

resolver.define('migrateJsonToPage', async (req) => {
  try {
    const payload = req.payload || {};
    const knosysJson = payload.json || payload;
    if (!knosysJson) return { error: 'Missing JSON payload under "json"' };

    const htmlBody = extractHtmlFromNode(knosysJson) || '<p>(no content extracted)</p>';
    const title =
      payload.title ||
      knosysJson.detail?.title ||
      (knosysJson.fields?.find(f => f.name === 'DocumentTitle')?.value) ||
      'Migrated page from Knosys';

    // --- UPDATE EXISTING PAGE ---
    if (payload.pageId) {
      if (!payload.spaceId) {
        return { error: 'spaceId is required for updating a page' };
      }
      const pageIdToUpdate = String(payload.pageId);

      // Just get version number from Confluence
      const existing = await getPageById(pageIdToUpdate);
      const currentVersionNumber = existing.version?.number ?? 0;

      // For updates, pre-resolve item links so they open directly
      let processedHtml = await replaceItemLinksWithWebui(htmlBody, payload.spaceId);
      // Also keep redirect-style links for any items not handled
      processedHtml = rewriteLinksForRedirect(processedHtml, payload.spaceId);
      const updated = await updatePage(
        pageIdToUpdate,
        title,
        payload.spaceId,   // ✅ always trust frontend spaceId
        processedHtml,
        currentVersionNumber
      );
      return { ok: true, action: 'updated', page: updated };
    }

    // --- CREATE NEW PAGE ---
    let targetSpaceId = payload.spaceId || null;
    if (!targetSpaceId && payload.spaceKey) {
      targetSpaceId = await getSpaceIdFromKey(payload.spaceKey);
      if (!targetSpaceId) return { error: `Space not found for key: ${payload.spaceKey}` };
    }
    if (!targetSpaceId) return { error: 'Missing spaceId or spaceKey in payload' };

    // For creates, pre-resolve item links (create placeholders) so links work immediately
    let processedHtml = await replaceItemLinksWithWebui(htmlBody, targetSpaceId);
    // Keep redirect-style links for any remaining items
    processedHtml = rewriteLinksForRedirect(processedHtml, targetSpaceId);
    const created = await createPage(
      targetSpaceId,
      title,
      payload.createAsChildOf || undefined,
      processedHtml
    );
    return { ok: true, action: 'created', page: created };

  } catch (err) {
    console.error('migrateJsonToPage error', err);
    return { error: err.message || String(err) };
  }
});

// Ensure a Confluence page exists for an external item id. If missing,
// create it and persist a mapping in Forge storage.
resolver.define('ensurePageForItem', async (req) => {
  try {
  const { itemId, spaceId, title } = req.payload || req.query || {};
  console.log('ensurePageForItem called', { payload: req.payload, query: req.query });
    if (!itemId) return { error: 'Missing itemId' };
    if (!spaceId) return { error: 'Missing spaceId' };

    const mapKey = `item-map:${itemId}`;
    try {
      const existing = await storage.get(mapKey);
      if (existing && existing.pageId) {
        const webui = `/wiki/spaces/${encodeURIComponent(String(spaceId))}/pages/${encodeURIComponent(String(existing.pageId))}`;
        return { ok: true, pageId: existing.pageId, webui };
      }
    } catch (e) {
      console.log('ensurePageForItem: storage.get failed', e);
    }

    // Create new page with required placeholder body
    const created = await createPage(spaceId, title || `Migrated item ${itemId}`, undefined, 'To be Migrated!');
    const newPageId = created && (created.id || (created.results && created.results[0] && created.results[0].id));
    if (!newPageId) return { error: 'Could not determine created page id' };

    try {
      await storage.set(mapKey, { pageId: String(newPageId), createdAt: new Date().toISOString() });
    } catch (e) {
      console.log('ensurePageForItem: storage.set failed', e);
    }

    const webui = `/wiki/spaces/${encodeURIComponent(String(spaceId))}/pages/${encodeURIComponent(String(newPageId))}`;
    return { ok: true, pageId: String(newPageId), webui };
  } catch (err) {
    console.error('ensurePageForItem error', err);
    return { error: err.message || String(err) };
  }
});

export const handler = resolver.getDefinitions();
