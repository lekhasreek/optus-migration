// static/hello-world/src/app.js
import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import './App.css';

function App() {
  const [mode, setMode] = useState('create'); // "create", "update"
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [fileName, setFileName] = useState('');
  const [jsonData, setJsonData] = useState(null);

  useEffect(() => {
    invoke('listSpaces')
      .then(res => {
        if (res.ok) {
          setSpaces(res.spaces);
        } else {
          setStatus(`Could not load spaces: ${res.error}`);
        }
      })
      .catch(err => setStatus('Error loading spaces: ' + err.message));
  }, []);

  const onFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const kno = JSON.parse(evt.target.result);
        setJsonData(kno);
        setStatus(`Loaded JSON: ${file.name}`);
      } catch (err) {
        setStatus('Invalid JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!jsonData) {
      setStatus('Please upload a JSON file first.');
      return;
    }

    let payload = { json: jsonData };

    if (mode === 'create') {
      if (!spaceId) {
        setStatus('Space is required for creating a page.');
        return;
      }
      payload.spaceId = spaceId;
      if (title) payload.title = title;
    } else if (mode === 'update') {
      if (!pageId || !spaceId) {
        setStatus('Both Page ID and Space are required for updating.');
        return;
      }
      payload.pageId = pageId;      // ✅ update target
      payload.spaceId = spaceId;    // ✅ required for PUT
      if (title) payload.title = title;
    } else if (mode === 'child') {
      if (!spaceId || !pageId) {
        setStatus('Both space and parent page ID are required for child creation.');
        return;
      }
      payload.spaceId = spaceId;
      payload.createAsChildOf = pageId; // ✅ child of pageId
      if (title) payload.title = title;
    }

    setStatus('Processing…');

    try {
      const res = await invoke('migrateJsonToPage', payload);
      if (res.error) {
        setStatus(`Error: ${res.error}`);
      } else {
        const page = res.page || {};
        const pageId = page.id;
        const base = (page._links && page._links.base) || '';
        const webui = (page._links && page._links.webui) || '';
        const link = base && webui ? `${base}${webui}` : '';
        setStatus(
          `${res.action === 'updated' ? 'Updated' : 'Created'} page ✓ (id=${pageId}) ${
            link ? ` → ${link}` : ''
          }`
        );
      }
    } catch (err) {
      setStatus('Invoke failed: ' + err.message);
    }
  };

  return (
    <div className="app-shell">
      <div className="card">
        <div className="header">
          <h2 className="title">Knosys → Confluence Migration</h2>
        </div>

        <div className="controls">
          <div className="form-row full">
            <label>
              <strong>Mode:</strong>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="create">Create new page (by space)</option>
                <option value="update">Update existing page (by pageId)</option>
              </select>
            </label>
          </div>

          {(mode === 'create' || mode === 'update') && (
            <div className="form-row">
              <label>
                Space:
                <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                  <option value="">-- select space --</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.key})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {mode === 'update' && (
            <div className="form-row">
              <label>
                Page ID:
                <input
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  placeholder="numeric page id"
                />
              </label>
            </div>
          )}

          <div className="form-row full">
            <label>
              Title (optional override):
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="leave blank to auto-use JSON title"
              />
            </label>
          </div>

          <div className="form-row full">
            <input type="file" accept=".json,application/json" onChange={onFileChange} />
            {fileName && <div className="small-muted">Selected file: {fileName}</div>}
          </div>

          <div className="form-row full button-row">
            <button onClick={handleSubmit}>Run Migration</button>
            <button
              className="secondary"
              onClick={() => {
                setMode('create');
                setSpaceId('');
                setPageId('');
                setTitle('');
                setFileName('');
                setJsonData(null);
                setStatus('');
              }}
            >
              Reset
            </button>
          </div>
        </div>

        <div className="status link-wrap">{status}</div>
      </div>
    </div>
  );
}

export default App;
