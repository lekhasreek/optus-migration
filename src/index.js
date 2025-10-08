// --- Anchor Replacement Utility ---
// Build a map of all nodes by detail.id for fast lookup
function buildIdMap(node, map = {}) {
  if (node && node.detail && node.detail.id) {
    map[node.detail.id] = node;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach(child => buildIdMap(child, map));
  }
  return map;
}

// Recursively update anchor tags in all fields
function replaceAnchorsWithContent(node, idMap) {
  if (Array.isArray(node.fields)) {
    node.fields.forEach(field => {
      if (typeof field.value === 'string' && field.value.includes('to be migrated')) {
        // Replace all anchors with data-itemid and "to be migrated"
        field.value = field.value.replace(
          /<a([^>]*?)data[-]?itemid=['"]([^'"]+)['"]([^>]*)>to be migrated<\/a>/gi,
          (match, pre, dataitemId, post) => {
            const target = idMap[dataitemId];
            if (target && Array.isArray(target.fields)) {
              // Prefer DocumentTitle, else first value
              const docTitle = target.fields.find(f => f.name === 'DocumentTitle');
              const value = docTitle ? docTitle.value : (target.fields[0] && target.fields[0].value) || '';
              return `<a${pre}data-itemid="${dataitemId}"${post}>${value}</a>`;
            }
            return match; // fallback: leave as is
          }
        );
      }
    });
  }
  if (Array.isArray(node.children)) {
    node.children.forEach(child => replaceAnchorsWithContent(child, idMap));
  }
  return node;
}

// Main entry for anchor replacement
function migrateAnchorsInJson(rootJson) {
  const idMap = buildIdMap(rootJson);
  return replaceAnchorsWithContent(rootJson, idMap);
}
// Recursively search for an item by id in the JSON tree
function findItemById(node, id) {
  if (!node) return null;
  if (node.detail && node.detail.id === id) return node;
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findItemById(child, id);
      if (found) return found;
    }
  }
  return null;
}

// Handler for resolving item by id (to be used as a Forge resolver)
// Expects req.body: { data, itemId }
async function resolveItemById(req, res) {
  const { data, itemId } = req.body;
  const item = findItemById(data, itemId);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const type = item.detail?.itemType;
  if (type === 'Document') {
    // Return info needed to create/navigate to a Confluence page
    return res.json({
      type: 'Document',
      title: item.detail.title,
      id: item.detail.id,
      fields: item.fields,
      properties: item.properties,
    });
  } else if (type === 'Link') {
    // Find the URL field
    const urlField = item.fields?.find(f => f.name === 'URL');
    return res.json({
      type: 'Link',
      url: urlField?.value || null,
      title: item.detail.title,
    });
  } else {
    return res.json({ type, detail: item.detail });
  }
}

exports.resolveItemById = resolveItemById;
// --- Task List/Checkbox Conversion ---
// Convert HTML checkboxes to Confluence task list macros
function convertCheckboxesToTaskList(html) {
  // Use DOMParser to parse HTML
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (e) {
    return html;
  }
  const checkboxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));
  if (!checkboxes.length) return html;
  const taskListTag = doc.createElement('ac:task-list');
  const itemsToRemove = [];
  checkboxes.forEach(checkbox => {
    let content = checkbox.nextSibling;
    while (content && content.nodeType === 3 && !content.textContent.trim()) {
      content = content.nextSibling;
    }
    if (content && content.nodeType === 3) {
      const taskTag = doc.createElement('ac:task');
      const statusTag = doc.createElement('ac:task-status');
      statusTag.textContent = checkbox.checked ? 'complete' : 'incomplete';
      const bodyTag = doc.createElement('ac:task-body');
      bodyTag.textContent = content.textContent.trim();
      taskTag.appendChild(statusTag);
      taskTag.appendChild(bodyTag);
      taskListTag.appendChild(taskTag);
      itemsToRemove.push(checkbox);
      itemsToRemove.push(content);
    }
  });
  if (checkboxes[0]) checkboxes[0].parentNode.insertBefore(taskListTag, checkboxes[0]);
  itemsToRemove.forEach(item => item.parentNode && item.parentNode.removeChild(item));
  // Remove all <br> tags
  Array.from(doc.querySelectorAll('br')).forEach(br => br.parentNode && br.parentNode.removeChild(br));
  return doc.body.innerHTML;
}
// --- Internal/External/Hidden Link Rewriting ---
// Fix broken external links (e.g., yesopt.us)
function fixBrokenLinks(html) {
  return html.replace(/<a([^>]+)href=["']#["']([^>]*)>(yesopt\.us[^<]+)<\/a>/gi, (m, pre, post, url) => {
    return `<a${pre}href="https://${url}" target="_blank" class="externallink"${post}>${url}</a>`;
  });
}

// Rewrite <a data-itemid=...> links to Confluence macros
function rewriteInternalLinks(html, data, spaceKey) {
  // Handle <a data-itemid> and <a href="#bookmark"> cases
  // 1. <a data-itemid> logic (Document/Link)
  html = html.replace(/<a([^>]*)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, itemid, post, anchorText) => {
    const item = findItemById(data, itemid);
    if (!item || !item.detail) return m;
    if (item.detail.itemType === 'Document') {
      const title = item.detail.title || (item.fields || []).find(f => f.name === 'DocumentTitle')?.value || '';
      const cleanTitle = (title || '').trim().replace(/"/g, '&quot;');
      return `<ac:link><ri:page ri:content-title="${cleanTitle}" ri:space-key="${spaceKey}" /><ac:plain-text-link-body><![CDATA[${anchorText}]]></ac:plain-text-link-body></ac:link>`;
    } else if (item.detail.itemType === 'Link') {
      const urlField = (item.fields || []).find(f => f.name === 'URL');
      if (urlField && urlField.value) {
        return `<ac:link><ri:url ri:value="${urlField.value}" /><ac:plain-text-link-body><![CDATA[${anchorText}]]></ac:plain-text-link-body></ac:link>`;
      }
    }
    return m;
  });

  // 2. <a href="#bookmark"> logic (internal anchor/bookmark)
  html = html.replace(/<a([^>]*)href=["']#([a-zA-Z0-9_-]+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, anchorName, post, anchorText) => {
    // Only process if no data-itemid present
    if (/data-itemid=/.test(m)) return m;
    // Confluence anchor macro: <ac:link><ri:anchor ri:value="bookmark"/></ac:link>
    return `<ac:link><ri:anchor ri:value="${anchorName}"/><ac:plain-text-link-body><![CDATA[${anchorText}]]></ac:plain-text-link-body></ac:link>`;
  });
  return html;
}
// Insert anchor macros at the correct locations for bookmarks
function insertAnchorMacros(html, data) {
  // Find all bookmarks in the data tree
  const bookmarks = [];
  function findBookmarks(node) {
    if (node && node.fields) {
      for (const f of node.fields) {
        if (f.name === 'Bookmark' && f.value) {
          bookmarks.push(f.value);
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) findBookmarks(child);
    }
  }
  findBookmarks(data);
  // For each bookmark, insert anchor macro before the first occurrence of the bookmark in the HTML
  bookmarks.forEach(bm => {
    // Insert <ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">bookmark</ac:parameter></ac:structured-macro>
    const anchorMacro = `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${bm}</ac:parameter></ac:structured-macro>`;
    // Try to insert before a heading or paragraph containing the bookmark name (if possible)
    const regex = new RegExp(`(<h[1-6][^>]*>[^<]*${bm}[^<]*<\/h[1-6]>|<p[^>]*>[^<]*${bm}[^<]*<\/p>)`, 'i');
    if (regex.test(html)) {
      html = html.replace(regex, anchorMacro + '$1');
    } else {
      // Otherwise, just prepend to HTML
      html = anchorMacro + html;
    }
  });
  return html;
}

// Rewrite <a class='externallink'> links with correct href/target
function fixExternalLinks(html) {
  // Already handled by fixBrokenLinks, but can add more logic if needed
  return html;
}

// Rewrite hidden links (e.g., in HiddenText fields)
function rewriteHiddenLinks(html, data, spaceKey) {
  // Use same logic as rewriteInternalLinks for <a data-itemid=...>
  return rewriteInternalLinks(html, data, spaceKey);
}
// --- Shared Paragraph and Image Hub Logic ---
// Create or get a page in a given space by title
async function getOrCreatePage(spaceId, title, htmlContent) {
  // Try to find the page first
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages?spaceId=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}`);
  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data.results) && data.results.length > 0) return data.results[0];
  }
  // Create if not found
  return await createPage(spaceId, title, undefined, htmlContent);
}

// Generate an include macro for a page
function generateIncludeMacro(spaceKey, pageTitle) {
  return `<ac:structured-macro ac:name="include" ac:schema-version="1"><ac:parameter ac:name=""><ac:link><ri:page ri:space-key="${spaceKey}" ri:content-title="${pageTitle}" /></ac:link></ac:parameter></ac:structured-macro>`;
}

// Process shared paragraphs and images, create pages if needed, and return macros
async function processSharedContent(data, sharedParagraphSpaceKey, imageHubSpaceKey, imageTitleMap) {
  const sharedContentMacros = [];
  // Resolve numeric spaceIds for sharedParagraphSpaceKey and imageHubSpaceKey
  let sharedParagraphSpaceId = sharedParagraphSpaceKey;
  let imageHubSpaceId = imageHubSpaceKey;
  if (typeof sharedParagraphSpaceKey === 'string' && isNaN(Number(sharedParagraphSpaceKey))) {
    sharedParagraphSpaceId = await getSpaceIdFromKey(sharedParagraphSpaceKey);
  }
  if (typeof imageHubSpaceKey === 'string' && isNaN(Number(imageHubSpaceKey))) {
    imageHubSpaceId = await getSpaceIdFromKey(imageHubSpaceKey);
  }
  if (!sharedParagraphSpaceId) {
    console.error('Resolved sharedParagraphSpaceId is null. sharedParagraphSpaceKey:', sharedParagraphSpaceKey);
    throw new Error('Missing or invalid sharedParagraphSpaceKey/spaceId');
  }
  if (!imageHubSpaceId) {
    console.error('Resolved imageHubSpaceId is null. imageHubSpaceKey:', imageHubSpaceKey);
    throw new Error('Missing or invalid imageHubSpaceKey/spaceId');
  }
  async function recurse(children) {
    for (const child of children) {
      const detail = child.detail || {};
      if (detail.itemType === 'Image') {
        const itemId = detail.id;
        if (itemId && itemId !== '2e6d82ef-524c-ea11-a960-000d3ad095fb.png') {
          const titleValue = detail.title || itemId;
          imageTitleMap[itemId] = titleValue;
          const imageMacro = generateImageMacro(`${itemId}.png`);
          // Create image hub page if not exists
          await getOrCreatePage(imageHubSpaceId, titleValue, imageMacro);
        }
      }
      if (detail.itemType === 'SharedParagraph') {
        let titleValue = '';
        let value = '';
        for (const field of child.fields || []) {
          if (field.name === 'ParagraphTitle') titleValue = (field.value || '').trim();
          if (field.name === 'Text') value = field.value || '';
        }
        if (titleValue && value) {
          // Create shared paragraph page if not exists
          await getOrCreatePage(sharedParagraphSpaceId, titleValue, value);
          sharedContentMacros.push(generateIncludeMacro(sharedParagraphSpaceKey, titleValue));
        }
      }
      if (Array.isArray(child.children)) {
        await recurse(child.children);
      }
    }
  }
  await recurse(data.children || []);
  return sharedContentMacros;
}
// --- Tooltip/External Info Logic ---
// Lookup info by externalId from infoLookup map
function getTooltipPanelContent(externalId, infoLookup) {
  const entry = infoLookup[externalId];
  if (!entry) return null;
  const infoType = entry.informationType;
  let content = entry.content || '';
  if (!content && Array.isArray(entry.fields)) {
    for (const field of entry.fields) {
      if (field.name === 'Text') content = field.value || '';
    }
  }
  // If image, return image macro
  if (infoType === 'Image / screenshot') {
    // Assume content contains <img itemid=...>
    const match = content.match(/<img[^>]*itemid=["']([^"']+)["']/);
    if (match) {
      const itemId = match[1];
      // The actual image fetch/attach logic should be handled elsewhere
      return generateImageMacro(`${itemId}.png`);
    }
    return null;
  }
  // For other types, just return the HTML content
  return content;
}

// Generate a Confluence tooltip macro (as a link to a tooltip page)
function generateTooltipLinkMacro(tooltipTitle, tooltipSpaceKey, linkText) {
  const safeTitle = (tooltipTitle || '').replace(/"/g, '&quot;');
  const safeText = linkText || safeTitle;
  return `<ac:link><ri:page ri:content-title="${safeTitle}" ri:space-key="${tooltipSpaceKey}"/><ac:plain-text-link-body><![CDATA[${safeText}]]></ac:plain-text-link-body></ac:link>`;
}

// Create a tooltip/external info page if it doesn't exist
async function ensureTooltipPage(spaceKey, title, htmlContent) {
  // Check if page exists
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages?spaceId=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}`);
  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data.results) && data.results.length > 0) return data.results[0];
  }
  // Create page if not found
  const page = await createPage(spaceKey, title, undefined, htmlContent);
  return page;
}
// --- Image Handling and Macro Generation Utilities ---
// Generate Confluence image macro for a given filename
function generateImageMacro(filename) {
  if (!filename || filename === '2e6d82ef-524c-ea11-a960-000d3ad095fb.png') return '';
  return `<p><ac:image><ri:attachment ri:filename="${filename}"/></ac:image></p>`;
}

// Attach an image file (Buffer or base64) to a Confluence page
async function attachImageToPage(pageId, filename, fileBuffer) {
  // Forge API: https://developer.atlassian.com/platform/forge/api-reference/#api-confluence-requestconfluence
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}/attachments`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
    body: fileBuffer,
    // Forge API will set content-type automatically for binary
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to attach image: ${res.status} ${text}`);
  }
  return await res.json();
}

// Fetch image from external URL and attach to Confluence page, then return macro
async function fetchAndAttachImage(imageUrl, pageId, filename) {
  // Fetch image as binary
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await attachImageToPage(pageId, filename, buffer);
  return generateImageMacro(filename);
}
// --- Color and Style Formatting Utilities (ported from Python) ---
function rgbToHex(str) {
  // Convert rgb/rgba(255,255,255,1) to #ffffff
  return str.replace(/rgba?\(([^)]+)\)/g, (_, rgb) => {
    const [r, g, b] = rgb.split(',').map(x => parseInt(x.trim(), 10));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  });
}

function convertUnits(style) {
  // Convert cm and pt to px
  style = style.replace(/([\d.]+)\s*cm/g, (_, n) => `${(parseFloat(n) * 37.8).toFixed(2)}px`);
  style = style.replace(/([\d.]+)\s*pt/g, (_, n) => `${(parseFloat(n) * 1.333).toFixed(2)}px`);
  return style;
}

function updateStyleWithBackground(style, bgColor) {
  // Add or update background-color in style string
  const styles = {};
  style.split(';').forEach(item => {
    if (item.includes(':')) {
      const [k, v] = item.split(':');
      styles[k.trim().toLowerCase()] = v.trim();
    }
  });
  styles['background-color'] = bgColor;
  return Object.entries(styles).map(([k, v]) => `${k}:${v}`).join('; ') + ';';
}

function colorFormatter(htmlContent) {
  // Main color/style formatter for HTML content
  if (!htmlContent) return '';
  htmlContent = rgbToHex(htmlContent);
  // Use DOMParser for HTML manipulation
  let doc;
  try {
    doc = new DOMParser().parseFromString(htmlContent, 'text/html');
  } catch (e) {
    // fallback for environments without DOMParser
    return htmlContent;
  }
  // Color classes
  doc.querySelectorAll('.alt3').forEach(tag => {
    let style = tag.getAttribute('style') || '';
    if (!/color:/i.test(style)) style += (style && !style.trim().endsWith(';') ? ';' : '') + ' color: red;';
    tag.setAttribute('style', style.trim());
  });
  doc.querySelectorAll('.alt2').forEach(tag => {
    let style = tag.getAttribute('style') || '';
    if (!/color:/i.test(style)) style += (style && !style.trim().endsWith(';') ? ';' : '') + ' color: green;';
    tag.setAttribute('style', style.trim());
  });
  // Style/unit conversion and background color
  doc.querySelectorAll('*').forEach(tag => {
    let style = tag.getAttribute('style') || '';
    style = convertUnits(style);
    const match = style.match(/background(?:-color)?:\s*(#[0-9a-fA-F]{6})/);
    if (match) {
      const bgColor = match[1];
      tag.setAttribute('style', updateStyleWithBackground(style, bgColor));
      if (['td', 'th'].includes(tag.tagName.toLowerCase())) {
        tag.setAttribute('data-highlight-colour', bgColor);
      } else {
        tag.removeAttribute('data-highlight-colour');
      }
    } else {
      if (style.trim()) tag.setAttribute('style', style);
      else tag.removeAttribute('style');
    }
  });
  // Table cleanup
  doc.querySelectorAll('table').forEach(table => {
    table.removeAttribute('width');
    let style = table.getAttribute('style') || '';
    style = style.replace(/width\s*:\s*[^;]+;?/gi, '').trim().replace(/;$/, '');
    table.setAttribute('data-layout', 'default');
    if (style) table.setAttribute('style', style);
    else table.removeAttribute('style');
  });
  // Remove empty tags (except void tags)
  const VOID_TAGS = ['br', 'img', 'input', 'hr', 'meta', 'link'];
  doc.body.querySelectorAll('*').forEach(tag => {
    if (VOID_TAGS.includes(tag.tagName.toLowerCase())) return;
    if (tag.querySelector('ac\:structured-macro')) return;
    if (/^(ac:|ri:)/.test(tag.tagName)) return;
    if (!tag.textContent.trim() && Array.from(tag.childNodes).every(n => n.nodeType === 3 && !n.textContent.trim())) {
      tag.remove();
    }
  });
  // Unwrap nested same tags
  let changed = true;
  while (changed) {
    changed = false;
    doc.body.querySelectorAll('*').forEach(tag => {
      const children = Array.from(tag.children);
      if (children.length === 1 && children[0].tagName === tag.tagName) {
        const inner = children[0];
        while (inner.firstChild) tag.appendChild(inner.firstChild);
        inner.remove();
        changed = true;
      }
    });
  }
  return doc.body.innerHTML;
}
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

function extractHtmlFromNode(node = {}, isTopLevel = true) {
  if (!node) return '';
  let html = '';
  // If this node has a 'children' array, and those children have 'detail',
  // only migrate and display the fields of those 'detail.children' (ignore deeper nested children)
  if (Array.isArray(node.children) && node.children.length > 0) {
    for (const child of node.children) {
      // If child has a 'detail' and 'children', process only the first level of children under 'detail'
      if (child.detail && Array.isArray(child.children) && child.children.length > 0) {
        for (const detailChild of child.children) {
          if (Array.isArray(detailChild.fields)) {
            // Look for LinkText/HiddenText pairs
            const linkTextField = detailChild.fields.find(f => f && f.name === 'LinkText' && f.value);
            const hiddenTextField = detailChild.fields.find(f => f && f.name === 'HiddenText' && f.value);
            if (linkTextField && hiddenTextField) {
              html += `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${linkTextField.value}</ac:parameter><ac:rich-text-body>${hiddenTextField.value}</ac:rich-text-body></ac:structured-macro>`;
              continue;
            }
            for (const f of detailChild.fields) {
              if (f && f.name === 'HiddenText') continue;
              if (f && typeof f.value !== 'undefined' && f.value !== null) {
                html += f.value;
              }
            }
          }
        }
      } else if (Array.isArray(child.fields)) {
        // If no further children, just display this child's fields
        // Look for LinkText/HiddenText pairs
        const linkTextField = child.fields.find(f => f && f.name === 'LinkText' && f.value);
        const hiddenTextField = child.fields.find(f => f && f.name === 'HiddenText' && f.value);
        if (linkTextField && hiddenTextField) {
          html += `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${linkTextField.value}</ac:parameter><ac:rich-text-body>${hiddenTextField.value}</ac:rich-text-body></ac:structured-macro>`;
          continue;
        }
        for (const f of child.fields) {
          if (f && f.name === 'HiddenText') continue;
          if (f && typeof f.value !== 'undefined' && f.value !== null) {
            html += f.value;
          }
        }
      }
    }
    return html;
  }
  // If no children, display the value of each field (fields:[{"value":}]), except HiddenText
  if (Array.isArray(node.fields)) {
    // Look for LinkText/HiddenText pairs
    const linkTextField = node.fields.find(f => f && f.name === 'LinkText' && f.value);
    const hiddenTextField = node.fields.find(f => f && f.name === 'HiddenText' && f.value);
    if (linkTextField && hiddenTextField) {
      html += `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">${linkTextField.value}</ac:parameter><ac:rich-text-body>${hiddenTextField.value}</ac:rich-text-body></ac:structured-macro>`;
    } else {
      for (const f of node.fields) {
        if (f && f.name === 'HiddenText') continue;
        if (f && typeof f.value !== 'undefined' && f.value !== null) {
          html += f.value;
        }
      }
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
    body: {
      representation: 'storage',
      value: `<div>${htmlValue}</div>`
    },
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



// --- Anchor Placeholder and Replacement Logic ---
// On the main page, keep anchor text and link to a new Confluence page (created with 'to be migrated')
function insertAnchorLinksToPages(html, data, spaceKey) {
  // Replace <a data-itemid="...">...</a> with a Confluence page link, keeping anchorText
  return html.replace(/<a([^>]*)data-itemid=["']([^"']+)["']([^>]*)>(.*?)<\/a>/gi, (m, pre, itemid, post, anchorText) => {
    const item = findItemById(data, itemid);
    if (item && item.detail && item.detail.itemType === 'Document') {
      const title = item.detail.title || (item.fields || []).find(f => f.name === 'DocumentTitle')?.value || anchorText || itemid;
      const cleanTitle = (title || '').trim().replace(/"/g, '&quot;');
      return `<ac:link><ri:page ri:content-title="${cleanTitle}" ri:space-key="${spaceKey}" /><ac:plain-text-link-body><![CDATA[${anchorText}]]></ac:plain-text-link-body></ac:link>`;
    }
    return m;
  });
}

function replaceAnchorPlaceholders(html, data) {
  // Replace <a data-itemid="...">to be migrated</a> with actual content from matching inner child
  return html.replace(/<a([^>]*)data-itemid=["']([^"']+)["']([^>]*)>to be migrated<\/a>/gi, (m, pre, itemid, post) => {
    // Find the innermost child for this itemid
    const item = findItemById(data, itemid);
    if (item && Array.isArray(item.children) && item.children.length > 0) {
      // Find the deepest child with fields
      let target = item;
      while (Array.isArray(target.children) && target.children.length > 0) {
        // Prefer the first child with fields
        const next = target.children.find(c => Array.isArray(c.fields) && c.fields.length > 0) || target.children[0];
        if (!next || next === target) break;
        target = next;
      }
      if (Array.isArray(target.fields)) {
        const value = target.fields.map(f => f.value).filter(Boolean).join(' ');
        return value || '';
      }
    }
    return '';
  });
}




// Helper: Traverse all nodes and update anchor-linked pages as soon as a matching id is found
async function updateAnchorPagesOnTraversal(node, anchorRefs, spaceId) {
  if (!node) return;
  if (node.detail && anchorRefs.has(node.detail.id)) {
    // Extract value from fields (prefer fields of this node, else look for deepest child with fields)
    let value = '';
    if (Array.isArray(node.fields) && node.fields.length > 0) {
      value = node.fields.map(f => f.value).filter(Boolean).join(' ');
    } else if (Array.isArray(node.children) && node.children.length > 0) {
      // Find the deepest child with fields
      let target = node;
      while (Array.isArray(target.children) && target.children.length > 0) {
        const next = target.children.find(c => Array.isArray(c.fields) && c.fields.length > 0) || target.children[0];
        if (!next || next === target) break;
        target = next;
      }
      if (Array.isArray(target.fields)) {
        value = target.fields.map(f => f.value).filter(Boolean).join(' ');
      }
    }
    if (value) {
      // Update the anchor-linked page with the value (as Confluence storage format)
      const existingPage = await getOrCreatePage(spaceId, node.detail.id, `<div>${value}</div>`);
      const currentVersionNumber = existingPage.version?.number ?? 0;
      await updatePage(existingPage.id, node.detail.id, spaceId, `<div>${value}</div>`, currentVersionNumber);
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      await updateAnchorPagesOnTraversal(child, anchorRefs, spaceId);
    }
  }
}

resolver.define('migrateJsonToPage', async (req) => {

  try {
    const payload = req.payload || {};
    let knosysJson = payload.json || payload;
    if (!knosysJson) return { error: 'Missing JSON payload under "json"' };

    // --- Anchor replacement: update all anchor tags with correct linked content ---
    knosysJson = migrateAnchorsInJson(knosysJson);

    if (!payload.sharedParagraphSpaceKey) payload.sharedParagraphSpaceKey = payload.spaceKey || payload.spaceId;
    if (!payload.imageHubSpaceKey) payload.imageHubSpaceKey = payload.spaceKey || payload.spaceId;

    // Always resolve numeric spaceId for Confluence REST v2
    let spaceId = payload.spaceId || null;
    let spaceKey = payload.spaceKey || null;
    if (!spaceId && spaceKey) {
      spaceId = await getSpaceIdFromKey(spaceKey);
    }
    if (!spaceId) {
      console.error('Resolved spaceId is null or empty. Payload:', payload, 'spaceKey:', spaceKey);
      return { error: 'Missing or invalid spaceId/spaceKey in payload (resolved spaceId is null)' };
    }
    spaceKey = spaceKey || '';

    // 1. Extract and process HTML from JSON
    let htmlBody = extractHtmlFromNode(knosysJson) || '<p>(no content extracted)</p>';

    // --- Insert anchor links to new pages, keeping anchor text ---
    htmlBody = insertAnchorLinksToPages(htmlBody, knosysJson, spaceKey);

    // 2. Fix broken/external links
    htmlBody = fixBrokenLinks(htmlBody);
    htmlBody = fixExternalLinks(htmlBody);

    // 3. Rewrite internal/hidden links and handle bookmarks
    htmlBody = rewriteInternalLinks(htmlBody, knosysJson, spaceKey);
    htmlBody = rewriteHiddenLinks(htmlBody, knosysJson, spaceKey);
    htmlBody = insertAnchorMacros(htmlBody, knosysJson);

    // 4. Convert checkboxes to Confluence task list macros
    htmlBody = convertCheckboxesToTaskList(htmlBody);

    // 5. Color/style formatting
    htmlBody = colorFormatter(htmlBody);

    // 6. Process shared paragraphs and image hub logic
    const sharedParagraphSpaceKey = payload.sharedParagraphSpaceKey || '';
    const imageHubSpaceKey = payload.imageHubSpaceKey || '';
    const imageTitleMap = {};
    await processSharedContent(knosysJson, sharedParagraphSpaceKey, imageHubSpaceKey, imageTitleMap);

    // 7. Tooltip/external info logic (if needed, e.g., for <a data-externalid=...>)
    // (Assume infoLookup is built from knosysJson.external.information)
    // Not fully implemented here, but can be added as needed

    // 8. Assemble final Confluence storage format
    const pageTopAnchor = '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">PageTop</ac:parameter></ac:structured-macro>\n';
    const finalHtml = pageTopAnchor + htmlBody;

    // 9. Determine title
    const title =
      payload.title ||
      knosysJson.detail?.title ||
      (knosysJson.fields?.find(f => f.name === 'DocumentTitle')?.value) ||
      'Migrated page from Knosys';

    // 10. Create or update page
    if (payload.pageId) {
      const pageIdToUpdate = String(payload.pageId);
      const existing = await getPageById(pageIdToUpdate);
      const currentVersionNumber = existing.version?.number ?? 0;
      const updated = await updatePage(
        pageIdToUpdate,
        title,
        spaceId,
        finalHtml,
        currentVersionNumber
      );
      return { ok: true, action: 'updated', page: updated };
    }

    // --- For each anchor with data-itemid, create or update a separate page with placeholder ---
    // Collect all anchor refs
    const anchorRefs = new Set();
    htmlBody.replace(/<ac:link><ri:page ri:content-title=\"([^\"]+)\" ri:space-key=\"[^\"]*\" \/><ac:plain-text-link-body><!\[CDATA\[(.*?)\]\]><\/ac:plain-text-link-body><\/ac:link>/g, (m, pageTitle, anchorText) => {
      anchorRefs.add(pageTitle);
      return m;
    });

    // For each anchor, set the page content to the correct value from the JSON if available
    for (const anchor of anchorRefs) {
      // Try to find the node by title or id
      let node = null;
      // Try by id first
      node = findItemById(knosysJson, anchor);
      // If not found by id, try by title
      if (!node) {
        // Traverse all nodes to find by detail.title
        function findByTitle(n, title) {
          if (n && n.detail && n.detail.title === title) return n;
          if (Array.isArray(n.children)) {
            for (const c of n.children) {
              const found = findByTitle(c, title);
              if (found) return found;
            }
          }
          return null;
        }
        node = findByTitle(knosysJson, anchor);
      }
      let value = '<p>to be migrated</p>';
      if (node && Array.isArray(node.fields)) {
        // Prefer DocumentTitle, else first value
        const docTitle = node.fields.find(f => f.name === 'DocumentTitle');
        value = `<div>${docTitle ? docTitle.value : (node.fields[0] && node.fields[0].value) || ''}</div>`;
      }
      await getOrCreatePage(spaceId, anchor, value);
    }

    // Traverse all nodes and update anchor-linked pages as soon as a matching id is found
    await updateAnchorPagesOnTraversal(knosysJson, anchorRefs, spaceId);

    const created = await createPage(
      spaceId,
      title,
      undefined,
      finalHtml
    );
    return { ok: true, action: 'created', page: created };

  } catch (err) {
    console.error('migrateJsonToPage error', err);
    return { error: err.message || String(err) };
  }
});

export const handler = resolver.getDefinitions();
