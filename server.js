const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TTL_DAYS = parseInt(process.env.TTL_DAYS || '7', 10);
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data', 'clipboard.json');
const FILES_PATH = path.join(path.dirname(DATA_PATH), 'files');

const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ensureDataDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readClipboard() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() - data.updatedAt > TTL_MS) {
      return { text: '', updatedAt: null };
    }
    return data;
  } catch {
    return { text: '', updatedAt: null };
  }
}

function writeClipboard(text) {
  ensureDataDir();
  const data = { text, updatedAt: Date.now() };
  fs.writeFileSync(DATA_PATH, JSON.stringify(data), 'utf8');
  return data;
}

function ensureFilesDir() {
  fs.mkdirSync(FILES_PATH, { recursive: true });
}

function filePaths(id) {
  return {
    content: path.join(FILES_PATH, id),
    metadata: path.join(FILES_PATH, `${id}.json`),
  };
}

function removeFile(id) {
  const paths = filePaths(id);
  for (const file of Object.values(paths)) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function readFileMetadata(id) {
  if (!FILE_ID_PATTERN.test(id)) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(filePaths(id).metadata, 'utf8'));
    if (metadata.id !== id || typeof metadata.name !== 'string' ||
        !Number.isSafeInteger(metadata.size) || !Number.isFinite(metadata.uploadedAt)) {
      return null;
    }
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function cleanupExpiredFiles() {
  ensureFilesDir();
  for (const entry of fs.readdirSync(FILES_PATH)) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    if (!FILE_ID_PATTERN.test(id)) continue;
    const metadata = readFileMetadata(id);
    if (!metadata || Date.now() - metadata.uploadedAt > TTL_MS) removeFile(id);
  }
}

function getFileName(header) {
  if (typeof header !== 'string') return null;
  try {
    const name = decodeURIComponent(header);
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name) ||
        Buffer.byteLength(name, 'utf8') > 255) return null;
    return name;
  } catch {
    return null;
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/clipboard', (req, res) => {
  const data = readClipboard();
  res.json(data);
});

app.post('/clipboard', (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const data = writeClipboard(text);
  res.json(data);
});

app.get('/files', (req, res) => {
  try {
    cleanupExpiredFiles();
    const files = fs.readdirSync(FILES_PATH)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFileMetadata(entry.slice(0, -5)))
      .filter((metadata) => metadata && fs.existsSync(filePaths(metadata.id).content))
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .map((metadata) => ({ ...metadata, expiresAt: metadata.uploadedAt + TTL_MS }));
    res.json({ files });
  } catch {
    res.status(500).json({ error: 'Could not list files.' });
  }
});

app.post('/files', (req, res) => {
  if (!req.is('application/octet-stream')) {
    return res.status(415).json({ error: 'Content-Type must be application/octet-stream.' });
  }
  const name = getFileName(req.get('X-File-Name'));
  if (!name) return res.status(400).json({ error: 'A valid X-File-Name is required.' });

  try {
    cleanupExpiredFiles();
  } catch {
    return res.status(500).json({ error: 'Could not prepare file storage.' });
  }

  const id = crypto.randomUUID();
  const paths = filePaths(id);
  const temporaryPath = `${paths.content}.upload`;
  const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
  let size = 0;
  let failed = false;

  function fail(status, message) {
    if (failed) return;
    failed = true;
    req.unpipe(output);
    output.destroy();
    const finish = () => fs.unlink(temporaryPath, () => {
      if (!res.headersSent && !res.destroyed) res.status(status).json({ error: message });
    });
    if (output.closed) finish();
    else output.once('close', finish);
    req.resume();
  }

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) fail(413, 'File exceeds the 100 MiB limit.');
  });
  req.on('aborted', () => fail(400, 'Upload was interrupted.'));
  output.on('error', () => fail(500, 'Could not save file.'));
  output.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(400, 'File is empty.');
    const metadata = { id, name, size, uploadedAt: Date.now() };
    try {
      fs.renameSync(temporaryPath, paths.content);
      fs.writeFileSync(paths.metadata, JSON.stringify(metadata), { flag: 'wx' });
      res.status(201).json(metadata);
    } catch {
      try { removeFile(id); } catch {}
      res.status(500).json({ error: 'Could not save file.' });
    }
  });
  req.pipe(output);
});

app.get('/files/:id', (req, res) => {
  try {
    cleanupExpiredFiles();
    const metadata = readFileMetadata(req.params.id);
    if (!metadata || !fs.existsSync(filePaths(metadata.id).content)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.download(filePaths(metadata.id).content, metadata.name, (error) => {
      if (error && !res.headersSent) res.status(500).json({ error: 'Could not download file.' });
    });
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'Could not download file.' });
  }
});

app.delete('/files/:id', (req, res) => {
  try {
    const metadata = readFileMetadata(req.params.id);
    if (!metadata) return res.status(404).json({ error: 'File not found.' });
    removeFile(metadata.id);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Could not delete file.' });
  }
});

setInterval(() => {
  try { cleanupExpiredFiles(); } catch (error) { console.error('File cleanup failed:', error); }
}, 60 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clipboard Portal running on port ${PORT}`);
});
