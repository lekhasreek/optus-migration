// src/index.js
import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

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
    subtype: 'live'
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

      const updated = await updatePage(
        pageIdToUpdate,
        title,
        payload.spaceId,   // ✅ always trust frontend spaceId
        htmlBody,
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

    const created = await createPage(
      targetSpaceId,
      title,
      payload.createAsChildOf || undefined,
      htmlBody
    );
    return { ok: true, action: 'created', page: created };

  } catch (err) {
    console.error('migrateJsonToPage error', err);
    return { error: err.message || String(err) };
  }
});

export const handler = resolver.getDefinitions();
