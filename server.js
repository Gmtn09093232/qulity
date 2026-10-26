require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here_change_in_production';

// ─── TABLE ROUTING ───
function getTableForProcess(processType) {
  if (!processType) return 'rolling_inspections';
  const lower = processType.toLowerCase();
  if (lower.includes('assembling (welding)') || lower.includes('assembling (fastener)') ||
      lower.includes('assembling(welding)') || lower.includes('assembling(fastener)')) return 'assembly_inspections';
  return 'rolling_inspections';
}

// ─── CANONICAL DERIVED-FIELD HELPERS ───
function normaliseOperationStatus(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'continue') return 'continuous';
  return lower;
}
function deriveResult(acceptanceData) {
  const ratings = Object.values(acceptanceData || {}).map(p => (p && p.rating) || '').filter(Boolean);
  if (ratings.length === 0) return null;
  if (ratings.includes('Reject'))             return 'Reject';
  if (ratings.includes('Rework'))             return 'Rework';
  if (ratings.includes('Conditional Accept')) return 'Conditional Accept';
  return 'Accepted';
}
function computeCumulativePoints(acceptanceData) {
  const ratings = Object.values(acceptanceData || {}).map(p => (p && p.rating) || '').filter(Boolean);
  if (ratings.length === 0) return 0;
  const scoreMap = { 'Accepted': 1, 'Conditional Accept': 0.5, 'Rework': 0.25, 'Reject': 0 };
  const total = ratings.reduce((s, r) => s + (scoreMap[r] ?? 0), 0);
  return +(total / ratings.length).toFixed(3);
}
function buildInspectionRow(req) {
  const extra = req.body.extra_fields || {};
  const processT = req.body.process_type;
  const table = getTableForProcess(processT);
  const isAsm = table === 'assembly_inspections';

  const acceptance  = req.body.acceptance_data || {};
  const accepted    = +req.body.accepted_qty           || 0;
  const rework      = +req.body.rework_qty             || 0;
  const reject      = +req.body.reject_qty             || 0;
  const conditional = +req.body.conditional_accept_qty || 0;
  const totalOutcomes = isAsm ? 0 : (accepted + rework + reject + conditional);

  const selectedPartNames = Array.isArray(extra.selectedPartNames)
    ? extra.selectedPartNames.filter(n => n && n.trim())
    : (extra.selectedParts && typeof extra.selectedParts === 'object'
        ? Object.keys(extra.selectedParts).filter(n => n && n.trim())
        : []);
  const assemblyPartsCount = isAsm ? selectedPartNames.length : 0;
  const assemblyTotalParts = isAsm ? (+extra.totalPartsCount || 0) : 0;
  const assemblyCompletion = (isAsm && assemblyTotalParts > 0) ? +((assemblyPartsCount / assemblyTotalParts) * 100).toFixed(1) : null;

  return {
    ...req.body,
    submitted_at: new Date(),
    customer_name:    extra['Customer Name']     || null,
    project_name:     extra['Project Name']      || null,
    subtitle:         extra['Subtitle']          || null,
    sub_sub_assembly: extra['Sub Sub Assembly']  || null,
    drawing_no:       extra['Drawing No.']       || null,
    part_name:        extra['Part Name']         || null,
    tag_no:           extra['Tag No.']           || null,
    work_station:     extra['Work Station']      || null,
    location:         extra['Location']          || null,
    suggested_next_operation: req.body.suggested_next_operation || extra['process order'] || null,
    operation_status:         normaliseOperationStatus(req.body.operation_status),
    normalised_operation:     normaliseOperationStatus(req.body.operation_status),
    total_internal_failure_cost: +req.body.total_internal_failure_cost || 0,
    severity:         (req.body.severity || extra['Severity'] || 'major').toLowerCase(),
    is_final_op:      !!req.body.is_final_op,
    total_outcomes_qty:      totalOutcomes,
    derived_result:          deriveResult(acceptance),
    cumulative_points:       computeCumulativePoints(acceptance),
    assembly_parts_count:    assemblyPartsCount,
    assembly_total_parts:    assemblyTotalParts,
    assembly_completion_pct: assemblyCompletion,
  };
}

// ─── TELEGRAM AUTH ───
function validateTelegramData(data, botToken) {
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest).sort().map(key => `${key}=${rest[key]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  return computedHash === hash;
}

// ─── STATIC ROUTES ───
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login',  (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/list',   (req, res) => res.sendFile(path.join(__dirname, 'list.html')));
app.get('/up',     (req, res) => res.sendFile(path.join(__dirname, 'up.html')));
app.get('/tools',  (req, res) => res.sendFile(path.join(__dirname, 'tools.html')));
app.get('/dash',   (req, res) => res.sendFile(path.join(__dirname, 'dash.html')));

// ─── GET /api/inspections ───
app.get('/api/inspections', async (req, res) => {
  try {
    const [rollingRes, assemblyRes] = await Promise.all([
      supabase.from('rolling_inspections').select('*').order('submitted_at', { ascending: false }),
      supabase.from('assembly_inspections').select('*').order('submitted_at', { ascending: false })
    ]);
    if (rollingRes.error) throw new Error(rollingRes.error.message);
    if (assemblyRes.error) throw new Error(assemblyRes.error.message);
    const combined = [...(rollingRes.data || []), ...(assemblyRes.data || [])];
    combined.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    res.json(combined);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/inspections/:id ───
app.get('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  let { data, error } = await supabase.from('rolling_inspections').select('*').eq('id', id).single();
  if (error && error.code !== 'PGRST116') return res.status(404).json({ error: error.message });
  if (data) return res.json(data);
  const { data: assemblyData, error: assemblyError } = await supabase.from('assembly_inspections').select('*').eq('id', id).single();
  if (assemblyError) return res.status(404).json({ error: assemblyError.message });
  res.json(assemblyData);
});

// ─── POST /api/inspections ───
app.post('/api/inspections', async (req, res) => {
  try {
    const row = buildInspectionRow(req);
    const table = getTableForProcess(req.body.process_type);
    const { data, error } = await supabase.from(table).insert([row]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PUT /api/inspections/:id ───
app.put('/api/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const newTable = getTableForProcess(req.body.process_type);
    const { data: rRow } = await supabase.from('rolling_inspections').select('id').eq('id', id).maybeSingle();
    const { data: aRow } = await supabase.from('assembly_inspections').select('id').eq('id', id).maybeSingle();
    const oldTable = rRow ? 'rolling_inspections' : (aRow ? 'assembly_inspections' : null);
    if (!oldTable) return res.status(404).json({ error: 'Record not found' });
    const row = buildInspectionRow(req);
    if (oldTable === newTable) {
      const { data, error } = await supabase.from(newTable).update(row).eq('id', id).select();
      if (error) return res.status(400).json({ error: error.message });
      return res.json(data[0]);
    }
    await supabase.from(oldTable).delete().eq('id', id);
    const { data, error } = await supabase.from(newTable).insert([row]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/inspections/:id ───
app.delete('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  let { error: rollingError } = await supabase.from('rolling_inspections').delete().eq('id', id);
  if (rollingError && rollingError.code !== 'PGRST116') return res.status(400).json({ error: rollingError.message });
  const { error: assemblyError } = await supabase.from('assembly_inspections').delete().eq('id', id);
  if (assemblyError && assemblyError.code !== 'PGRST116') return res.status(400).json({ error: assemblyError.message });
  res.status(204).send();
});

// ─── LAST OPERATION ───
app.post('/api/inspections/last-operation', async (req, res) => {
  const { part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id } = req.body;
  if (!part_name) return res.json({ last_operation: null });
  try {
    const [rollingQuery, assemblyQuery] = await Promise.all([
      buildLastOpQuery(supabase.from('rolling_inspections'), part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id),
      buildLastOpQuery(supabase.from('assembly_inspections'), part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id)
    ]);
    const allResults = [...(rollingQuery.data || []), ...(assemblyQuery.data || [])];
    if (allResults.length === 0) return res.json({ last_operation: null });
    const sorted = allResults.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    const record = sorted[0];
    res.json({
      last_operation: {
        process_type: record.process_type,
        operation_status: record.normalised_operation || record.operation_status,
        submitted_at: record.submitted_at,
        acceptance_rating: record.derived_result || record.acceptance_data?.p0?.rating || '—',
        suggested_next: record.suggested_next_operation || null,
        delivered_qty: record.delivered_qty,
        accepted_qty: record.accepted_qty,
        rework_qty: record.rework_qty,
        reject_qty: record.reject_qty,
      }
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

async function buildLastOpQuery(query, part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id) {
  let q = query.select('*').eq('part_name', part_name).order('submitted_at', { ascending: false }).limit(1);
  if (project_name)     q = q.eq('project_name', project_name);
  if (subtitle)         q = q.eq('subtitle', subtitle);
  if (sub_sub_assembly) q = q.eq('sub_sub_assembly', sub_sub_assembly);
  if (drawing_no)       q = q.eq('drawing_no', drawing_no);
  if (tag_no)           q = q.eq('tag_no', tag_no);
  if (exclude_id)       q = q.neq('id', exclude_id);
  return q;
}

// ─── THRESHOLDS ───
app.get('/api/thresholds', async (req, res) => {
  try {
    const { data, error } = await supabase.from('report_thresholds').select('*').eq('id', 'default').maybeSingle();
    if (error || !data) return res.json({ fpy_critical: 70, fpy_needs: 85, fpy_watch: 95, epy_target: 98, coq_percent_target: 4 });
    res.json(data);
  } catch { res.json({ fpy_critical: 70, fpy_needs: 85, fpy_watch: 95, epy_target: 98, coq_percent_target: 4 }); }
});

// ─── OVERRIDES ───
let _overridesFallback = {};
app.get('/api/overrides', async (req, res) => {
  try {
    const { data, error } = await supabase.from('report_overrides').select('*');
    if (error) return res.json(_overridesFallback);
    const map = {};
    for (const r of data || []) map[`${r.level}|${r.override_id}`] = { parts: +r.parts, delivered: +r.delivered };
    res.json(map);
  } catch { res.json(_overridesFallback); }
});
app.post('/api/overrides', async (req, res) => {
  const { level, id, parts, delivered } = req.body || {};
  if (!level || !id) return res.status(400).json({ error: 'level and id required' });
  const fullKey = `${level}|${id}`;
  if (parts == null || delivered == null) {
    delete _overridesFallback[fullKey];
    try { await supabase.from('report_overrides').delete().eq('level', level).eq('override_id', id); } catch {}
    return res.json({ ok: true });
  }
  _overridesFallback[fullKey] = { parts: +parts, delivered: +delivered };
  try { await supabase.from('report_overrides').upsert([{ level, override_id: id, parts: +parts, delivered: +delivered, updated_at: new Date() }], { onConflict: 'level,override_id' }); } catch {}
  res.json({ ok: true });
});

// ─── TELEGRAM AUTH ───
app.post('/api/telegram-auth', async (req, res) => {
  const telegramData = req.body;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Bot token not configured' });
  if (!validateTelegramData(telegramData, botToken)) return res.status(401).json({ error: 'Invalid auth data' });
  const authDate = new Date(telegramData.auth_date * 1000);
  if (new Date() - authDate > 24*60*60*1000) return res.status(401).json({ error: 'Auth too old' });
  const { data: existingUser, error: findError } = await supabase.from('telegram_users').select('*').eq('telegram_id', telegramData.id).maybeSingle();
  if (findError && findError.code !== 'PGRST116') return res.status(500).json({ error: 'DB error' });
  let user = existingUser;
  if (!user) {
    const { data: newUser, error: insertError } = await supabase.from('telegram_users').insert([{
      telegram_id: telegramData.id, first_name: telegramData.first_name,
      last_name: telegramData.last_name || '', username: telegramData.username || '',
      photo_url: telegramData.photo_url || '', auth_date: new Date(telegramData.auth_date * 1000)
    }]).select().single();
    if (insertError) return res.status(500).json({ error: 'Could not create user' });
    user = newUser;
  } else {
    await supabase.from('telegram_users').update({ auth_date: new Date(telegramData.auth_date * 1000) }).eq('telegram_id', telegramData.id);
  }
  const token = jwt.sign({ telegram_id: user.telegram_id, username: user.username || `${user.first_name} ${user.last_name}`, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.telegram_id, name: `${user.first_name} ${user.last_name}`, username: user.username } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server on http://localhost:${PORT}`);
  console.log(`🔗 Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
});
