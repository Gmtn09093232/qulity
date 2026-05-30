require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Middleware to attach supabase and get user from token
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (user) req.user = user;
  }
  next();
});

const path = require('path');

// Serve the HTML form when visiting the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// If you have static files (CSS, JS), serve them as well
app.use(express.static('public'));

// Routes
app.use('/api/inspections', require('./inspections')(supabase));

app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));