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

// Update rewriteLinksForRedirect to point to the new resolver
function rewriteLinksForRedirect(html = '', spaceId, spaceKey) {
  if (!html) return html;
  // Link should open a small redirect page in the app which calls the resolver
    return html.replace(/<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, id, post, inner) => {
    // Serve the static redirect page from the app's static resource path
    const href = `/static/hello-world/create.html?itemId=${encodeURIComponent(id)}${spaceId ? `&spaceId=${encodeURIComponent(String(spaceId))}` : ''}${spaceKey ? `&spaceKey=${encodeURIComponent(String(spaceKey))}` : ''}&title=${encodeURIComponent(String(inner).slice(0,200))}`;
    return `<a href="${href}">${inner}</a>`;
  });
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
      if (res && res.ok && res.webui) mapping[id] = res.webui;
      else mapping[id] = null;
    } catch (e) {
      console.log('replaceItemLinksWithWebui: failed for', id, e);
      mapping[id] = null;
    }
  }

  // Now replace anchors using the mapping
  return html.replace(/<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, id, post, inner) => {
    const webui = mapping[id];
    if (webui) {
      return `<a href="${webui}">${inner}</a>`;
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

async function getSpaceKeyFromId(spaceId) {
  if (!spaceId) return null;
  try {
    const res = await api.asApp().requestConfluence(
      route`/wiki/api/v2/spaces/${encodeURIComponent(String(spaceId))}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) {
      // try as user as fallback
      const asUserRes = await api.asUser().requestConfluence(
        route`/wiki/api/v2/spaces/${encodeURIComponent(String(spaceId))}`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (asUserRes.ok) {
        const j2 = await asUserRes.json();
        return j2.key || null;
      }
      return null;
    }
    const j = await res.json();
    return j.key || null;
  } catch (e) {
    console.log('getSpaceKeyFromId failed', e);
    return null;
  }
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

// Logic for creating new pages when a link is clicked.
// Checks Forge storage for an existing mapping, verifies the page still exists,
// and creates a new page with body 'To be Migrated!' when missing. Persists mapping.
async function ensurePageForItemInternal(itemId, spaceId, fallbackTitle) {
  if (!itemId) return { error: 'Missing itemId' };
  if (!spaceId) return { error: 'Missing spaceId' };

  const mapKey = `item-map:${itemId}`;

  // Check storage for existing mapping
  try {
    const existing = await storage.get(mapKey);
    if (existing && existing.pageId) {
      // Verify mapped page still exists and is accessible
      try {
  const page = await getPageById(String(existing.pageId));
  // Prefer Confluence-provided links when available
  const webuiRel = page && page._links && page._links.webui ? page._links.webui : `/wiki/pages/${String(existing.pageId)}`;
  const base = page && page._links && page._links.base ? page._links.base : null;
  const url = base ? `${base}${webuiRel}` : null;
  return { ok: true, id: String(existing.pageId), webui: webuiRel, base, url };
      } catch (e) {
        console.log('ensurePageForItemInternal: mapped page missing or inaccessible, will recreate', { itemId, pageId: existing.pageId, err: String(e) });
      }
    }
  } catch (e) {
    console.log('ensurePageForItemInternal: storage.get failed', e);
  }

  // Create new page placeholder with required body
  const title = fallbackTitle || `Migrated item ${itemId}`;
  const created = await createPage(spaceId, title, undefined, 'To be Migrated!');
  const newPageId = created && (created.id || (created.results && created.results[0] && created.results[0].id));
  const pageIdStr = newPageId ? String(newPageId) : (created && created.id ? String(created.id) : null);
  if (!pageIdStr) return { error: 'Could not determine created page id' };

  try {
    await storage.set(mapKey, { pageId: pageIdStr, createdAt: new Date().toISOString() });
  } catch (e) {
    console.log('ensurePageForItemInternal: storage.set failed', e);
  }

  // Attempt to fetch the newly-created page so we can return Confluence-provided links
  try {
    const pageData = await getPageById(pageIdStr);
    const webuiRelFromPage = pageData && pageData._links && pageData._links.webui ? pageData._links.webui : `/wiki/pages/${encodeURIComponent(String(pageIdStr))}`;
    const baseFromPage = pageData && pageData._links && pageData._links.base ? pageData._links.base : null;
    const urlFromPage = baseFromPage ? `${baseFromPage}${webuiRelFromPage}` : null;
    return { ok: true, id: pageIdStr, webui: webuiRelFromPage, base: baseFromPage, url: urlFromPage };
  } catch (e) {
    // If fetching the page failed, fall back to whatever the create response included
    const webuiRel = created && created._links && created._links.webui ? created._links.webui : `/wiki/pages/${encodeURIComponent(String(pageIdStr))}`;
    const base = created && created._links && created._links.base ? created._links.base : null;
    const url = base ? `${base}${webuiRel}` : null;
    return { ok: true, id: pageIdStr, webui: webuiRel, base, url };
  }
}

async function findPageByItemId(itemId, spaceId) {
  if (!itemId || !spaceId) return null;
  try {
    const res = await api.asApp().requestConfluence(
      route`/wiki/api/v2/pages?spaceId=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(itemId)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data.results) && data.results.length > 0) {
      return { id: data.results[0].id, webui: data.results[0]._links?.webui };
    }
    return null;
  } catch (e) {
    console.log('findPageByItemId error', e);
    return null;
  }
}

// Resolver for creating or finding a page for a given item ID
resolver.define('ensurePageForItem', async (req) => {
  try {
    const { itemId, spaceId, spaceKey } = req.payload || req.query || {};
    if (!itemId) return { error: 'Missing itemId' };

    let resolvedSpaceId = spaceId || null;
    if (!resolvedSpaceId && spaceKey) {
      // Try to resolve spaceKey to spaceId
      resolvedSpaceId = await getSpaceIdFromKey(spaceKey);
    }
    if (!resolvedSpaceId) return { error: 'Missing spaceId or spaceKey' };

    const result = await ensurePageForItemInternal(itemId, resolvedSpaceId, `Migrated item ${itemId}`);
  // Provide both a top-level webui and page id plus nested page for backward compatibility
  const resp = { ok: true, action: 'ensured', page: result };
  if (result && result.webui) resp.webui = result.webui;
  if (result && result.id) resp.pageId = result.id;
  return resp;
  } catch (err) {
    console.error('ensurePageForItem error', err);
    return { error: err.message || String(err) };
  }
});

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

// Resolver to rewrite anchors on an existing Confluence page so they route to the check/create resolver
resolver.define('rewriteLinksOnPage', async (req) => {
  try {
    const { pageId, spaceId } = req.payload || req.query || {};
    if (!pageId) return { error: 'Missing pageId' };
    if (!spaceId) return { error: 'Missing spaceId' };

    // Fetch existing page
    const page = await getPageById(String(pageId));
    const currentBody = page && page.body && page.body.storage && page.body.storage.value ? page.body.storage.value : '';

    if (!currentBody) return { error: 'Page has no body to rewrite' };

    // Replace anchors to point at the static create redirect page which will invoke the resolver
    const newBody = currentBody.replace(/<a([^>]*?)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, id, post, inner) => {
      const href = `/static/hello-world/create.html?itemId=${encodeURIComponent(id)}&spaceId=${encodeURIComponent(String(spaceId))}&title=${encodeURIComponent(String(inner).slice(0,200))}`;
      return `<a href="${href}">${inner}</a>`;
    });

    if (newBody === currentBody) return { ok: true, message: 'No anchors to rewrite' };

    // Update the page with bumped version
    const updated = await updatePage(String(pageId), page.title, spaceId, newBody, page.version && page.version.number ? page.version.number : 0);
    return { ok: true, page: updated };
  } catch (err) {
    console.error('rewriteLinksOnPage error', err);
    return { error: err.message || String(err) };
  }
});

// Restored the resolver 'checkOrCreatePageForLink' to enable page creation through links.

resolver.define('checkOrCreatePageForLink', async (req) => {
  try {
    const { itemId, spaceId, title } = req.query || {};
    if (!itemId) return { error: 'Missing itemId' };
    if (!spaceId) return { error: 'Missing spaceId' };

  const result = await ensurePageForItemInternal(itemId, spaceId, title);
  const resp = { ok: true, action: 'checked', page: result };
  if (result && result.webui) resp.webui = result.webui;
  if (result && result.id) resp.pageId = result.id;
  return resp;
  } catch (err) {
    console.error('checkOrCreatePageForLink error', err);
    return { error: err.message || String(err) };
  }
});

export const handler = resolver.getDefinitions();
