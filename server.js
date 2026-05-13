const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TTL_DAYS = parseInt(process.env.TTL_DAYS || '7', 10);
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data', 'clipboard.json');

const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clipboard Portal running on port ${PORT}`);
});
