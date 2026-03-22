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

function detectExportIntent(message) {
  const msg = message.toLowerCase();
  const wordKw = ['word document','word doc','docx','word file','ms word','microsoft word','generate word','create word','export word','download word','word format'];
  const excelKw = ['excel','xlsx','spreadsheet','excel document','excel file','generate excel','create excel','export excel','download excel','excel format'];
  const isWord = wordKw.some(k => msg.includes(k));
  const isExcel = excelKw.some(k => msg.includes(k));
  return { isWord, isExcel, isAny: isWord || isExcel };
}

// ——————————————————————————
// HELPER: Validate metadata - check for conflicts before generating spec
// ——————————————————————————
async function validateMetadataConflicts(message, accessToken, instanceUrl) {
  const conflicts = [];
  const msgLower = message.toLowerCase();

  // Extract object names from message
  const objMatches = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g) || [];
  const commonObjects = ['Account','Contact','Opportunity','Lead','Case','Task','Event','Campaign','Product2','Contract','Order','Quote'];
  const mentionedObjects = [];
  for (const obj of commonObjects) {
    if (msgLower.includes(obj.toLowerCase())) mentionedObjects.push(obj);
  }
  for (const obj of objMatches) {
    if (!mentionedObjects.includes(obj)) mentionedObjects.push(obj);
  }
  if (mentionedObjects.length === 0) return { hasConflicts: false, conflicts: [] };

  // Extract candidate field names from patterns like "field called X", "add X field"
  const fieldNameRegexes = [
    /field(?:\s+called|\s+named|\s+for)?\s+["'`]?([\w\s]+)["'`]?/gi,
    /(?:add|create|new)\s+["'`]?([\w\s]+)["'`]?\s+field/gi,
    /["'`]([\w\s]+)["'`]\s+(?:field|picklist|checkbox|text|number|date|lookup)/gi
  ];
  const candidateFieldNames = new Set();
  for (const rx of fieldNameRegexes) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(message)) !== null) {
      const n = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
      if (n.length > 1 && n.length < 50) candidateFieldNames.add(n);
    }
  }

  // Extract candidate picklist values
  const picklistRegexes = [
    /(?:picklist\s+values?|values?\s+(?:like|such as|including|of))\s*[:"'`]?\s*([\w\s,\/&-]+)/gi,
    /(?:add|create|new)\s+(?:picklist\s+)?values?\s+["'`]?([\w\s,\/&-]+)["'`]?/gi,
    /values?\s*(?:should\s+be|will\s+be|are)\s*["'`]?([\w\s,\/&-]+)["'`]?/gi
  ];
  const candidatePicklistValues = new Set();
  for (const rx of picklistRegexes) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(message)) !== null) {
      m[1].trim().split(/[,\/]/).forEach(v => {
        const val = v.trim().replace(/\band\b/gi, '').trim();
        if (val.length > 0 && val.length < 50) candidatePicklistValues.add(val.toLowerCase());
      });
    }
  }

  for (const objName of mentionedObjects.slice(0, 2)) {
    try {
      const objRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      const existingFields = objRes.data.fields;

      // Check 1: Field name conflict
      for (const candidateName of candidateFieldNames) {
        for (const field of existingFields) {
          const existingLabel = field.label.toLowerCase();
          const existingApi = field.name.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ');
          if (existingLabel === candidateName || existingApi === candidateName ||
              existingLabel.includes(candidateName) || candidateName.includes(existingLabel)) {
            conflicts.push({
              type: 'FIELD_EXISTS',
              message: '\u26a0\ufe0f Field Conflict Detected on ' + objName + '\n\n' +
                'A field with a similar name already exists:\n' +
                '\u2022 Label: "' + field.label + '"\n' +
                '\u2022 API Name: ' + field.name + '\n' +
                '\u2022 Type: ' + field.type + '\n\n' +
                'The field "' + candidateName + '" you are trying to create already exists in the ' + objName + ' object. ' +
                'Please review the existing field before creating a new one.\n\n' +
                'If you intended to modify the existing field or add picklist values to it, please clarify your requirement.'
            });
            break;
          }
        }
        if (conflicts.length > 0) break;
      }

      // Check 2: Picklist value conflict
      if (candidatePicklistValues.size > 0 && conflicts.length === 0) {
        for (const field of existingFields) {
          if (field.type !== 'picklist' || !field.picklistValues || field.picklistValues.length === 0) continue;

          // If we have a candidate field name, check only matching fields; otherwise check all picklist fields
          let shouldCheck = candidateFieldNames.size === 0;
          if (!shouldCheck) {
            for (const cn of candidateFieldNames) {
              const lbl = field.label.toLowerCase();
              const api = field.name.toLowerCase().replace(/__c$/, '').replace(/_/g, ' ');
              if (lbl.includes(cn) || cn.includes(lbl) || api.includes(cn) || cn.includes(api)) {
                shouldCheck = true; break;
              }
            }
          }
          if (!shouldCheck) continue;

          const activeConflicts = [];
          const inactiveConflicts = [];
          for (const candidate of candidatePicklistValues) {
            for (const pv of field.picklistValues) {
              const pvLow = pv.value.toLowerCase();
              if (pvLow === candidate || pvLow.includes(candidate) || candidate.includes(pvLow)) {
                if (pv.active) activeConflicts.push('"' + pv.value + '" (Active)');
                else inactiveConflicts.push('"' + pv.value + '" (Inactive)');
                break;
              }
            }
          }

          if (activeConflicts.length > 0 || inactiveConflicts.length > 0) {
            const allConflicting = [...activeConflicts, ...inactiveConflicts];
            const activeVals = field.picklistValues.filter(p => p.active).map(p => '"' + p.value + '"').join(', ') || 'None';
            const inactiveVals = field.picklistValues.filter(p => !p.active).map(p => '"' + p.value + '"').join(', ') || 'None';
            conflicts.push({
              type: 'PICKLIST_VALUE_EXISTS',
              message: '\u26a0\ufe0f Picklist Value Conflict Detected on ' + objName + ' > ' + field.label + '\n\n' +
                'The following picklist value(s) you are trying to add already exist:\n' +
                allConflicting.map(v => '  \u2022 ' + v).join('\n') + '\n\n' +
                'Active values currently on this field: ' + activeVals + '\n' +
                'Inactive values: ' + inactiveVals + '\n\n' +
                'Please review the existing picklist values before adding duplicates. ' +
                'If you want to reactivate an inactive value, please clarify that in your requirement.'
            });
            break;
          }
        }
      }

    } catch (e) {
      console.log('Validation check failed for', objName, e.message);
    }
  }

  return { hasConflicts: conflicts.length > 0, conflicts };
}

async function getSalesforceMetadata(message, accessToken, instanceUrl) {
  let metadataContext = '';
  try {
    const descRes = await axios.get(instanceUrl + '/services/data/v57.0/sobjects/', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const objects = descRes.data.sobjects.filter(o => o.queryable && o.createable).slice(0, 30).map(o => o.name).join(', ');
    metadataContext += 'Available Salesforce Objects: ' + objects + '\n\n';
    const matches = message.match(/\b([A-Z][a-zA-Z0-9_]+(?:__c)?)\b/g);
    const objectsToDescribe = matches ? matches.slice(0, 3) : [];
    const msgLower = message.toLowerCase();
    if (msgLower.includes('account') && !objectsToDescribe.includes('Account')) objectsToDescribe.unshift('Account');
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
        try {
          const layoutRes = await axios.get(
            instanceUrl + '/services/data/v57.0/sobjects/' + objName + '/describe/layouts/',
            { headers: { Authorization: 'Bearer ' + accessToken } }
          );
          const layoutData = layoutRes.data;
          const layoutNames = [];
          if (layoutData.layouts) for (const layout of layoutData.layouts) { if (layout.name) layoutNames.push(layout.name); }
          if (layoutNames.length > 0) {
            metadataContext += 'Page Layouts for ' + objName + ':\n';
            layoutNames.forEach(n => { metadataContext += ' - ' + n + '\n'; });
            metadataContext += '\n';
          }
        } catch (le) {
          try {
            const layoutRes2 = await axios.get(
              instanceUrl + '/services/data/v57.0/query/?q=' + encodeURIComponent("SELECT Id, Name FROM Layout WHERE TableEnumOrId = '" + objName + "'"),
              { headers: { Authorization: 'Bearer ' + accessToken } }
            );
            if (layoutRes2.data.records && layoutRes2.data.records.length > 0) {
              metadataContext += 'Page Layouts for ' + objName + ':\n';
              layoutRes2.data.records.forEach(r => { metadataContext += ' - ' + r.Name + '\n'; });
              metadataContext += '\n';
            }
          } catch (le2) { console.log('Page layout fetch failed:', le2.message); }
        }
      } catch (e) { console.log('Object describe failed for', objName, e.message); }
    }
    try {
      const profileRes = await axios.get(
        instanceUrl + '/services/data/v57.0/query/?q=' + encodeURIComponent("SELECT Id, Name FROM Profile ORDER BY Name LIMIT 20"),
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (profileRes.data.records) {
        metadataContext += 'Available Profiles: ' + profileRes.data.records.map(p => p.Name).join(', ') + '\n\n';
      }
    } catch (pe) { console.log('Profile fetch failed:', pe.message); }
  } catch (e) { console.error('Metadata error:', e.message); }
  return metadataContext;
}

async function getDesignSpec(message, accessToken, instanceUrl, exportType) {
  const metadataContext = await getSalesforceMetadata(message, accessToken, instanceUrl);

  const baseInstruction = `CRITICAL FORMATTING RULES - YOU MUST FOLLOW THESE EXACTLY:
1. NEVER use markdown tables (no pipe characters | for tables, no ------ separators)
2. NEVER use --- as a horizontal rule
3. Use ## for main section headings, ### for sub-headings
4. Use plain bullet points (- ) for lists
5. Write in clean prose paragraphs for descriptions
6. For the Testing Checklist, output ONLY using this EXACT marker format (one per line):
   TEST_ROW: <Step #> | <Step Description> | <Expected Result>
7. For ALL field/profile/layout/object specs use this EXACT block format:
   FIELD: <label>
   - API Name: <value>
   - Type: <value>
   - Values: <value>
   - Required: Yes/No
   - Help Text: <value>
   PROFILE: <exact profile name>
   - Field Access: <value>
   - Visibility: <value>
   LAYOUT: <exact layout name>
   - Action: <value>
   - Section: <value>
   - Position: <value>
   - Required on Layout: Yes/No
Always generate the COMPLETE specification immediately. Never ask for more details.
Use the EXACT page layout names and profile names from the metadata provided.`;

  const exportInstruction = `
Structure your response with EXACTLY these sections in this order:

## 1. Requirement
Write the requirement as stated by the user in 2-3 clear sentences.

## 2. User Story
### Summary
Write a concise one-line user story: "As a <role>, I want to <action> so that <benefit>."

### Detailed Acceptance Criteria
List each acceptance criterion as a bullet point (- ), specific and testable, referencing exact field names, picklist values, profile names and layout names from the Salesforce metadata.

### Description / Additional Notes
Write 2-4 sentences of additional context. Example: "Consent Given field will have Yes and No as picklist values to select from. For all other profiles, Consent Given field is not displayed on their respective layouts."

## 3. Implementation Steps
Number each step clearly. Reference exact Salesforce Setup paths, field API names, layout names and profile names.
1. Step one
2. Step two

## 4. Testing Checklist
TEST_ROW: Step 1 | <description referencing exact profile/layout/field> | <expected result>
TEST_ROW: Step 2 | <description> | <expected result>
(include at least 5 meaningful test steps)

## 5. Object Details
FIELD: Object Overview
- Object Name: <value>
- API Name: <value>
- Object Type: Standard/Custom
- Purpose: <value>
- Customization Type: New Custom Field Addition

## 6. Field Specifications
For EACH field, use this block format:
FIELD: <Field Label>
- API Name: <value>
- Field Type: <value>
- Picklist Values: <value or N/A>
- Required: Yes/No
- Default Value: <value or None>
- Help Text: <suggested help text>
- Description: <purpose>

## 7. Profile and Permission Settings
For each profile from the metadata, specify:
PROFILE: <Exact Profile Name from metadata>
- Field Access: Read/Write or Read Only or Hidden
- Visibility: Visible/Hidden

## 8. Page Layout Settings
Use the EXACT page layout names from the metadata. For each layout:
LAYOUT: <Exact Layout Name from metadata>
- Action: Add field
- Section: <recommended section>
- Position: <left column / right column>
- Required on Layout: Yes/No

## 9. Validation Rules
List any needed validation rules or state "None required for this implementation."`;

  const claudeRes = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 6000,
    system: `You are a Salesforce design specification expert.

${baseInstruction}

${exportInstruction}

Salesforce Metadata from the connected org:
${metadataContext}`,
    messages: [{ role: 'user', content: message }]
  });

  return claudeRes.content[0].text;
}

app.app.post('/api/chat', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated with Salesforce' });
  const { message } = req.body;
  try {
    // Step 1: Validate metadata for conflicts before generating spec
    const validation = await validateMetadataConflicts(message, req.session.sfAccessToken, req.session.sfInstanceUrl);
    if (validation.hasConflicts) {
      const conflictMsg = validation.conflicts.map(c => c.message).join('\n\n');
      return res.json({
        response: conflictMsg,
        exportIntent: { isWord: false, isExcel: false, isAny: false },
        isConflict: true
      });
    }
    // Step 2: No conflicts - generate the design spec
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

app.post('/api/export/word', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;
  try {
    let specText = content;
    if (!specText) specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl, 'word');
    const docChildren = parseToWordElements(specText, message);
    const doc = new Document({
      numbering: { config: [{ reference: 'default-numbering', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 260 } } } }] }] },
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
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

app.post('/api/export/excel', async (req, res) => {
  if (!req.session.sfAccessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { message, content } = req.body;
  try {
    let specText = content;
    if (!specText) specText = await getDesignSpec(message, req.session.sfAccessToken, req.session.sfInstanceUrl, 'excel');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SF Claude Designer';
    workbook.created = new Date();

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
    const testRowsExcel = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^TEST_ROW:\s*(.+)/.test(trimmed)) {
        const rowContent = trimmed.replace(/^TEST_ROW:\s*/, '');
        const parts = rowContent.split('|').map(p => p.trim());
        testRowsExcel.push({ step: parts[0] || '', description: parts[1] || '', expected: parts[2] || '', actual: '' });
        continue;
      }
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
        cell.value = ' - ' + trimmed.replace(/^[-*]\s*/, '').replace(/\*\*/g, '');
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

    const sheet2 = workbook.addWorksheet('Testing Checklist');
    sheet2.columns = [
      { header: 'Step #', key: 'step', width: 12 },
      { header: 'Step Description', key: 'description', width: 45 },
      { header: 'Expected Result', key: 'expected', width: 40 },
      { header: 'Actual Result', key: 'actual', width: 35 }
    ];
    const hdr2 = sheet2.getRow(1);
    hdr2.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 12 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF032D60' } } };
    });
    hdr2.height = 30;

    let tRowIdx = 2;
    for (const tr of testRowsExcel) {
      const row = sheet2.addRow(tr);
      row.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11 };
        cell.border = { top: { style: 'thin', color: { argb: 'FFE0E5EE' } }, bottom: { style: 'thin', color: { argb: 'FFE0E5EE' } }, left: { style: 'thin', color: { argb: 'FFE0E5EE' } }, right: { style: 'thin', color: { argb: 'FFE0E5EE' } } };
        cell.alignment = { wrapText: true, vertical: 'top' };
        if (tRowIdx % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F8FF' } };
      });
      sheet2.getRow(tRowIdx).height = 40;
      tRowIdx++;
    }
    if (tRowIdx === 2) sheet2.addRow({ step: 'Step 1', description: 'See Design Specification tab', expected: '', actual: '' });

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
