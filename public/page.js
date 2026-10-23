const token = new URLSearchParams(location.search).get('t') || '';
const byId = (id) => document.getElementById(id);

async function call(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Human-Token': token },
    body: JSON.stringify(body || {})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'REQUEST_FAILED');
  return data;
}

function setStatus(text, bad = false) {
  byId('status').textContent = text;
  byId('status').className = bad ? 'bad' : '';
}

function button(label, onClick, secondary = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (secondary) b.className = 'secondary';
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  try {
    const { requests } = await call('/human/pending');
    const list = byId('list');
    list.replaceChildren();
    if (!requests.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No agent requests are waiting.';
      list.append(li);
      return;
    }
    for (const r of requests) {
      const li = document.createElement('li');
      const what = document.createElement('p');
      what.className = 'what';
      what.textContent = `${r.preview.action}: "${r.preview.payload?.text ?? ''}"`;
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = r.preview.note ? `Agent note: ${r.preview.note}` : 'No note from the agent.';
      const hash = document.createElement('code');
      hash.textContent = `exact preview ${r.preview_sha256}`;
      const approve = button('Approve exact preview', async () => {
        try {
          await call('/human/approve', { id: r.id, preview_sha256: r.preview_sha256 });
          setStatus('Approved. The agent can now run it once.');
          load();
        } catch (e) { setStatus(e.message, true); }
      });
      const revoke = button('Revoke', async () => {
        try {
          await call('/human/revoke', { id: r.id });
          setStatus('Revoked. Nothing was run.');
          load();
        } catch (e) { setStatus(e.message, true); }
      }, true);
      li.append(what, note, hash, approve, revoke);
      list.append(li);
    }
  } catch (e) {
    setStatus(e.message === 'HUMAN_TOKEN_REQUIRED' ? 'Open the exact link printed in the server console.' : e.message, true);
  }
}

byId('refresh').addEventListener('click', load);
load();
