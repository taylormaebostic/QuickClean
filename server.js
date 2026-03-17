const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/quickclean';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const taskSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  title: { type: String, required: true },
  category: { type: String, required: true },
  steps: [{ text: String, completed: Boolean, timeMinutes: Number }],
  totalTime: { type: Number, default: 5 },
  completed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', taskSchema);

const templates = {
  kitchen: {
    title: "Quick Kitchen Clean",
    steps: [
      { text: "Clear counters - put away items", timeMinutes: 1 },
      { text: "Wipe down counters and stovetop", timeMinutes: 1 },
      { text: "Load/unload dishwasher or wash dishes", timeMinutes: 2 },
      { text: "Wipe sink and faucet", timeMinutes: 0.5 },
      { text: "Take out trash if needed", timeMinutes: 0.5 }
    ]
  },
  bathroom: {
    title: "Quick Bathroom Clean",
    steps: [
      { text: "Spray toilet with cleaner, let sit", timeMinutes: 0.5 },
      { text: "Wipe mirror and counter", timeMinutes: 1 },
      { text: "Scrub toilet bowl and wipe outside", timeMinutes: 1 },
      { text: "Quick floor sweep/wipe", timeMinutes: 1 },
      { text: "Replace towels, empty trash", timeMinutes: 1.5 }
    ]
  },
  bedroom: {
    title: "Quick Bedroom Tidy",
    steps: [
      { text: "Make the bed", timeMinutes: 1 },
      { text: "Pick up clothes - hamper or hang", timeMinutes: 1.5 },
      { text: "Clear nightstand and surfaces", timeMinutes: 1 },
      { text: "Quick vacuum or floor sweep", timeMinutes: 1 },
      { text: "Fluff pillows, straighten items", timeMinutes: 0.5 }
    ]
  },
  livingroom: {
    title: "Quick Living Room Tidy",
    steps: [
      { text: "Pick up clutter, return items to place", timeMinutes: 1.5 },
      { text: "Fluff couch cushions and fold blankets", timeMinutes: 1 },
      { text: "Wipe coffee table and surfaces", timeMinutes: 1 },
      { text: "Quick vacuum high-traffic areas", timeMinutes: 1 },
      { text: "Straighten remotes, books, decor", timeMinutes: 0.5 }
    ]
  },
  desk: {
    title: "Quick Desk Clean",
    steps: [
      { text: "Clear papers - file, trash, or action pile", timeMinutes: 1.5 },
      { text: "Wipe down desk surface", timeMinutes: 1 },
      { text: "Organize pens, supplies", timeMinutes: 1 },
      { text: "Wipe screen and keyboard", timeMinutes: 1 },
      { text: "Cable management check", timeMinutes: 0.5 }
    ]
  },
  car: {
    title: "Quick Car Clean",
    steps: [
      { text: "Remove all trash", timeMinutes: 1 },
      { text: "Collect loose items, put in place", timeMinutes: 1 },
      { text: "Wipe dashboard and console", timeMinutes: 1 },
      { text: "Shake out floor mats", timeMinutes: 1 },
      { text: "Wipe cup holders and door pockets", timeMinutes: 1 }
    ]
  }
};

const JWT_SECRET = process.env.JWT_SECRET || 'quickclean-secret-2024';

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: 'Email exists' });
    const hash = await bcrypt.hash(password, 10);
    const user = await new User({ email, password: hash, name }).save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email, name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

app.get('/api/templates', (req, res) => {
  res.json(Object.keys(templates).map(key => ({
    id: key,
    title: templates[key].title,
    totalTime: templates[key].steps.reduce((sum, s) => sum + s.timeMinutes, 0)
  })));
});

app.get('/api/templates/:id', (req, res) => {
  const template = templates[req.params.id];
  if (!template) return res.status(404).json({ error: 'Not found' });
  res.json({ ...template, id: req.params.id });
});

app.post('/api/ai/breakdown', async (req, res) => {
  try {
    const { task, timeLimit } = req.body;
    const minutes = timeLimit || 5;
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You break down cleaning/organizing tasks into simple steps that fit within ${minutes} minutes total. Return JSON only: {"title": "Task Title", "steps": [{"text": "step description", "timeMinutes": 1}]}. Keep steps simple, actionable, and encouraging.`
      }, {
        role: 'user',
        content: `Break down this task into ${minutes}-minute chunks: ${task}`
      }],
      response_format: { type: 'json_object' }
    });
    
    const result = JSON.parse(response.choices[0].message.content);
    result.steps = result.steps.map(s => ({ ...s, completed: false }));
    res.json(result);
  } catch (e) {
    console.error('AI Error:', e);
    res.status(500).json({ error: 'AI breakdown failed. Try a template instead!' });
  }
});

app.get('/api/tasks', auth, async (req, res) => {
  const tasks = await Task.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json(tasks);
});

app.post('/api/tasks', auth, async (req, res) => {
  const { title, category, steps } = req.body;
  const totalTime = steps.reduce((sum, s) => sum + (s.timeMinutes || 1), 0);
  const task = await new Task({
    userId: req.userId, title, category,
    steps: steps.map(s => ({ ...s, completed: false })),
    totalTime
  }).save();
  res.json(task);
});

app.put('/api/tasks/:id/step/:stepIndex', auth, async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.steps[req.params.stepIndex].completed = req.body.completed;
  task.completed = task.steps.every(s => s.completed);
  await task.save();
  res.json(task);
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  await Task.findOneAndDelete({ _id: req.params.id, userId: req.userId });
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'QuickClean' }));

app.get('*', (req, res) => res.sendFile('index.html', { root: './public' }));

app.listen(PORT, '0.0.0.0', () => console.log('QuickClean running on port ' + PORT));
