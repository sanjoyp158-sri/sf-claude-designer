require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sf-claude-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ─────────────────────────────────────────────
// ROUTE: Salesforce Login
// ─────────────────────────────────────────────
app.post('/api/sf/login', async (req, res) => {
  const { username, password, securityToken, isSandbox } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const loginUrl = isSandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
    const passwordWithToken = securityToken ? password + securityToken : password;
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
      username,
      password: passwordWithToken,
    });
    const response = await axios.post(`${loginUrl}/services/oauth2/token`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, instance_url } = response.data;
    req.session.sf = { access_token, instance_url, username };
    res.json({ success: true, message: 'Connected to Salesforce!', instance_url, username });
  } catch (err) {
    const sfError = err.response?.data?.error_description || err.message;
    res.status(401).json({ error: `Salesforce login failed: ${sfError}` });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Check Salesforce Session
// ─────────────────────────────────────────────
app.get('/api/sf/status', (req, res) => {
  if (req.session.sf) {
    res.json({ connected: true, username: req.session.sf.username, instance_url: req.session.sf.instance_url });
  } else {
    res.json({ connected: false });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Logout
// ─────────────────────────────────────────────
app.post('/api/sf/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// ROUTE: List all Salesforce Objects
// ─────────────────────────────────────────────
app.get('/api/sf/objects', async (req, res) => {
  if (!req.session.sf) return res.status(401).json({ error: 'Not connected to Salesforce' });
  try {
    const { access_token, instance_url } = req.session.sf;
    const response = await axios.get(`${instance_url}/services/data/v59.0/sobjects/`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const objects = response.data.sobjects.map(obj => ({
      name: obj.name, label: obj.label, custom: obj.custom,
    }));
    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Salesforce objects' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Get metadata for a specific object
// ─────────────────────────────────────────────
app.get('/api/sf/metadata/:objectName', async (req, res) => {
  if (!req.session.sf) return res.status(401).json({ error: 'Not connected to Salesforce' });
  try {
    const { access_token, instance_url } = req.session.sf;
    const response = await axios.get(
      `${instance_url}/services/data/v59.0/sobjects/${req.params.objectName}/describe/`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch metadata for ${req.params.objectName}` });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Main Chat Endpoint
// ─────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!req.session.sf) return res.status(401).json({ error: 'Not connected to Salesforce' });
  const { message, conversationHistory } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    const { access_token, instance_url } = req.session.sf;

    // Step 1: Detect which Salesforce object(s) the user is asking about
    const objectDetectionResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Extract Salesforce object names from this question. Return ONLY a JSON array of object API names like ["Account"] or ["Opportunity","Contact"]. If no specific object is mentioned return ["Account"].
Question: "${message}"`
      }]
    });

    let objectNames = ['Account'];
    try {
      const detected = objectDetectionResponse.content[0].text.trim();
      const jsonMatch = detected.match(/\[.*\]/s);
      if (jsonMatch) objectNames = JSON.parse(jsonMatch[0]);
    } catch (e) { /* fallback */ }

    // Step 2: Fetch metadata for detected objects (max 3)
    const metadataResults = await Promise.all(
      objectNames.slice(0, 3).map(async (objName) => {
        try {
          const response = await axios.get(
            `${instance_url}/services/data/v59.0/sobjects/${objName}/describe/`,
            { headers: { Authorization: `Bearer ${access_token}` } }
          );
          return { name: objName, metadata: response.data };
        } catch (e) {
          return { name: objName, metadata: null };
        }
      })
    );

    // Step 3: Build metadata context summary
    const metadataContext = metadataResults.filter(r => r.metadata).map(r => ({
      objectName: r.name,
      label: r.metadata.label,
      fields: r.metadata.fields.map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: !f.nillable && !f.defaultedOnCreate,
        unique: f.unique,
        referenceTo: f.referenceTo?.length ? f.referenceTo : undefined,
        picklistValues: f.picklistValues?.length ? f.picklistValues.map(p => p.value) : undefined,
      })),
      childRelationships: r.metadata.childRelationships?.slice(0, 10).map(c => ({
        childObject: c.childSObject, field: c.field
      })),
    }));

    // Step 4: Call Claude with metadata context + user question
    const systemPrompt = `You are an expert Salesforce Solution Architect and Business Analyst with deep knowledge of Salesforce metadata, data models, and best practices.

You have been provided with live Salesforce object metadata from the user's actual org.

Your role:
1. Analyze the provided metadata carefully
2. Answer questions accurately based on real org configuration
3. Generate detailed, professional design specifications when requested
4. Identify gaps, recommendations, and best practices

When generating design specs, include:
- ## Object Overview
- ## Data Model & Fields Analysis
- ## Relationships & Dependencies
- ## Required vs Optional Fields
- ## Recommended Automations / Validations
- ## Integration Considerations
- ## Recommendations & Best Practices

Format responses with clear markdown headings, tables where appropriate, and professional structure.`;

    const messages = [
      ...(conversationHistory || []),
      {
        role: 'user',
        content: `## Salesforce Org Metadata

${JSON.stringify(metadataContext, null, 2)}

## User Question
${message}`
      }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    res.json({
      response: claudeResponse.content[0].text,
      objectsAnalyzed: objectNames,
      tokensUsed: claudeResponse.usage,
    });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: `Chat failed: ${err.message}` });
  }
});

// Serve frontend for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ SF Claude Designer running at http://localhost:${PORT}`);
});
