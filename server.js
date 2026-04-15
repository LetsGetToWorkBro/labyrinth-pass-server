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
const rateLimit  = require('express-rate-limit');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://app.labyrinth.vision',
  'https://labyrinth.vision',
  'https://admin.labyrinth.vision',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ── Rate limiting ────────────────────────────────────────────────────
const passLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many requests' } });
const doorLimiter = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Too many requests' } });

// ── Static assets ────────────────────────────────────────────────────
// Pass images — immutable (never change)
app.use('/passes', express.static(path.join(__dirname, 'public/passes'), {
  maxAge: '1y',
  immutable: true,
}));

// ── Config ───────────────────────────────────────────────────────────
const PASS_TYPE_ID = 'pass.vision.labyrinth.member';
const TEAM_ID      = 'CA2KJBHNWW';
const GAS_URL      = 'https://script.google.com/macros/s/AKfycbwkxkV6XlqKy3DDot_MTfb40WeAfd6KMgBwgcrCNStEFM5vcAQNYG9eR2OOFpCwJ3AJ/exec';
const API_SECRET = process.env.PASS_API_SECRET;
if (!API_SECRET) {
  console.error('FATAL: PASS_API_SECRET environment variable is not set');
  process.exit(1);
}

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

// 15-minute bucket token — changes every 15 min, valid for ~30 min
function makeToken(email) {
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return crypto.createHmac('sha256', API_SECRET).update(email + ':' + bucket).digest('hex');
}

function validateDoorToken(token, email) {
  const now = Math.floor(Date.now() / (15 * 60 * 1000));
  for (const bucket of [now, now - 1]) {
    const expected = crypto.createHmac('sha256', API_SECRET)
      .update(email + ':' + bucket).digest('hex');
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'))) {
        return true;
      }
    } catch { continue; }
  }
  return false;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
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

  // Swap in belt-specific background images
  const beltKey = ['white','blue','purple','brown','black','grey','yellow','orange','green'].includes(belt) ? belt : 'black';
  const pairs = [
    [`background-${beltKey}.png`,   'background.png'],
    [`background@2x-${beltKey}.png`, 'background@2x.png'],
    [`background@3x-${beltKey}.png`, 'background@3x.png'],
  ];
  for (const [src, dst] of pairs) {
    const srcPath = path.join(__dirname, src);
    const dstPath = path.join(__dirname, 'labyrinth.pass', dst);
    if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, dstPath);
  }

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

// ── Google Wallet config ─────────────────────────────────────────────
const GOOGLE_ISSUER_ID = process.env.GOOGLE_ISSUER_ID || '3388000000023101152';
const GOOGLE_CLASS_SUFFIX = 'labyrinth_member';
const GOOGLE_CLASS_ID = `${GOOGLE_ISSUER_ID}.${GOOGLE_CLASS_SUFFIX}`;

function getGoogleServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
  }
  const filePath = path.join(__dirname, 'google-service-account.json');
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return null;
}

// ── Google Wallet belt color mapping (hex strings) ───────────────────
const GOOGLE_BELT_COLORS = {
  white:  { bg: '#F5F5F5', text: '#111111' },
  blue:   { bg: '#14468C', text: '#FFFFFF' },
  purple: { bg: '#4B0A78', text: '#FFFFFF' },
  brown:  { bg: '#5A3719', text: '#FFFFFF' },
  black:  { bg: '#0A0A0A', text: '#F0F0F0' },
  grey:   { bg: '#505050', text: '#FFFFFF' },
  yellow: { bg: '#A0780A', text: '#111111' },
  orange: { bg: '#A0500A', text: '#FFFFFF' },
  green:  { bg: '#1E6432', text: '#FFFFFF' },
};

// ── Routes ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', passType: PASS_TYPE_ID, team: TEAM_ID });
});

// GET /pass/:email — quick link for testing (no auth, for dev)
if (process.env.NODE_ENV !== 'production') {
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
}

// POST /pass/generate — called by app with member token
// GET /pass/generate — iOS Safari direct navigation (query params)
app.get('/pass/generate', passLimiter, async (req, res) => {
  const { name, email, belt, plan } = req.query;
  const apiSecret = req.headers['x-api-secret'] || req.query.apiSecret;
  if (req.query.apiSecret) console.warn('DEPRECATION: apiSecret in query param, use x-api-secret header');
  if (!safeCompare(apiSecret, API_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  const member = { name, email, belt: belt || 'white', plan: plan || '' };
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

app.post('/pass/generate', passLimiter, async (req, res) => {
  const { memberToken, apiSecret } = req.body;

  if (!safeCompare(apiSecret, API_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  if (!memberToken) return res.status(400).json({ error: 'memberToken required' });

  let member;
  try {
    const gasRes = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'memberGetProfile', token: memberToken }),
    });
    const gasData = await gasRes.json();
    if (!gasData.member && !gasData.profile) return res.status(401).json({ error: 'Invalid member token' });
    member = gasData.member || gasData.profile;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch member: ' + e.message });
  }

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

// GET /pass/token — fetch fresh QR token without regenerating the pass
app.get('/pass/token', async (req, res) => {
  const apiSecret = req.headers['x-api-secret'] || req.query.apiSecret;
  if (!safeCompare(apiSecret, API_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const token = makeToken(email);
  const expiresInMs = (15 * 60 * 1000) - (Date.now() % (15 * 60 * 1000));
  res.json({ token, expiresInMs });
});

// POST /door/validate — called by ESP32
app.post('/door/validate', doorLimiter, async (req, res) => {
  const { token, email, apiSecret } = req.body;
  if (!safeCompare(apiSecret, API_SECRET)) return res.status(401).json({ allow: false });

  const isValid = validateDoorToken(token, email);

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

// POST /pass/google — generate Google Wallet save link
app.post('/pass/google', async (req, res) => {
  const { apiSecret, memberData } = req.body;
  if (!safeCompare(apiSecret, API_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  if (!memberData) return res.status(400).json({ error: 'memberData required' });

  const serviceAccount = getGoogleServiceAccount();
  if (!serviceAccount) return res.status(500).json({ error: 'Google service account not configured' });

  try {
    const { GoogleAuth } = require('google-auth-library');
    const jwt = require('jsonwebtoken');

    const belt = (memberData.belt || 'white').toLowerCase().trim();
    const colors = GOOGLE_BELT_COLORS[belt] || GOOGLE_BELT_COLORS.black;
    const beltDisplay = belt.charAt(0).toUpperCase() + belt.slice(1) + ' Belt';
    const name = memberData.name || 'Member';
    const email = (memberData.email || '').toLowerCase().trim();
    // Use timestamp to ensure unique object ID per generation (avoids stale cached objects)
    const objectId = `${GOOGLE_ISSUER_ID}.${Buffer.from(email || name).toString('hex').substring(0, 16)}${Date.now().toString(36)}`;

    const genericObject = {
      id: objectId,
      classId: GOOGLE_CLASS_ID,
      genericType: 'GENERIC_TYPE_UNSPECIFIED',
      hexBackgroundColor: colors.bg,
      cardTitle: {
        defaultValue: { language: 'en-US', value: 'Labyrinth BJJ' }
      },
      subheader: {
        defaultValue: { language: 'en-US', value: beltDisplay }
      },
      header: {
        defaultValue: { language: 'en-US', value: name }
      },
      textModulesData: [
        {
          id: 'membership',
          header: 'Membership',
          body: memberData.plan || memberData.membership || 'Active Member'
        },
        {
          id: 'location',
          header: 'Location',
          body: 'Fulshear, TX'
        }
      ],
      barcode: {
        type: 'QR_CODE',
        value: `lbjj:${makeToken(email)}:${email}`,
        alternateText: 'Scan to enter'
      },
      state: 'ACTIVE',
      heroImage: {
        sourceUri: { uri: `https://app.labyrinth.vision/passes/belt-${belt}.jpg` },
        contentDescription: { defaultValue: { language: 'en-US', value: `${beltDisplay} - Labyrinth BJJ` } }
      }
    };

    // Pre-insert object via API (more reliable than JWT-only approach)
    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
    });
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();

    await fetch('https://walletobjects.googleapis.com/walletobjects/v1/genericObject', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(genericObject)
    });
    // (ignore insert errors — object may already exist, JWT will still work)

    const claims = {
      iss: serviceAccount.client_email,
      aud: 'google',
      origins: ['app.labyrinth.vision'],
      typ: 'savetowallet',
      payload: {
        genericObjects: [{ id: objectId, classId: GOOGLE_CLASS_ID }]
      }
    };

    const token = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });
    const saveUrl = `https://pay.google.com/gp/v/save/${token}`;

    res.json({ saveUrl });
  } catch (e) {
    console.error('Google Wallet error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /pass/google/test/:belt/:name — quick testing route
if (process.env.NODE_ENV !== 'production') {
  app.get('/pass/google/test/:belt/:name', async (req, res) => {
    const serviceAccount = getGoogleServiceAccount();
    if (!serviceAccount) return res.status(500).json({ error: 'Google service account not configured' });

    // Reuse the POST logic inline
    req.body = {
      apiSecret: API_SECRET,
      memberData: {
        name: decodeURIComponent(req.params.name),
        belt: req.params.belt,
        email: `test@labyrinth.vision`,
        plan: 'Adult Unlimited'
      }
    };
    // Forward to same logic by redirecting internally
    const { GoogleAuth } = require('google-auth-library');
    const jwt = require('jsonwebtoken');

    try {
      const belt = req.params.belt.toLowerCase();
      const colors = GOOGLE_BELT_COLORS[belt] || GOOGLE_BELT_COLORS.black;
      const beltDisplay = belt.charAt(0).toUpperCase() + belt.slice(1) + ' Belt';
      const name = decodeURIComponent(req.params.name);
      const objectId = `${GOOGLE_ISSUER_ID}.test${Date.now()}`;

      const genericObject = {
        id: objectId,
        classId: GOOGLE_CLASS_ID,
        genericType: 'GENERIC_TYPE_UNSPECIFIED',
        hexBackgroundColor: colors.bg,
        cardTitle: { defaultValue: { language: 'en-US', value: 'Labyrinth BJJ' } },
        subheader: { defaultValue: { language: 'en-US', value: beltDisplay } },
        header: { defaultValue: { language: 'en-US', value: name } },
        textModulesData: [
          { id: 'membership', header: 'Membership', body: 'Adult Unlimited' },
          { id: 'location', header: 'Location', body: 'Fulshear, TX' }
        ],
        barcode: { type: 'QR_CODE', value: `lbjj:${makeToken('test@labyrinth.vision')}:test@labyrinth.vision`, alternateText: 'Scan to enter' },
        state: 'ACTIVE'
      };

      const claims = {
        iss: serviceAccount.client_email,
        aud: 'google',
        origins: ['app.labyrinth.vision'],
        typ: 'savetowallet',
        payload: { genericObjects: [genericObject] }
      };

      const token = jwt.sign(claims, serviceAccount.private_key, { algorithm: 'RS256' });
      res.redirect(`https://pay.google.com/gp/v/save/${token}`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Labyrinth Pass Server on port ${PORT}`));
