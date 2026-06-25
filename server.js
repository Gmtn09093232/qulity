require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Explicit CORS – allow all methods
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

// ---------- TELEGRAM LOGIN (unchanged) ----------
function validateTelegramData(data, botToken) {
  // ... (same as before)
}
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/list', (req, res) => res.sendFile(path.join(__dirname, 'list.html')));
app.get('/up', (req, res) => res.sendFile(path.join(__dirname, 'up.html')));
app.get('/tools', (req, res) => res.sendFile(path.join(__dirname, 'tools.html')));

// ---------- API ROUTES ----------
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

// DELETE route – added with explicit error handling
app.delete('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/inspections/${id}`); // server log
  const { error } = await supabase
    .from('rolling_inspections')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Supabase delete error:', error);
    return res.status(400).json({ error: error.message });
  }
  res.status(204).send();
});

app.post('/api/telegram-auth', async (req, res) => {
  // ... (unchanged)
});

app.get('/api/inspections', async (req, res) => {
  const { data, error } = await supabase
    .from('rolling_inspections')
    .select('*')
    .order('submitted_at', { ascending: false });
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
    suggested_next_operation: extra["suggested_next_operation"] || extra["process order"] || null
  };
  const { data, error } = await supabase
    .from('rolling_inspections')
    .insert([inspectionData])
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data[0]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
