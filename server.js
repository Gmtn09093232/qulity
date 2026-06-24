require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from "public" folder
app.use(express.static('public'));

// Supabase client (anon key – public access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// JWT secret – store in .env for production
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here_change_in_production';

// ---------- TELEGRAM LOGIN VALIDATION ----------
function validateTelegramData(data, botToken) {
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest)
    .sort()
    .map(key => `${key}=${rest[key]}`)
    .join('\n');
  
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  
  return computedHash === hash;
}

// ---------- ROUTES ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/list', (req, res) => {
  res.sendFile(path.join(__dirname, 'list.html'));
});
// Project Follow-Up page (up.html)
app.get('/up', (req, res) => {
  res.sendFile(path.join(__dirname, 'up.html'));
});
// 7 QC Tools page (tools.html) – accessible at /tools
app.get('/tools', (req, res) => {
  res.sendFile(path.join(__dirname, 'tools.html'));
});

// GET a single inspection by ID
app.get('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('rolling_inspections')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// UPDATE (PUT) an existing inspection by ID
app.put('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const extra = req.body.extra_fields || {};
  const inspectionData = {
    ...req.body,
    submitted_at: new Date(),  // update timestamp on edit
    // Extract dedicated columns from extra_fields
    customer_name: extra["Customer Name"] || null,
    project_name: extra["Project Name"] || null,
    drawing_no: extra["Drawing No."] || null,
    part_name: extra["Part Name"] || null,
    tag_no: extra["Tag No."] || null,
    work_station: extra["Work Station"] || null,
    location: extra["Location"] || null,
    // ✅ NEW: map suggested_next_operation (fallback to legacy "process order")
    suggested_next_operation: extra["suggested_next_operation"] || extra["process order"] || null
  };

  const { data, error } = await supabase
    .from('rolling_inspections')
    .update(inspectionData)
    .eq('id', id)
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Telegram login endpoint (unchanged)
app.post('/api/telegram-auth', async (req, res) => {
  const telegramData = req.body;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!botToken) {
    return res.status(500).json({ error: 'Telegram bot token not configured' });
  }
  
  if (!validateTelegramData(telegramData, botToken)) {
    return res.status(401).json({ error: 'Invalid Telegram authentication data' });
  }
  
  const authDate = new Date(telegramData.auth_date * 1000);
  const now = new Date();
  const dayInMs = 24 * 60 * 60 * 1000;
  if (now - authDate > dayInMs) {
    return res.status(401).json({ error: 'Authentication data too old' });
  }
  
  const { data: existingUser, error: findError } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_id', telegramData.id)
    .maybeSingle();
  
  if (findError && findError.code !== 'PGRST116') {
    console.error('Database error:', findError);
    return res.status(500).json({ error: 'Database error' });
  }
  
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
    
    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ error: 'Could not create user' });
    }
    user = newUser;
  } else {
    await supabase
      .from('telegram_users')
      .update({ auth_date: new Date(telegramData.auth_date * 1000) })
      .eq('telegram_id', telegramData.id);
  }
  
  const token = jwt.sign(
    {
      telegram_id: user.telegram_id,
      username: user.username || `${user.first_name} ${user.last_name}`,
      first_name: user.first_name,
      last_name: user.last_name
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({
    success: true,
    token,
    user: {
      id: user.telegram_id,
      name: `${user.first_name} ${user.last_name}`,
      username: user.username
    }
  });
});

// GET all inspections (public)
app.get('/api/inspections', async (req, res) => {
  const { data, error } = await supabase
    .from('rolling_inspections')
    .select('*')
    .order('submitted_at', { ascending: false });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST a new inspection (public) – extracts dedicated columns
app.post('/api/inspections', async (req, res) => {
  const extra = req.body.extra_fields || {};
  
  const inspectionData = {
    ...req.body,
    submitted_at: new Date(),
    // Extract dedicated columns from extra_fields
    customer_name: extra["Customer Name"] || null,
    project_name: extra["Project Name"] || null,
    drawing_no: extra["Drawing No."] || null,
    part_name: extra["Part Name"] || null,
    tag_no: extra["Tag No."] || null,
    work_station: extra["Work Station"] || null,
    location: extra["Location"] || null,
    // ✅ NEW: map suggested_next_operation (fallback to legacy "process order")
    suggested_next_operation: extra["suggested_next_operation"] || extra["process order"] || null
  };
  
  const { data, error } = await supabase
    .from('rolling_inspections')
    .insert([inspectionData])
    .select();
  
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Telegram bot configured: ${process.env.TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
});
