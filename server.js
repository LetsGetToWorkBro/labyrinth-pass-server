/**
 * Labyrinth BJJ — Apple Wallet Pass Server
 * Certs loaded from environment variables (Railway secrets)
 */

const express    = require('express');
const { PKPass } = require('passkit-generator');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const fetch      = require('node-fetch');

const app = express();
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────
const PASS_TYPE_ID = 'pass.vision.labyrinth.member';
const TEAM_ID      = 'CA2KJBHNWW';
const GAS_URL      = 'https://script.google.com/macros/s/AKfycbwkxkV6XlqKy3DDot_MTfb40WeAfd6KMgBwgcrCNStEFM5vcAQNYG9eR2OOFpCwJ3AJ/exec';
const API_SECRET   = process.env.PASS_API_SECRET || 'lbjj-pass-secret-2026';

// Certs — loaded from env vars (base64) or files (local dev)
function loadCert(envVar, filePath) {
  if (process.env[envVar]) return Buffer.from(process.env[envVar], 'base64').toString('utf8');
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  throw new Error(`Missing cert: ${envVar} or ${filePath}`);
}

const SIGNER_CERT = loadCert('PASS_CERT_B64',  path.join(__dirname, 'pass_cert.pem'));
const SIGNER_KEY  = loadCert('PASS_KEY_B64',   path.join(__dirname, 'pass_key.pem'));
const WWDR        = loadCert('WWDR_CERT_B64',  path.join(__dirname, 'wwdr.pem'));

// ── Belt colors ───────────────────────────────────────────────────────
const BELT_COLORS = {
  white:  { bg: 'rgb(245,245,245)', fg: 'rgb(17,17,17)',   label: 'rgb(85,85,85)' },
  blue:   { bg: 'rgb(20,70,140)',   fg: 'rgb(255,255,255)', label: 'rgb(180,210,255)' },
  purple: { bg: 'rgb(75,10,120)',   fg: 'rgb(255,255,255)', label: 'rgb(210,160,255)' },
  brown:  { bg: 'rgb(90,55,25)',    fg: 'rgb(255,255,255)', label: 'rgb(220,185,140)' },
  black:  { bg: 'rgb(10,10,10)',    fg: 'rgb(240,240,240)', label: 'rgb(200,162,76)' },
  grey:   { bg: 'rgb(80,80,80)',    fg: 'rgb(255,255,255)', label: 'rgb(220,220,220)' },
  yellow: { bg: 'rgb(160,120,10)',  fg: 'rgb(17,17,17)',    label: 'rgb(50,40,0)' },
  orange: { bg: 'rgb(160,80,10)',   fg: 'rgb(255,255,255)', label: 'rgb(255,200,160)' },
  green:  { bg: 'rgb(30,100,50)',   fg: 'rgb(255,255,255)', label: 'rgb(180,255,200)' },
};

function makeToken(email) {
  const today = new Date().toISOString().split('T')[0];
  return crypto.createHmac('sha256', API_SECRET).update(email + today).digest('hex');
}

// ── Generate pass ─────────────────────────────────────────────────────
async function generatePass(member) {
  const belt   = (member.belt || member.Belt || 'white').toLowerCase().trim();
  const colors = BELT_COLORS[belt] || BELT_COLORS.black;
  const name   = member.name || member.Name || 'Member';
  const email  = (member.email || member.Email || '').toLowerCase().trim();
  const serial = crypto.createHash('sha256').update(email + PASS_TYPE_ID).digest('hex').substring(0, 16);
  const beltDisplay = belt.charAt(0).toUpperCase() + belt.slice(1) + ' Belt';
  const token  = `lbjj:${makeToken(email)}:${email}`;

  const pass = await PKPass.from({
    model: path.join(__dirname, 'labyrinth.pass'),
    certificates: {
      wwdr:       WWDR,
      signerCert: SIGNER_CERT,
      signerKey:  SIGNER_KEY,
    }
  }, {
    serialNumber:    serial,
    backgroundColor: colors.bg,
    foregroundColor: colors.fg,
    labelColor:      colors.label,
  });

  pass.primaryFields[0].value   = name;
  pass.headerFields[0].value    = beltDisplay;
  pass.secondaryFields[0].value = 'Labyrinth BJJ';
  pass.secondaryFields[1].value = 'Fulshear, TX';
  pass.setBarcodes({
    format: 'PKBarcodeFormatQR',
    message: token,
    messageEncoding: 'iso-8859-1',
    altText: 'Scan to enter'
  });

  return { buffer: pass.getAsBuffer(), serial, token };
}

// ── Routes ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', passType: PASS_TYPE_ID, team: TEAM_ID });
});

// GET /pass/:email — quick link for testing (no auth, for dev)
app.get('/pass/test/:belt/:name', async (req, res) => {
  try {
    const { buffer, serial } = await generatePass({
      name:  decodeURIComponent(req.params.name),
      belt:  req.params.belt,
      email: `test-${Date.now()}@labyrinth.vision`
    });
    res.set({
      'Content-Type':        'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="labyrinth-${serial}.pkpass"`,
      'Cache-Control':       'no-cache'
    });
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /pass/generate — called by app with member token
app.post('/pass/generate', async (req, res) => {
  const { memberToken, apiSecret, memberData } = req.body;

  if (apiSecret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  let member = memberData;
  if (!member && memberToken) {
    try {
      const r = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'memberGetProfile', token: memberToken })
      });
      const d = await r.json();
      if (d.member) member = d.member;
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch member: ' + e.message });
    }
  }

  if (!member) return res.status(400).json({ error: 'Member data required' });

  try {
    const { buffer, serial } = await generatePass(member);
    res.set({
      'Content-Type':        'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="labyrinth-${serial}.pkpass"`,
      'Cache-Control':       'no-cache'
    });
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /door/validate — called by ESP32
app.post('/door/validate', async (req, res) => {
  const { token, email, apiSecret } = req.body;
  if (apiSecret !== API_SECRET) return res.status(401).json({ allow: false });

  const isValid = [-1, 0, 1].some(offset => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const expected = crypto.createHmac('sha256', API_SECRET)
      .update(email + d.toISOString().split('T')[0]).digest('hex');
    return expected === token;
  });

  if (!isValid) return res.json({ allow: false, reason: 'Invalid token' });

  try {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'validateDoorAccess', email })
    });
    const data = await r.json();

    if (data.allow) {
      fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logDoorAccess', email, method: 'wallet_qr', allowed: true, timestamp: new Date().toISOString() })
      }).catch(() => {});
    }
    res.json(data);
  } catch (e) {
    res.json({ allow: false, reason: 'Service unavailable' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Labyrinth Pass Server on port ${PORT}`));
