require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sf-claude-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../frontend')));

// ——————————————————————————
// HELPER: SOAP Login
// ——————————————————————————
async function soapLogin(username, password, securityToken, orgType) {
  const loginUrl = orgType === 'sandbox' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
  const fullPassword = securityToken ? password + securityToken : password;
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${username}</urn:username>
      <urn:password>${fullPassword}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(loginUrl + '/services/Soap/u/57.0', soapBody, {
    headers: { 'Content-Type': 'text/xml', 'SOAPAction': 'login' }
  });
  const xml = response.data;
  if (xml.includes('<faultstring>')) {
    const m = xml.match(/<faultstring>(.*?)<\/faultstring>/s);
    throw new Error(m ? m[1].trim() : 'Login failed');
  }
  const sessionMatch = xml.match(/<sessionId>(.*?)<\/sessionId>/);
  const serverUrlMatch = xml.match(/<serverUrl>(.*?)<\/serverUrl>/);
  const userFullNameMatch = xml.match(/<userFullName>(.*?)<\/userFullName>/);
  const userEmailMatch = xml.match(/<userEmail>(.*?)<\/userEmail>/);
  if (!sessionMatch || !serverUrlMatch) throw new Error('Could not parse login response');
  const instanceUrl = serverUrlMatch[1].match(/^(https:\/\/[^\/]+)/)[1];
  return {
    access_token: sessionMatch[1],
    instance_url: instanceUrl,
    user_name: userFullNameMatch ? userFullNameMatch[1] : username,
    user_email: userEmailMatch ? userEmailMatch[1] : ''
  };
}

// ——————————————————————————
// ROUTE: Login
// ——————————————————————————
app.post('/api/login', async (req, res) => {
  const { username, password, securityToken, orgType } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  try {
    const r = await soapLogin(username, password, securityToken || '', orgType || 'production');
    req.session.sfAccessToken = r.access_token;
    req.session.sfInstanceUrl = r.instance_url;
    req.session.sfUserInfo = { name: r.user_name, email: r.user_email, preferred_username: username };
    res.json({ success: true, user: { name: r.user_name, email: r.user_email, username } });
  } catch (err) {
    let msg = err.message;
    if (msg.includes('INVALID_LOGIN')) msg = 'Invalid username or password. If your IP is not trusted, append your Security Token.';
    else if (msg.includes('LOGIN_MUST_USE_SECURITY_TOKEN')) msg = 'Your IP is not trusted. Please enter your Security Token.';
    res.status(401).json({ error: msg });
  }
});

app.get('/api/auth/status', (req, res) => {
  if (req.session.sfAccessToken) res.json({ connected: true, user: req.session.sfUserInfo });
  else res.json({ connected: false });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ——————————————————————————
// HELPER: Detect export intent
// ——————————————————————————
function detectExportIntent(message) {
  const msg = message.toLowerCase();
  const wordKw = ['word document','word doc','docx','word file','ms word','microsoft word','generate word','create word','export word','download word','word format'];
  const excelKw = ['excel','xlsx','spreadsheet','excel document','excel file','generate excel','create excel','export excel','download excel','excel format'];
  const isWord = wordKw.some(k => msg.includes(k));
  const isExcel = excelKw.some(k => msg.includes(k));
  return { isWord, isExcel, isAny: isWord || isExcel };
}

// ——————————————————————————
// HELPER: Fetch Salesforce metadata including page layouts
// ——————————————————————————
async function getSalesforceMetadata(message, accessToken, instanceUrl) {
  let metadataContext = '';
  try {
    // 1. List all objects
    const descRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const objects = descRes.data.sobjects.filter(o => o.queryable && o.createable).slice(0, 30).map(o => o.name).join(', ');
    metadataContext += 'Available Salesforce Objects: ' + objects + '\n\n';

    // 2. Get field metadata for mentioned objects
    const matches = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g);
    const objectsToDescribe = matches ? matches.slice(0, 3) : [];

    // Always try Account if it's mentioned or implied
    const msgLower = message.toLowerCase();
    if (msgLower.includes('account') && !objectsToDescribe.includes('Account')) {
      objectsToDescribe.unshift('Account');
    }

    for (const objName of objectsToDescribe.slice(0, 2)) {
      try {
        const objRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/', {
          headers: { Authorization: 'Bearer ' + accessToken }
        });
        const fields = objRes.data.fields.map(f => ({
          name: f.name, label: f.label, type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          picklistValues: f.picklistValues ? f.picklistValues.map(p => p.value) : []
        }));
        metadataContext += 'Object: ' + objName + '\nLabel: ' + objRes.data.label + '\n';
        metadataContext += 'Fields (first 50): ' + JSON.stringify(fields.slice(0, 50), null, 2) + '\n\n';

        // 3. Get actual page layouts for this object
        try {
          const layoutRes = await axios.get(
            instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/layouts/',
            { headers: { Authorization: 'Bearer ' + accessToken } }
          );
          const layoutData = layoutRes.data;
          const layoutNames = [];

          // Collect layout names from the response
          if (layoutData.layouts) {
            for (const layout of layoutData.layouts) {
              if (layout.name) layoutNames.push(layout.name);
            }
          }
          // Also check recordTypeMappings for layout names
          if (layoutData.recordTypeMappings) {
            for (const rtm of layoutData.recordTypeMappings) {
              if (rtm.layoutId && rtm.name) {
                // Try to find layout name by ID
              }
            }
          }

          if (layoutNames.length > 0) {
            metadataContext += 'Page Layouts for ' + objName + ':\n';
            layoutNames.forEach(n => { metadataContext += '  - ' + n + '\n'; });
            metadataContext += '\n';
          }
        } catch (le) {
          // Try alternate endpoint
          try {
            const layoutRes2 = await axios.get(
              instanceUrl + '/services/data/v57.0/query/?q=' +
              encodeURIComponent("SELECT Id, Name FROM Layout WHERE TableEnumOrId = '" + objName + "'"),
              { headers: { Authorization: 'Bearer ' + accessToken } }
            );
            if (layoutRes2.data.records && layoutRes2.data.records.length > 0) {
              metadataContext += 'Page Layouts for ' + objName + ':\n';
              layoutRes2.data.records.forEach(r => { metadataContext += '  - ' + r.Name + '\n'; });
              metadataContext += '\n';
            }
          } catch (le2) {
            console.log('Page layout fetch failed:', le2.message);
          }
        }
      } catch (e) {
        console.log('Object describe failed for', objName, e.message);
      }
    }

    // 4. Get profiles
    try {
      const profileRes = await axios.get(
        instanceUrl + '/services/data/v57.0/query/?q=' + encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name LIMIT 20"),
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (profileRes.data.records) {
        const profileNames = profileRes.data.records.map(p => p.Name).join(', ');
        metadataContext += 'Available Profiles: ' + profileNames + '\n\n';
      }
    } catch (pe) {
      console.log('Profile fetch failed:', pe.message);
    }

  } catch (e) {
    console.error('Metadata error:', e.message);
  }
  return metadataContext;
}

// ——————————————————————————
// HELPER: Call Claude with metadata
// ——————————————————————————
async function getDesignSpec(message, accessToken, instanceUrl, exportType) {
  const metadataContext = await getSalesforceMetadata(message, accessToken, instanceUrl);

  const baseInstruction = `CRITICAL FORMATTING RULES - YOU MUST FOLLOW THESE EXACTLY:
1. NEVER use markdown tables (no pipe characters | for tables, no ------ separators)
2. NEVER use --- as a horizontal rule
3. For ANY tabular data (field specs, attribute/value pairs), use this EXACT format:
   FIELD: <field label>
   - API Name: <value>
   - Type: <value>
   - Values: <value>
   - Required: Yes/No
   - Help Text: <value>
   (blank line between each field)
4. Use ## for main headings, ### for sub-headings
5. Use plain bullet points (- ) for lists
6. Write in clean prose paragraphs for descriptions

Always generate the COMPLETE specification immediately. Never ask for more details.
If something is not specified, make a reasonable Salesforce best-practice assumption and note it.
Use the EXACT page layout names and profile names from the metadata provided - never say "default layout".
`;

  let exportInstruction = '';
  if (exportType === 'word') {
    exportInstruction = `
Structure your response with these exact sections:

## Design Specification Document

### 1. Requirement Summary
(2-3 sentence summary)

### 2. Object Details
FIELD: Object Overview
- Object Name: <value>
- API Name: <value>
- Object Type: Standard/Custom
- Purpose: <value>
- Customization Type: New Custom Field Addition

### 3. Field Specifications
For EACH field, use this block format (NO TABLES):

FIELD: Custom Flag
- API Name: Custom_Flag__c
- Field Type: Picklist
- Picklist Values: Yes, No
- Required: No
- Default Value: None
- Help Text: <suggested help text>
- Description: <purpose>

### 4. Profile and Permission Settings
For each profile from the metadata, specify:

PROFILE: <Exact Profile Name from metadata>
- Field Access: Read/Write or Read Only or Hidden
- Visibility: Visible/Hidden

### 5. Page Layout Settings
Use the EXACT page layout names from the metadata. For each layout:

LAYOUT: <Exact Layout Name from metadata>
- Action: Add field
- Section: <recommended section>
- Position: <left column / right column>
- Required on Layout: Yes/No

### 6. Validation Rules
(List any needed validation rules or state "None required")

### 7. Implementation Steps
1. Step one
2. Step two
3. Step three

### 8. Testing Checklist
- Test case one
- Test case two
`;
  } else if (exportType === 'excel') {
    exportInstruction = `
Structure with these sections. NO TABLES, NO PIPE CHARACTERS:

## Design Specification

### Requirement Summary
(Brief summary)

### Field Specifications
For each field:
FIELD: <label>
- API Name: <value>
- Type: <value>
- Values: <value>
- Required: Yes/No
- Profile Access: <profile name> - Read/Write

### Page Layout Settings
LAYOUT: <Exact layout name from metadata>
- Section: <name>
- Position: Left/Right

### Implementation Steps
1. Step one
2. Step two
`;
  } else {
    exportInstruction = `
Structure your response with clear sections. NO TABLES, NO PIPE CHARACTERS.
Include: Requirement summary, Field specifications (using FIELD: blocks), Profile settings, Page layout settings (using exact layout names), Implementation steps, Testing checklist.
`;
  }

  const claudeRes = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4000,
    system: `You are a Salesforce design specification expert.

${baseInstruction}

${exportInstruction}

Salesforce Metadata from the connected org:
${metadataContext}`,
    messages: [{ role: 'user', content: message }]
  });

  return claudeRes.content[0].text;
}

// ——————————————————————————
// ROUTE: Chat
// ——————————————————————————
app.post('/api/chat', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated with Salesforce' });
  const { message } = req.body;
  try {
    const intent = detectExportIntent(message);
    let exportType = null;
    if (intent.isWord) exportType = 'word';
    else if (intent.isExcel) exportType = 'excel';
    const response = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl, exportType);
    res.json({ response, exportIntent: intent });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ——————————————————————————
// HELPER: Build Word paragraph from text (handles bold inline)
// ——————————————————————————
function makeTextRuns(text) {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) => new TextRun({ text: part, bold: i % 2 === 1, size: 22, font: 'Calibri' }));
}

// ——————————————————————————
// HELPER: Build a styled 2-column Word table from key:value pairs
// ——————————————————————————
function buildKeyValueTable(rows) {
  const borderStyle = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const tableRows = rows.map((row, idx) => {
    const isHeader = idx === 0 && row.isHeader;
    const bgColor = isHeader ? '1F4E79' : (idx % 2 === 0 ? 'F2F7FC' : 'FFFFFF');
    const textColor = isHeader ? 'FFFFFF' : '000000';
    return new TableRow({
      children: [
        new TableCell({
          width: { size: 35, type: WidthType.PERCENTAGE },
          shading: { fill: bgColor, type: ShadingType.CLEAR, color: bgColor },
          borders: { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle },
          children: [new Paragraph({
            children: [new TextRun({ text: row.key, bold: true, color: textColor, size: 20, font: 'Calibri' })],
            spacing: { before: 60, after: 60 }
          })]
        }),
        new TableCell({
          width: { size: 65, type: WidthType.PERCENTAGE },
          shading: { fill: bgColor, type: ShadingType.CLEAR, color: bgColor },
          borders: { top: borderStyle, bottom: borderStyle, left: borderStyle, right: borderStyle },
          children: [new Paragraph({
            children: [new TextRun({ text: row.value, color: textColor, size: 20, font: 'Calibri' })],
            spacing: { before: 60, after: 60 }
          })]
        })
      ]
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableRows
  });
}

// ——————————————————————————
// HELPER: Parse Claude's text output into Word doc elements
// ——————————————————————————
function parseToWordElements(specText, requirementText) {
  const lines = specText.split('\n');
  const elements = [];
  let i = 0;

  // Title
  elements.push(new Paragraph({
    children: [new TextRun({ text: 'Salesforce Life Science Cloud Design Specification', bold: true, size: 48, color: '1F4E79', font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 }
  }));

  // Date line
  elements.push(new Paragraph({
    children: [new TextRun({ text: 'Generated: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), size: 20, color: '666666', font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 }
  }));

  // Requirement line
  if (requirementText) {
    elements.push(new Paragraph({
      children: [
        new TextRun({ text: 'Requirement: ', bold: true, size: 20, color: '1F4E79', font: 'Calibri' }),
        new TextRun({ text: requirementText, size: 20, font: 'Calibri' })
      ],
      spacing: { after: 400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '1F4E79' } }
    }));
  }

  // Collect FIELD: blocks and their attributes
  let fieldBlock = null;
  let fieldRows = [];

  const flushFieldBlock = () => {
    if (fieldBlock && fieldRows.length > 0) {
      // Header row for the field table
      elements.push(new Paragraph({
        children: [new TextRun({ text: fieldBlock, bold: true, size: 22, color: 'FFFFFF', font: 'Calibri' })],
        shading: { type: ShadingType.CLEAR, fill: '2E75B6', color: '2E75B6' },
        spacing: { before: 120, after: 0 }
      }));
      elements.push(buildKeyValueTable(fieldRows));
      elements.push(new Paragraph({ text: '', spacing: { after: 200 } }));
      fieldBlock = null;
      fieldRows = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip markdown table lines entirely
    if (/^\|/.test(trimmed) || /^[-|]{3,}/.test(trimmed)) {
      i++;
      continue;
    }

    // Skip horizontal rules
    if (/^---+$/.test(trimmed) || /^===+$/.test(trimmed)) {
      i++;
      continue;
    }

    // Detect FIELD: block header
    if (/^FIELD:\s*(.+)/.test(trimmed)) {
      flushFieldBlock();
      fieldBlock = trimmed.replace(/^FIELD:\s*/, '');
      i++;
      continue;
    }

    // Detect PROFILE: or LAYOUT: block headers (same treatment as FIELD:)
    if (/^(PROFILE|LAYOUT):\s*(.+)/.test(trimmed)) {
      flushFieldBlock();
      const m = trimmed.match(/^(PROFILE|LAYOUT):\s*(.+)/);
      fieldBlock = m[1] + ': ' + m[2];
      i++;
      continue;
    }

    // If we're inside a field/profile/layout block, collect - key: value lines
    if (fieldBlock && /^-\s+[\w\s]+:\s*.+/.test(trimmed)) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(1, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();
      fieldRows.push({ key, value });
      i++;
      continue;
    }

    // If we encounter a non-list line while in a field block, flush it
    if (fieldBlock && trimmed !== '' && !/^-/.test(trimmed)) {
      flushFieldBlock();
    }

    // H1 heading
    if (/^##\s/.test(trimmed)) {
      const text = trimmed.replace(/^##\s*/, '');
      elements.push(new Paragraph({
        children: [new TextRun({ text, bold: true, size: 28, color: '1F4E79', font: 'Calibri' })],
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '1F4E79' } },
        spacing: { before: 480, after: 160 }
      }));
      i++;
      continue;
    }

    // H2 heading
    if (/^###\s/.test(trimmed)) {
      const text = trimmed.replace(/^###\s*/, '');
      elements.push(new Paragraph({
        children: [new TextRun({ text, bold: true, size: 24, color: '2E75B6', font: 'Calibri' })],
        spacing: { before: 320, after: 120 }
      }));
      i++;
      continue;
    }

    // H3 heading
    if (/^####\s/.test(trimmed)) {
      const text = trimmed.replace(/^####\s*/, '');
      elements.push(new Paragraph({
        children: [new TextRun({ text, bold: true, size: 22, color: '2E75B6', font: 'Calibri' })],
        spacing: { before: 200, after: 80 }
      }));
      i++;
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      const text = trimmed.replace(/^\d+\.\s*/, '');
      elements.push(new Paragraph({
        children: makeTextRuns(text),
        numbering: { reference: 'default-numbering', level: 0 },
        spacing: { after: 80 }
      }));
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*•]\s/.test(trimmed)) {
      const text = trimmed.replace(/^[-*•]\s*/, '');
      elements.push(new Paragraph({
        children: makeTextRuns(text),
        bullet: { level: 0 },
        spacing: { after: 80 }
      }));
      i++;
      continue;
    }

    // Empty line
    if (!trimmed) {
      elements.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      i++;
      continue;
    }

    // Normal paragraph
    elements.push(new Paragraph({
      children: makeTextRuns(trimmed),
      spacing: { after: 120 }
    }));
    i++;
  }

  flushFieldBlock();
  return elements;
}

// ——————————————————————————
// ROUTE: Export to Word (.docx)
// ——————————————————————————
app.post('/api/export/word', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;
  try {
    let specText = content;
    if (!specText) {
      specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl, 'word');
    }

    const docChildren = parseToWordElements(specText, message);

    const doc = new Document({
      numbering: {
        config: [{
          reference: 'default-numbering',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 260 } } } }]
        }]
      },
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 22 }
          }
        }
      },
      sections: [{ properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: docChildren }]
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = 'SF_Design_Spec_' + new Date().toISOString().slice(0, 10) + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(buffer);
  } catch (err) {
    console.error('Word export error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ——————————————————————————
// ROUTE: Export to Excel (.xlsx)
// ——————————————————————————
app.post('/api/export/excel', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;
  try {
    let specText = content;
    if (!specText) {
      specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl, 'excel');
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SF Claude Designer';
    workbook.created = new Date();

    // Sheet 1: Design Specification
    const sheet1 = workbook.addWorksheet('Design Specification');
    sheet1.columns = [{ key: 'col1', width: 30 }, { key: 'col2', width: 80 }];

    sheet1.mergeCells('A1:B1');
    const titleCell = sheet1.getCell('A1');
    titleCell.value = 'Salesforce Life Science Cloud Design Specification';
    titleCell.font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet1.getRow(1).height = 40;

    sheet1.mergeCells('A2:B2');
    const dateCell = sheet1.getCell('A2');
    dateCell.value = 'Generated: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    dateCell.font = { name: 'Calibri', size: 11, color: { argb: 'FF666666' } };
    dateCell.alignment = { horizontal: 'center' };
    dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F9' } };
    sheet1.getRow(2).height = 22;

    if (message) {
      sheet1.mergeCells('A3:B3');
      const queryCell = sheet1.getCell('A3');
      queryCell.value = 'Requirement: ' + message;
      queryCell.font = { name: 'Calibri', size: 11, italic: true };
      queryCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4FD' } };
      queryCell.alignment = { wrapText: true };
      sheet1.getRow(3).height = 30;
    }

    let rowIdx = message ? 5 : 4;
    const lines = specText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip markdown table lines and horizontal rules
      if (/^\|/.test(trimmed) || /^[-|]{3,}/.test(trimmed) || /^---+$/.test(trimmed)) continue;
      if (!trimmed) { rowIdx++; continue; }

      sheet1.mergeCells('A' + rowIdx + ':B' + rowIdx);
      const cell = sheet1.getCell('A' + rowIdx);
      cell.alignment = { wrapText: true, vertical: 'top' };

      if (/^## /.test(trimmed)) {
        cell.value = trimmed.replace(/^##\s*/, '');
        cell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF1F4E79' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0E4F7' } };
        sheet1.getRow(rowIdx).height = 28;
      } else if (/^###/.test(trimmed)) {
        cell.value = trimmed.replace(/^###\s*/, '');
        cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF2E75B6' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F8FF' } };
        sheet1.getRow(rowIdx).height = 22;
      } else if (/^FIELD:|^PROFILE:|^LAYOUT:/.test(trimmed)) {
        cell.value = trimmed.replace(/^(FIELD|PROFILE|LAYOUT):\s*/, '');
        cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E75B6' } };
        sheet1.getRow(rowIdx).height = 22;
      } else if (/^[-*]\s/.test(trimmed)) {
        cell.value = '  • ' + trimmed.replace(/^[-*]\s*/, '').replace(/\*\*/g, '');
        cell.font = { name: 'Calibri', size: 11 };
        sheet1.getRow(rowIdx).height = 18;
      } else {
        cell.value = trimmed.replace(/\*\*/g, '');
        cell.font = { name: 'Calibri', size: 11 };
        sheet1.getRow(rowIdx).height = 18;
      }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E5EE' } } };
      rowIdx++;
    }

    // Sheet 2: Fields Summary
    const sheet2 = workbook.addWorksheet('Fields Summary');
    sheet2.columns = [
      { header: 'Field API Name', key: 'apiName', width: 30 },
      { header: 'Label', key: 'label', width: 30 },
      { header: 'Field Type', key: 'type', width: 20 },
      { header: 'Values / Length', key: 'values', width: 30 },
      { header: 'Required', key: 'required', width: 12 },
      { header: 'Profile Access', key: 'profile', width: 25 },
      { header: 'Notes', key: 'notes', width: 40 }
    ];

    const hdr = sheet2.getRow(1);
    hdr.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF032D60' } } };
    });
    hdr.height = 25;

    // Parse FIELD: blocks from specText
    let currentField = null;
    let fieldData = {};
    let fieldRows2 = [];

    const flushField = () => {
      if (currentField) {
        fieldRows2.push({
          apiName: fieldData['api name'] || fieldData['api'] || currentField,
          label: currentField,
          type: fieldData['field type'] || fieldData['type'] || '',
          values: fieldData['picklist values'] || fieldData['values'] || fieldData['values / length'] || '',
          required: fieldData['required'] || 'No',
          profile: fieldData['profile access'] || '',
          notes: fieldData['description'] || fieldData['help text'] || ''
        });
      }
    };

    for (const line of lines) {
      const t = line.trim();
      if (/^FIELD:\s*(.+)/.test(t)) {
        flushField();
        currentField = t.replace(/^FIELD:\s*/, '');
        fieldData = {};
      } else if (currentField && /^-\s+[\w\s]+:\s*.+/.test(t)) {
        const ci = t.indexOf(':');
        const key = t.substring(1, ci).trim().toLowerCase();
        const val = t.substring(ci + 1).trim();
        fieldData[key] = val;
      } else if (currentField && t && !/^-/.test(t)) {
        flushField();
        currentField = null;
        fieldData = {};
      }
    }
    flushField();

    let fRowIdx = 2;
    for (const fr of fieldRows2) {
      const row = sheet2.addRow(fr);
      row.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E5EE' } } };
        cell.alignment = { wrapText: true };
        if (fRowIdx % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F8FF' } };
      });
      fRowIdx++;
    }

    if (fRowIdx === 2) {
      sheet2.addRow({ apiName: 'See Design Specification tab', label: '', type: '', values: '', required: '', profile: '', notes: '' });
    }
    sheet2.autoFilter = { from: 'A1', to: 'G1' };

    const filename = 'SF_Design_Spec_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
