require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here_change_in_production';

function getTableForProcess(processType) {
  if (!processType) return 'rolling_inspections';
  const lower = processType.toLowerCase();
  if (lower.includes('assembling (welding)') || lower.includes('assembling (fastener)') ||
      lower.includes('assembling(welding)') || lower.includes('assembling(fastener)')) return 'assembly_inspections';
  return 'rolling_inspections';
}

function normaliseOperationStatus(raw) {
  const lower = String(raw || '').trim().toLowerCase();
  if (!lower) return null;
  if (lower === 'continue') return 'continuous';
  return lower;
}

function deriveResult(acceptanceData) {
  const ratings = Object.values(acceptanceData || {}).map(p => (p && p.rating) || '').filter(Boolean);
  if (ratings.length === 0) return null;
  if (ratings.includes('Reject')) return 'Reject';
  if (ratings.includes('Rework')) return 'Rework';
  if (ratings.includes('Conditional Accept')) return 'Conditional Accept';
  return 'Accepted';
}

function computeCumulativePoints(acceptanceData) {
  const ratings = Object.values(acceptanceData || {}).map(p => (p && p.rating) || '').filter(Boolean);
  if (ratings.length === 0) return 0;
  const scoreMap = { 'Accepted': 1, 'Conditional Accept': 0.5, 'Rework': 0.25, 'Reject': 0 };
  return +(ratings.reduce((s, r) => s + (scoreMap[r] ?? 0), 0) / ratings.length).toFixed(3);
}

function buildInspectionRow(req) {
  const extra = req.body.extra_fields || {};
  const processT = req.body.process_type;
  const table = getTableForProcess(processT);
  const isAsm = table === 'assembly_inspections';

  const acceptance = req.body.acceptance_data || {};
  
  // Ensure all numeric fields are parsed as floats (decimals)
  const accepted = parseFloat(req.body.accepted_qty) || 0;
  const rework = parseFloat(req.body.rework_qty) || 0;
  const reject = parseFloat(req.body.reject_qty) || 0;
  const conditional = parseFloat(req.body.conditional_accept_qty) || 0;
  const totalOutcomes = isAsm ? 0 : (accepted + rework + reject + conditional);

  const selectedPartNames = Array.isArray(extra.selectedPartNames)
    ? extra.selectedPartNames.filter(n => n && n.trim())
    : (extra.selectedParts && typeof extra.selectedParts === 'object' ? Object.keys(extra.selectedParts).filter(n => n && n.trim()) : []);
  
  const assemblyPartsCount = isAsm ? selectedPartNames.length : 0;
  const assemblyTotalParts = isAsm ? (parseFloat(extra.totalPartsCount) || 0) : 0;
  const assemblyCompletion = (isAsm && assemblyTotalParts > 0) ? +((assemblyPartsCount / assemblyTotalParts) * 100).toFixed(1) : null;

  return {
    ...req.body,
    submitted_at: new Date(),
    customer_name: extra['Customer Name'] || null,
    project_name: extra['Project Name'] || null,
    subtitle: extra['Subtitle'] || null,
    sub_sub_assembly: extra['Sub Sub Assembly'] || null,
    drawing_no: extra['Drawing No.'] || null,
    part_name: extra['Part Name'] || null,
    tag_no: extra['Tag No.'] || null,
    work_station: extra['Work Station'] || null,
    location: extra['Location'] || null,
    suggested_next_operation: req.body.suggested_next_operation || extra['process order'] || null,
    operation_status: normaliseOperationStatus(req.body.operation_status),
    normalised_operation: normaliseOperationStatus(req.body.operation_status),
    
    // Parse ALL numeric fields safely as floats to preserve decimals
    accepted_qty: accepted,
    rework_qty: rework,
    reject_qty: reject,
    conditional_accept_qty: conditional,
    delivered_qty: parseFloat(req.body.delivered_qty) || 0,
    total_delivered_qty: req.body.total_delivered_qty ? parseFloat(req.body.total_delivered_qty) : null,
    selected_parts_count: req.body.selected_parts_count ? parseFloat(req.body.selected_parts_count) : null,
    assembly_progress_pct: req.body.assembly_progress_pct ? parseFloat(req.body.assembly_progress_pct) : null,
    total_minutes: parseFloat(req.body.total_minutes) || 0,
    shift: req.body.shift ? parseInt(req.body.shift) : null, // Shift is usually integer
    
    defected_material_cost: parseFloat(req.body.defected_material_cost) || 0,
    labor_hours: parseFloat(req.body.labor_hours) || 0,
    salary_per_hour: parseFloat(req.body.salary_per_hour) || 0,
    machining_hours: parseFloat(req.body.machining_hours) || 0,
    machining_cost_per_hr: parseFloat(req.body.machining_cost_per_hr) || 0,
    total_internal_failure_cost: parseFloat(req.body.total_internal_failure_cost) || 0,
    
    severity: (req.body.severity || extra['Severity'] || 'major').toLowerCase(),
    is_final_op: !!req.body.is_final_op,
    total_outcomes_qty: totalOutcomes,
    derived_result: deriveResult(acceptance),
    cumulative_points: computeCumulativePoints(acceptance),
    assembly_parts_count: assemblyPartsCount,
    assembly_total_parts: assemblyTotalParts,
    assembly_completion_pct: assemblyCompletion,
  };
}

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
app.get('/dash', (req, res) => res.sendFile(path.join(__dirname, 'dash.html')));

app.get('/api/inspections', async (req, res) => {
  try {
    const [r, a] = await Promise.all([
      supabase.from('rolling_inspections').select('*').order('submitted_at', { ascending: false }),
      supabase.from('assembly_inspections').select('*').order('submitted_at', { ascending: false })
    ]);
    if (r.error) throw new Error(r.error.message);
    if (a.error) throw new Error(a.error.message);
    const combined = [...(r.data || []), ...(a.data || [])];
    combined.sort((x, y) => new Date(y.submitted_at) - new Date(x.submitted_at));
    res.json(combined);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  let { data, error } = await supabase.from('rolling_inspections').select('*').eq('id', id).single();
  if (error && error.code !== 'PGRST116') return res.status(404).json({ error: error.message });
  if (data) return res.json(data);
  const { data: ad, error: ae } = await supabase.from('assembly_inspections').select('*').eq('id', id).single();
  if (ae) return res.status(404).json({ error: ae.message });
  res.json(ad);
});

app.post('/api/inspections', async (req, res) => {
  try {
    const row = buildInspectionRow(req);
    const table = getTableForProcess(req.body.process_type);
    const { data, error } = await supabase.from(table).insert([row]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inspections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const newTable = getTableForProcess(req.body.process_type);
    const { data: r } = await supabase.from('rolling_inspections').select('id').eq('id', id).maybeSingle();
    const { data: a } = await supabase.from('assembly_inspections').select('id').eq('id', id).maybeSingle();
    const oldTable = r ? 'rolling_inspections' : (a ? 'assembly_inspections' : null);
    
    if (!oldTable) return res.status(404).json({ error: 'Not found' });
    
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

app.delete('/api/inspections/:id', async (req, res) => {
  const { id } = req.params;
  let { error: e1 } = await supabase.from('rolling_inspections').delete().eq('id', id);
  if (e1 && e1.code !== 'PGRST116') return res.status(400).json({ error: e1.message });
  const { error: e2 } = await supabase.from('assembly_inspections').delete().eq('id', id);
  if (e2 && e2.code !== 'PGRST116') return res.status(400).json({ error: e2.message });
  res.status(204).send();
});

app.post('/api/inspections/last-operation', async (req, res) => {
  const { part_name, project_name, subtitle, sub_sub_assembly, drawing_no, tag_no, exclude_id } = req.body;
  if (!part_name) return res.json({ last_operation: null });
  try {
    const buildQ = q => {
      let r = q.select('*').eq('part_name', part_name).order('submitted_at', { ascending: false }).limit(1);
      if (project_name) r = r.eq('project_name', project_name);
      if (subtitle) r = r.eq('subtitle', subtitle);
      if (sub_sub_assembly) r = r.eq('sub_sub_assembly', sub_sub_assembly);
      if (drawing_no) r = r.eq('drawing_no', drawing_no);
      if (tag_no) r = r.eq('tag_no', tag_no);
      if (exclude_id) r = r.neq('id', exclude_id);
      return r;
    };
    const [r, a] = await Promise.all([
      buildQ(supabase.from('rolling_inspections')),
      buildQ(supabase.from('assembly_inspections'))
    ]);
    const all = [...(r.data || []), ...(a.data || [])];
    if (!all.length) return res.json({ last_operation: null });
    const rec = all.sort((x, y) => new Date(y.submitted_at) - new Date(x.submitted_at))[0];
    res.json({ last_operation: {
      process_type: rec.process_type, operation_status: rec.normalised_operation || rec.operation_status,
      submitted_at: rec.submitted_at, acceptance_rating: rec.derived_result || rec.acceptance_data?.p0?.rating || '—',
      suggested_next: rec.suggested_next_operation, delivered_qty: rec.delivered_qty,
      accepted_qty: rec.accepted_qty, rework_qty: rec.rework_qty, reject_qty: rec.reject_qty
    }});
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/thresholds', async (req, res) => {
  try {
    const { data, error } = await supabase.from('report_thresholds').select('*').eq('id', 'default').maybeSingle();
    if (error || !data) return res.json({ fpy_critical: 70, fpy_needs: 85, fpy_watch: 95, epy_target: 98 });
    res.json(data);
  } catch { res.json({ fpy_critical: 70, fpy_needs: 85, fpy_watch: 95, epy_target: 98 }); }
});

let _ov = {};
app.get('/api/overrides', async (req, res) => {
  try {
    const { data, error } = await supabase.from('report_overrides').select('*');
    if (error) return res.json(_ov);
    const m = {};
    for (const r of data || []) m[`${r.level}|${r.override_id}`] = { parts: +r.parts, delivered: +r.delivered };
    res.json(m);
  } catch { res.json(_ov); }
});

app.post('/api/overrides', async (req, res) => {
  const { level, id, parts, delivered } = req.body || {};
  if (!level || !id) return res.status(400).json({ error: 'level and id required' });
  const fk = `${level}|${id}`;
  if (parts == null || delivered == null) {
    delete _ov[fk];
    try { await supabase.from('report_overrides').delete().eq('level', level).eq('override_id', id); } catch {}
    return res.json({ ok: true });
  }
  _ov[fk] = { parts: +parts, delivered: +delivered };
  try { await supabase.from('report_overrides').upsert([{ level, override_id: id, parts: +parts, delivered: +delivered, updated_at: new Date() }], { onConflict: 'level,override_id' }); } catch {}
  res.json({ ok: true });
});

app.post('/api/telegram-auth', async (req, res) => {
  const td = req.body;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Bot token not configured' });
  if (!validateTelegramData(td, botToken)) return res.status(401).json({ error: 'Invalid auth' });
  const authDate = new Date(td.auth_date * 1000);
  if (new Date() - authDate > 24*60*60*1000) return res.status(401).json({ error: 'Auth too old' });
  const { data: ex, error: fe } = await supabase.from('telegram_users').select('*').eq('telegram_id', td.id).maybeSingle();
  if (fe && fe.code !== 'PGRST116') return res.status(500).json({ error: 'DB error' });
  let user = ex;
  if (!user) {
    const { data: nu, error: ie } = await supabase.from('telegram_users').insert([{ telegram_id: td.id, first_name: td.first_name, last_name: td.last_name || '', username: td.username || '', photo_url: td.photo_url || '', auth_date: new Date(td.auth_date * 1000) }]).select().single();
    if (ie) return res.status(500).json({ error: 'Could not create user' });
    user = nu;
  } else {
    await supabase.from('telegram_users').update({ auth_date: new Date(td.auth_date * 1000) }).eq('telegram_id', td.id);
  }
  const token = jwt.sign({ telegram_id: user.telegram_id, username: user.username || `${user.first_name} ${user.last_name}` }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.telegram_id, name: `${user.first_name} ${user.last_name}`, username: user.username } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`🤖 Telegram bot configured: ${process.env.TELEGRAM_BOT_TOKEN ? 'Yes' : 'No'}`);
});
