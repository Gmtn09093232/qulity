const express = require('express');
const router = express.Router();

module.exports = (supabase) => {
  // Submit new inspection
  router.post('/', async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const inspectionData = {
      user_id: user.id,
      username: user.email, // or use user.user_metadata.full_name
      ...req.body,
      submitted_at: new Date()
    };

    const { data, error } = await supabase
      .from('rolling_inspections')
      .insert([inspectionData])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  });

  // Get all inspections for the logged-in user
  router.get('/', async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
      .from('rolling_inspections')
      .select('*')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  });

  return router;
};