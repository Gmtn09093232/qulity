require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ─── ENV VALIDATION (fail fast, don't silently degrade) ───
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'JWT_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN not set — /api/telegram-auth will fail until it is configured');
}

const JWT_SECRET = process.env.JWT_SECRET;

// ─── ALLOWED ORIGINS (restrict CORS instead of '*') ───
// Set ALLOWED_ORIGINS as a comma-separated list in your env, e.g.
// ALLOWED_ORIGINS=https://yourapp.com,https://admin.yourapp.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. server-to-server, curl) with no origin header
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── TELEGRAM AUTH VALIDATION (timing-safe) ───
function validateTelegramData(data, botToken) {
  const { hash, ...rest } = data;
  if (!hash || typeof hash !== 'string') return false;

  const checkString = Object.keys(rest).sort().map(key => `${key}=${rest[key]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const computedBuf = Buffer.from(computedHash, 'hex');
  const providedBuf = Buffer.from(hash, 'hex');
  if (computedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, providedBuf);
}

// ─── AUTH MIDDLEWARE ───
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// ─── WHITELISTED FIELDS FOR INSPECTION WRITES ───
// Only these keys are ever pulled from req.body — everything else is dropped,
// preventing arbitrary/mass-assignment writes.
const INSPECTION_WRITABLE_FIELDS = [
  'process_type',
  'operation_status',
  'acceptance_data',
  'delivered_qty',
  'accepted_qty',
  'rework_qty',
  'reject_qty',
  'subtitle',
  'sub_sub_assembly',
  'suggested_next_operation',
  'total_internal_failure_cost'
  // add any other legitimate inspection columns here
];

function buildInspectionData(body) {
  const extra = body.extra_fields || {};
  const inspectionData = { submitted_at: new Date() };

  for (const field of INSPECTION_WRITABLE_FIELDS) {
    if (body[field] !== undefined) inspectionData[field] = body[field];
  }

  inspectionData.customer_name = extra["Customer Name"] || null;
  inspectionData.project_name = extra["Project Name"] || null;
  inspectionData.drawing_no = extra["Drawing No."] || null;
  inspectionData.part_name = extra["Part Name"] || null;
  inspectionData.tag_no = extra["Tag No."] || null;
  inspectionData.work_station = extra["Work Station"] || null;
  inspectionData.location = extra["Location"] || null;
  inspectionData.suggested_next_operation =
    body.suggested_next_operation || extra["process order"] || null;
  inspectionData.total_internal_failure_cost = body.total_internal_failure_cost || 0;
  inspectionData.extra_fields = extra;

  return inspectionData;
}

// ─── ASYNC ERROR WRAPPER ───
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── PUBLIC PAGE ROUTES ───
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// ─── PROTECTED PAGE ROUTES ───
// These serve admin/dashboard shells. If the HTML itself contains no sensitive
// data (only client-side fetches do), this is a soft gate — the real
// protection is on the API routes below. Remove requireAuth here if these
// pages need to load before the client-side auth check runs.
app.get('/admin', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/list', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'list.html')));
app.get('/up', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'up.html')));
app.get('/tools', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'tools.html')));
app.get('/dash', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dash.html')));

// ─── INSPECTION API ROUTES (all protected) ───
app.get('/api/inspections', requireAuth, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('rolling_inspections')
    .select('*')
    .order('submitted_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

app.get('/api/inspections/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('rolling_inspections')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
}));

app.post('/api/inspections', requireAuth, asyncHandler(async (req, res) => {
  const inspectionData = buildInspectionData(req.body);
  const { data, error } = await supabase
    .from('rolling_inspections')
    .insert([inspectionData])
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
}));

app.put('/api/inspections/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inspectionData = buildInspectionData(req.body);
  const { data, error } = await supabase
    .from('rolling_inspections')
    .update(inspectionData)
    .eq('id', id)
    .select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Inspection not found' });
  res.json(data[0]);
}));

app.delete('/api/inspections/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('rolling_inspections')
    .delete()
    .eq('id', id)
    .select();
  if (error) return res.status(400).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Inspection not found' });
  res.status(204).send();
}));

// ─── LAST OPERATION ENDPOINT ───
app.post('/api/inspections/last-operation', requireAuth, asyncHandler(async (req, res) => {
  const { part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id } = req.body;
  if (!part_name) return res.json({ last_operation: null });

  let query = supabase
    .from('rolling_inspections')
    .select('*')
    .eq('part_name', part_name)
    .order('submitted_at', { ascending: false })
    .limit(1);

  if (project_name) query = query.eq('project_name', project_name);
  if (subtitle) query = query.eq('subtitle', subtitle);
  if (sub_sub_assembly) query = query.eq('sub_sub_assembly', sub_sub_assembly);
  if (drawing_no) query = query.eq('drawing_no', drawing_no);
  if (tag_no) query = query.eq('tag_no', tag_no);
  if (exclude_id) query = query.neq('id', exclude_id);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  if (!data || data.length === 0) return res.json({ last_operation: null });

  const record = data[0];
  res.json({
    last_operation: {
      process_type: record.process_type,
      operation_status: record.operation_status,
      submitted_at: record.submitted_at,
      acceptance_rating: record.acceptance_data?.p0?.rating || '—',
      suggested_next: record.suggested_next_operation || null,
      delivered_qty: record.delivered_qty,
      accepted_qty: record.accepted_qty,
      rework_qty: record.rework_qty,
      reject_qty: record.reject_qty,
    }
  });
}));

// ─── TELEGRAM AUTH (public — this is how a client obtains a token) ───
app.post('/api/telegram-auth', asyncHandler(async (req, res) => {
  const telegramData = req.body;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Bot token not configured' });

  if (!validateTelegramData(telegramData, botToken)) {
    return res.status(401).json({ error: 'Invalid auth data' });
  }

  const authDate = new Date(telegramData.auth_date * 1000);
  const now = new Date();
  if (now - authDate > 24 * 60 * 60 * 1000) {
    return res.status(401).json({ error: 'Auth too old' });
  }

  const { data: existingUser, error: findError } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_id', telegramData.id)
    .maybeSingle();

  if (findError) return res.status(500).json({ error: 'DB error' });

  let user = existingUser;
  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('telegram_users')
      .insert([{
        telegram_id: telegramData.id,
        first_name: telegramData.first_name,
        last_name: telegramData.last_name || '',
        username: telegramData.username || '',
        photo_url: telegramData.photo_url || '',
        auth_date: new Date(telegramData.auth_date * 1000)
      }])
      .select()
      .single();
    if (insertError) return res.status(500).json({ error: 'Could not create user' });
    user = newUser;
  } else {
    await supabase
      .from('telegram_users')
      .update({ auth_date: new Date(telegramData.auth_date * 1000) })
      .eq('telegram_id', telegramData.id);
  }

  const token = jwt.sign({
    telegram_id: user.telegram_id,
    username: user.username || `${user.first_name} ${user.last_name}`,
    first_name: user.first_name,
    last_name: user.last_name
  }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    success: true,
    token,
    user: {
      id: user.telegram_id,
      name: `${user.first_name} ${user.last_name}`,
      username: user.username
    }
  });
}));

// ─── GLOBAL ERROR HANDLER ───
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Telegram bot configured: ${process.env.TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
});
