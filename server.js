require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here_change_in_production';

function validateTelegramData(data, botToken) {
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest).sort().map(key => `${key}=${rest[key]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  return computedHash === hash;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/list', (req, res) => res.sendFile(path.join(__dirname, 'list.html')));
app.get('/up', (req, res) => res.sendFile(path.join(__dirname, 'up.html')));
app.get('/tools', (req, res) => res.sendFile(path.join(__dirname, 'tools.html')));

app.get('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('rolling_inspections').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.put('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const extra = req.body.extra_fields || {};
  const inspectionData = {
    ...req.body,
    submitted_at: new Date(),
    customer_name: extra["Customer Name"] || null,
    project_name: extra["Project Name"] || null,
    drawing_no: extra["Drawing No."] || null,
    part_name: extra["Part Name"] || null,
    tag_no: extra["Tag No."] || null,
    work_station: extra["Work Station"] || null,
    location: extra["Location"] || null,
    suggested_next_operation: req.body.suggested_next_operation || extra["process order"] || null,
    total_internal_failure_cost: req.body.total_internal_failure_cost || 0
  };
  const { data, error } = await supabase.from('rolling_inspections').update(inspectionData).eq('id', id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('rolling_inspections').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

app.post('/api/telegram-auth', async (req, res) => {
  // ... (unchanged)
});

app.get('/api/inspections', async (req, res) => {
  const { data, error } = await supabase.from('rolling_inspections').select('*').order('submitted_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/inspections', async (req, res) => {
  const extra = req.body.extra_fields || {};
  const inspectionData = {
    ...req.body,
    submitted_at: new Date(),
    customer_name: extra["Customer Name"] || null,
    project_name: extra["Project Name"] || null,
    drawing_no: extra["Drawing No."] || null,
    part_name: extra["Part Name"] || null,
    tag_no: extra["Tag No."] || null,
    work_station: extra["Work Station"] || null,
    location: extra["Location"] || null,
    suggested_next_operation: req.body.suggested_next_operation || extra["process order"] || null,
    total_internal_failure_cost: req.body.total_internal_failure_cost || 0
  };
  const { data, error } = await supabase.from('rolling_inspections').insert([inspectionData]).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

// ─── LAST OPERATION ENDPOINT ───
app.post('/api/inspections/last-operation', async (req, res) => {
  const { part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id } = req.body;
  if (!part_name) return res.json({ last_operation: null });
  let query = supabase.from('rolling_inspections').select('*').eq('part_name', part_name).order('submitted_at', { ascending: false }).limit(1);
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Telegram bot configured: ${process.env.TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
});
