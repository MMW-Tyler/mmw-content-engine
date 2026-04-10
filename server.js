// MMW Content Engine v2 — Server
// Node.js, zero build step. Requires: @supabase/supabase-js, docx

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { createClient } = require('@supabase/supabase-js');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, LevelFormat, BorderStyle, PageBreak
} = require('docx');
const {
  SYSTEM_PROMPT,
  SITEMAP_SYSTEM,
  SITEMAP_USER,
  buildPageBrief,
  PARSE_PROMPT,
  buildRegenerationBrief
} = require('./prompts');

// ─── ENV ──────────────────────────────────────────────────────────────────────

(function () {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line || line[0] === '#') return;
      var i = line.indexOf('=');
      if (i < 1) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    });
  } catch (e) {}
})();

var PORT = process.env.PORT || 3000;
var API_KEY = process.env.ANTHROPIC_API_KEY;
var SUPABASE_URL = process.env.SUPABASE_URL;
var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
var SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!API_KEY) { console.error('\n  ANTHROPIC_API_KEY not found in .env\n'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('\n  SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env\n'); process.exit(1); }

// Service client for server-side ops (bypasses RLS for admin tasks)
var supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var totalSize = 0;
    var MAX_BYTES = 50 * 1024 * 1024; // 50MB — handles large builds
    req.on('data', function (c) {
      chunks.push(c);
      totalSize += c.length;
      if (totalSize > MAX_BYTES) {
        reject(new Error('Request body too large (max 50MB)'));
      }
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function callAnthropic(payload) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify(payload);
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function cleanJSON(raw) {
  return raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
}

function json200(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonErr(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function parseMultipart(body, boundary) {
  var parts = [];
  var boundaryBuf = Buffer.from('--' + boundary);
  var pos = 0;
  while (pos < body.length) {
    var bIdx = body.indexOf(boundaryBuf, pos);
    if (bIdx === -1) break;
    var hStart = bIdx + boundaryBuf.length + 2;
    var hEnd = body.indexOf(Buffer.from('\r\n\r\n'), hStart);
    if (hEnd === -1) break;
    var headers = body.slice(hStart, hEnd).toString('utf8');
    var dStart = hEnd + 4;
    var next = body.indexOf(boundaryBuf, dStart);
    var dEnd = next === -1 ? body.length : next - 2;
    var nm = headers.match(/name="([^"]+)"/);
    var fn = headers.match(/filename="([^"]+)"/);
    var ct = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (nm) parts.push({
      name: nm[1],
      filename: fn ? fn[1] : null,
      contentType: ct ? ct[1].trim() : 'text/plain',
      data: body.slice(dStart, dEnd)
    });
    pos = next === -1 ? body.length : next;
  }
  return parts;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
// Validates Supabase JWT from Authorization header.
// All /api/ routes require a valid session except /api/auth/login.

async function requireAuth(req) {
  var authHeader = req.headers['authorization'] || '';
  var token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    var { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user;
  } catch (e) {
    return null;
  }
}

// ─── SERVER ───────────────────────────────────────────────────────────────────

var server = http.createServer(async function (req, res) {
  var url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve static files from /public ────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      var html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  // Expose anon key to frontend (not secret)
  if (req.method === 'GET' && url === '/api/config') {
    json200(res, { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
    return;
  }

  // ── Auth: Login ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/auth/login') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      var { data, error } = await anonClient.auth.signInWithPassword({
        email: body.email,
        password: body.password
      });
      if (error) return jsonErr(res, 401, error.message);
      json200(res, { token: data.session.access_token, user: data.user.email });
    } catch (e) {
      jsonErr(res, 500, e.message);
    }
    return;
  }

  // ── All routes below require auth ──────────────────────────────────────────
  var user = await requireAuth(req);
  if (!user && url.startsWith('/api/')) {
    return jsonErr(res, 401, 'Unauthorized');
  }

  // ── Projects: List ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/projects') {
    try {
      var { data, error } = await supabaseAdmin
        .from('projects')
        .select('id, client_name, build_type, status, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (error) return jsonErr(res, 500, error.message);
      json200(res, data);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Projects: Get single ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/projects/')) {
    var projectId = url.split('/')[3];
    try {
      var { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single();
      if (error) return jsonErr(res, 404, 'Project not found');
      json200(res, data);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Projects: Create ───────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/projects') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var { data, error } = await supabaseAdmin
        .from('projects')
        .insert({
          client_name: body.clientName,
          build_type: body.buildType || 'new',
          status: 'in_progress',
          created_by: user.email
        })
        .select()
        .single();
      if (error) return jsonErr(res, 500, error.message);
      json200(res, data);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Projects: Update (save parsed data, sitemap, pages) ───────────────────
  if (req.method === 'PUT' && url.startsWith('/api/projects/')) {
    var projectId = url.split('/')[3];
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var updates = { updated_at: new Date().toISOString() };
      if (body.parsedData !== undefined) updates.parsed_data = body.parsedData;
      if (body.masterRecordRaw !== undefined) updates.master_record_raw = body.masterRecordRaw;
      if (body.sitemap !== undefined) updates.sitemap = body.sitemap;
      if (body.pages !== undefined) updates.pages = body.pages;
      if (body.status !== undefined) updates.status = body.status;
      if (body.gapReport !== undefined) updates.gap_report = body.gapReport;

      var { data, error } = await supabaseAdmin
        .from('projects')
        .update(updates)
        .eq('id', projectId)
        .select()
        .single();
      if (error) return jsonErr(res, 500, error.message);
      json200(res, data);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Projects: Delete ───────────────────────────────────────────────────────
  if (req.method === 'DELETE' && url.startsWith('/api/projects/')) {
    var projectId = url.split('/')[3];
    try {
      var { error } = await supabaseAdmin
        .from('projects')
        .delete()
        .eq('id', projectId);
      if (error) return jsonErr(res, 500, error.message);
      json200(res, { deleted: true });
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Parse master record (markdown upload) ──────────────────────────────────
  if (req.method === 'POST' && url === '/api/parse') {
    try {
      var rawBody = await readBody(req);
      var ct = req.headers['content-type'] || '';

      var markdownText = '';

      if (ct.includes('multipart/form-data')) {
        var boundary = ct.split('boundary=')[1];
        if (!boundary) return jsonErr(res, 400, 'Missing boundary');
        var parts = parseMultipart(rawBody, boundary);
        parts.forEach(function (part) {
          if (!part.filename) return;
          var fn = part.filename.toLowerCase();
          if (fn.endsWith('.md') || fn.endsWith('.txt')) {
            markdownText += part.data.toString('utf8') + '\n';
          }
        });
      } else {
        // Plain text/markdown body
        markdownText = rawBody.toString('utf8');
      }

      if (!markdownText.trim()) return jsonErr(res, 400, 'No readable content found');

      var result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: PARSE_PROMPT + '\n\n---\n\n' + markdownText
        }]
      });

      if (result.status !== 200) return jsonErr(res, result.status, result.body.error?.message || 'API error');

      var parsed = JSON.parse(cleanJSON(result.body.content[0].text));
      json200(res, { parsed, raw: markdownText });
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Generate sitemap ───────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/sitemap') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var clientData = body.clientData;

      var result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SITEMAP_SYSTEM,
        messages: [{ role: 'user', content: SITEMAP_USER(clientData, body.pageCount, body.feedback) }]
      });

      if (result.status !== 200) return jsonErr(res, result.status, result.body.error?.message || 'API error');

      var sitemap = JSON.parse(cleanJSON(result.body.content[0].text));
      json200(res, sitemap);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Generate single page ───────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/generate') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var { page, clientData, sitemapPages } = body;

      var result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPageBrief(page, clientData, sitemapPages) }]
      });

      if (result.status !== 200) return jsonErr(res, result.status, result.body.error?.message || 'API error');

      var pageData = JSON.parse(cleanJSON(result.body.content[0].text));
      json200(res, pageData);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Regenerate single section ──────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/regenerate-section') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var { section, feedback, pageContext, clientData } = body;

      var result = await callAnthropic({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildRegenerationBrief(section, feedback, pageContext, clientData) }]
      });

      if (result.status !== 200) return jsonErr(res, result.status, result.body.error?.message || 'API error');

      var newSection = JSON.parse(cleanJSON(result.body.content[0].text));
      json200(res, newSection);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Export single page as .docx ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/export/page') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var buffer = await buildPageDocx(body.page, body.clientName);
      var filename = (body.page.pageName || 'page').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_') + '.docx';
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Content-Length': buffer.length
      });
      res.end(buffer);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Export full package as .docx ──────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/export/package') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var buffer = await buildPackageDocx(body.pages, body.clientName, body.sitemap);
      var filename = (body.clientName || 'client').replace(/\s+/g, '_') + '_full_package.docx';
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Content-Length': buffer.length
      });
      res.end(buffer);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  // ── Export sitemap as client-facing proposal .docx ────────────────────────
  if (req.method === 'POST' && url === '/api/export/sitemap') {
    try {
      var body = JSON.parse((await readBody(req)).toString());
      var buffer = await buildSitemapDocx(body.sitemap, body.clientName, body.clientLocation);
      var filename = (body.clientName || 'client').replace(/\s+/g, '_') + '_Sitemap_Proposal.docx';
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Content-Length': buffer.length
      });
      res.end(buffer);
    } catch (e) { jsonErr(res, 500, e.message); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── DOCX BUILDER ─────────────────────────────────────────────────────────────
// Color palette (hex, no #)
var C = {
  navy:      '1a3a5c',   // page title bar
  blue:      '1a5ca8',   // section headers, links
  blueLight: 'dbeafe',   // section header background
  bluePale:  'f0f6ff',   // meta info background
  green:     '166534',   // ready/done text
  greenLight:'dcfce7',   // AEO block background
  purple:    '5b21b6',   // layout pattern badge text
  purpleLight:'ede9fe',  // layout pattern badge background
  amber:     'b45309',   // gap flag / warning text
  amberLight:'fef3c7',   // gap flag background
  red:       '991b1b',   // blocker text
  redLight:  'fee2e2',   // blocker background
  teal:      '0f6e56',   // FAQ header text
  tealLight: 'ccfbf1',   // FAQ background
  gray:      '374151',   // body text
  grayMid:   '6b7280',   // secondary text
  grayLight: 'f9fafb',   // alt row background
  border:    'e5e7eb',   // divider lines
  white:     'ffffff'
};

function sp() { return new Paragraph({ children: [new TextRun('')], spacing: { before: 0, after: 80 } }); }

function shaded(fill) {
  return { val: 'clear', color: 'auto', fill: fill };
}

function borderedPara(text, opts) {
  opts = opts || {};
  return new Paragraph({
    shading: shaded(opts.fill || C.bluePale),
    border: opts.border || {},
    indent: { left: opts.indent || 160, right: 160 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({
      text: String(text || ''),
      font: 'Arial',
      size: opts.size || 22,
      bold: opts.bold || false,
      italics: opts.italics || false,
      color: opts.color || C.gray
    })]
  });
}

// Page title banner — dark blue bar with white text
function makePageBanner(pageName, clientName) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    shading: shaded(C.navy),
    spacing: { before: 0, after: 0 },
    indent: { left: 200, right: 200 },
    children: [
      new TextRun({ text: (pageName || 'Page').toUpperCase(), font: 'Arial', size: 28, bold: true, color: C.white }),
      new TextRun({ text: '  |  ' + (clientName || ''), font: 'Arial', size: 22, color: 'b0c4de' })
    ]
  });
}

// Section category banner (blue bar for Layout, green for AEO, etc.)
function makeSectionBanner(label, fill, textColor) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    shading: shaded(fill || C.blueLight),
    spacing: { before: 240, after: 0 },
    indent: { left: 0, right: 0 },
    children: [new TextRun({
      text: '  ' + (label || '').toUpperCase(),
      font: 'Arial',
      size: 22,
      bold: true,
      color: textColor || C.blue
    })]
  });
}

// Meta info row (label: value in shaded box)
function makeMetaRow(label, value) {
  return new Paragraph({
    shading: shaded(C.bluePale),
    spacing: { before: 20, after: 20 },
    indent: { left: 160, right: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 } },
    children: [
      new TextRun({ text: label + ':  ', font: 'Arial', size: 20, bold: true, color: C.grayMid }),
      new TextRun({ text: String(value || '—'), font: 'Arial', size: 20, color: C.gray })
    ]
  });
}

// Section header row with number badge + name + pattern pill
function makeSectionHeader(order, sectionName, pattern) {
  var patternColors = {
    hero: { fill: 'dbeafe', text: '1e40af' },
    intro_text: { fill: 'dcfce7', text: '166534' },
    service_cards: { fill: 'ede9fe', text: '5b21b6' },
    icon_grid: { fill: 'fef9c3', text: '854d0e' },
    three_col_highlights: { fill: 'ccfbf1', text: '134e4a' },
    two_col_text: { fill: 'fce7f3', text: '831843' },
    location_info: { fill: 'f1f5f9', text: '334155' },
    testimonials: { fill: 'ffedd5', text: '7c2d12' },
    booking_cta: { fill: 'dbeafe', text: '1e40af' },
    compliance_footer: { fill: 'fee2e2', text: '991b1b' },
    team_bio: { fill: 'ede9fe', text: '5b21b6' },
    faq_accordion: { fill: 'ccfbf1', text: '134e4a' },
    feature_list: { fill: 'fef9c3', text: '854d0e' }
  };
  var pc = patternColors[pattern] || { fill: 'f3f4f6', text: '374151' };
  return new Paragraph({
    shading: shaded('f8fafc'),
    spacing: { before: 200, after: 60 },
    indent: { left: 0, right: 0 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 18, color: C.blue, space: 0 },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 }
    },
    children: [
      new TextRun({ text: '  ' + (order || '') + '  ', font: 'Arial', size: 20, bold: true, color: C.blue }),
      new TextRun({ text: (sectionName || '') + '   ', font: 'Arial', size: 24, bold: true, color: C.navy }),
      new TextRun({ text: ' ' + (pattern || '') + ' ', font: 'Arial', size: 18, bold: true, color: pc.text })
    ]
  });
}

function makeH2(text) {
  return new Paragraph({
    spacing: { before: 80, after: 60 },
    indent: { left: 160 },
    children: [new TextRun({ text: String(text || ''), font: 'Arial', size: 28, bold: true, color: C.navy })]
  });
}

function makeH3(text) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    indent: { left: 160 },
    children: [new TextRun({ text: String(text || ''), font: 'Arial', size: 24, bold: false, italics: true, color: C.grayMid })]
  });
}

function makeBodyText(text) {
  return new Paragraph({
    spacing: { before: 40, after: 60 },
    indent: { left: 160, right: 160 },
    children: [new TextRun({ text: String(text || ''), font: 'Arial', size: 22, color: C.gray })]
  });
}

function makeItemRow(heading, body) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    indent: { left: 240, right: 160 },
    border: { left: { style: BorderStyle.SINGLE, size: 10, color: C.border, space: 0 } },
    children: [
      new TextRun({ text: '  ' + (heading || '') + ':  ', font: 'Arial', size: 22, bold: true, color: C.navy }),
      new TextRun({ text: String(body || ''), font: 'Arial', size: 22, color: C.gray })
    ]
  });
}

function makeCTARow(label, dest) {
  return new Paragraph({
    shading: shaded(C.blueLight),
    spacing: { before: 80, after: 80 },
    indent: { left: 160, right: 160 },
    children: [
      new TextRun({ text: 'BUTTON: ', font: 'Arial', size: 20, bold: true, color: C.blue }),
      new TextRun({ text: (label || '') + '  ', font: 'Arial', size: 20, bold: true, color: C.blue }),
      new TextRun({ text: dest ? ('-> ' + dest) : '', font: 'Arial', size: 18, color: C.grayMid })
    ]
  });
}

function makeBuildNote(text) {
  return new Paragraph({
    shading: shaded('fffbeb'),
    spacing: { before: 40, after: 40 },
    indent: { left: 160, right: 160 },
    border: { left: { style: BorderStyle.SINGLE, size: 10, color: 'fbbf24', space: 0 } },
    children: [
      new TextRun({ text: '  BUILD NOTE: ', font: 'Arial', size: 18, bold: true, color: C.amber }),
      new TextRun({ text: String(text || ''), font: 'Arial', size: 18, italics: true, color: C.amber })
    ]
  });
}

function makeAEOBlock(question, answer, placedIn) {
  return [
    new Paragraph({
      shading: shaded(C.greenLight),
      spacing: { before: 140, after: 0 },
      indent: { left: 0 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.green, space: 0 } },
      children: [
        new TextRun({ text: '  Q: ', font: 'Arial', size: 20, bold: true, color: C.green }),
        new TextRun({ text: String(question || ''), font: 'Arial', size: 20, bold: true, color: C.green })
      ]
    }),
    new Paragraph({
      shading: shaded(C.greenLight),
      spacing: { before: 0, after: 0 },
      indent: { left: 160 },
      children: [new TextRun({ text: 'Place in: ' + (placedIn || ''), font: 'Arial', size: 18, italics: true, color: C.teal })]
    }),
    new Paragraph({
      shading: shaded('f0fdf4'),
      spacing: { before: 0, after: 80 },
      indent: { left: 160, right: 160 },
      children: [new TextRun({ text: String(answer || ''), font: 'Arial', size: 22, color: C.gray })]
    })
  ];
}

function makeFAQItem(q, a) {
  return [
    new Paragraph({
      shading: shaded(C.tealLight),
      spacing: { before: 120, after: 0 },
      indent: { left: 0 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.teal, space: 0 } },
      children: [new TextRun({ text: '  Q: ' + (q || ''), font: 'Arial', size: 22, bold: true, color: C.teal })]
    }),
    new Paragraph({
      shading: shaded('f0fdfa'),
      spacing: { before: 0, after: 60 },
      indent: { left: 160, right: 160 },
      children: [new TextRun({ text: 'A: ' + (a || ''), font: 'Arial', size: 22, color: C.gray })]
    })
  ];
}

function makeGapFlag(section, missing, requestLang, blocksPublish) {
  var fill = blocksPublish ? C.redLight : C.amberLight;
  var accent = blocksPublish ? C.red : C.amber;
  return [
    new Paragraph({
      shading: shaded(fill),
      spacing: { before: 120, after: 0 },
      indent: { left: 0 },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 0 } },
      children: [
        new TextRun({ text: '  ' + (section || '') + (blocksPublish ? '  BLOCKS PUBLISHING' : ''), font: 'Arial', size: 22, bold: true, color: accent })
      ]
    }),
    new Paragraph({
      shading: shaded(fill),
      spacing: { before: 0, after: 80 },
      indent: { left: 160, right: 160 },
      children: [new TextRun({ text: 'Missing: ' + (missing || ''), font: 'Arial', size: 21, color: accent })]
    })
  ];
}

function makeDocStyles() {
  return {
    default: { document: { run: { font: 'Arial', size: 22, color: C.gray } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: C.white },
        paragraph: { spacing: { before: 0, after: 0 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 20, bold: true, font: 'Arial', color: C.blue },
        paragraph: { spacing: { before: 240, after: 0 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 22, bold: true, font: 'Arial', color: C.navy },
        paragraph: { spacing: { before: 200, after: 60 }, outlineLevel: 2 } }
    ]
  };
}

function makePageProps() {
  return {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
    }
  };
}

function buildPageChildren(pageData, clientName) {
  var children = [];
  var c = pageData;

  // ── Page banner ──────────────────────────────────────────────────────────────
  children.push(makePageBanner(c.pageName, clientName));
  children.push(sp());

  // ── SEO metadata block ───────────────────────────────────────────────────────
  children.push(makeSectionBanner('Page Details & SEO', C.bluePale, C.blue));
  children.push(makeMetaRow('URL', c.url));
  children.push(makeMetaRow('Page title', c.pageTitle));
  children.push(makeMetaRow('Meta description', c.metaDescription));
  children.push(makeMetaRow('H1', c.h1));
  children.push(makeMetaRow('Schema type', c.schemaType));
  children.push(makeMetaRow('Tone', c.toneModifier));
  children.push(sp());

  // ── Layout and Copy ──────────────────────────────────────────────────────────
  children.push(makeSectionBanner('Layout and Copy', C.blueLight, C.blue));
  children.push(new Paragraph({
    spacing: { before: 40, after: 80 },
    indent: { left: 160 },
    children: [new TextRun({ text: 'Sections are listed in the recommended order for the page. Share with your web team as the build blueprint.', font: 'Arial', size: 20, italics: true, color: C.grayMid })]
  }));

  (c.layout || []).forEach(function (s) {
    children.push(makeSectionHeader(s.order, s.sectionName, s.pattern));
    if (s.headline) children.push(makeH2(s.headline));
    if (s.subheadline) children.push(makeH3(s.subheadline));
    if (s.body) {
      s.body.split('\n').filter(Boolean).forEach(function (line) {
        children.push(makeBodyText(line));
      });
    }
    if (s.items && s.items.length) {
      s.items.forEach(function (item) {
        children.push(makeItemRow(item.heading, item.body));
      });
    }
    if (s.cta) children.push(makeCTARow(s.cta.label, s.cta.destination));
    if (s.notes) children.push(makeBuildNote(s.notes));
  });
  children.push(sp());

  // ── AEO Blocks ───────────────────────────────────────────────────────────────
  if (c.aeoBlocks && c.aeoBlocks.length) {
    children.push(makeSectionBanner('AEO Content Blocks', C.greenLight, C.green));
    children.push(new Paragraph({
      spacing: { before: 40, after: 80 },
      indent: { left: 160 },
      children: [new TextRun({ text: 'These passages are written to be picked up by AI search engines (Google AI Overviews, ChatGPT, Perplexity). Embed them into the relevant page sections as flowing prose — do not format as Q&A.', font: 'Arial', size: 20, italics: true, color: C.grayMid })]
    }));
    c.aeoBlocks.forEach(function (b) {
      makeAEOBlock(b.question, b.answer, b.placedInSection).forEach(function(p) { children.push(p); });
    });
    children.push(sp());
  }

  // ── FAQ Schema ───────────────────────────────────────────────────────────────
  if (c.faqSchema && c.faqSchema.length) {
    children.push(makeSectionBanner('FAQ Section', C.tealLight, C.teal));
    children.push(new Paragraph({
      spacing: { before: 40, after: 80 },
      indent: { left: 160 },
      children: [new TextRun({ text: 'These Q&As appear as a visible FAQ accordion on the page and are also embedded as structured data (JSON-LD) to help your site appear in Google\'s FAQ rich results.', font: 'Arial', size: 20, italics: true, color: C.grayMid })]
    }));
    c.faqSchema.forEach(function (f) {
      makeFAQItem(f.q, f.a).forEach(function(p) { children.push(p); });
    });
    children.push(sp());
  }

  // ── SEO Notes ────────────────────────────────────────────────────────────────
  if (c.focusKeyword || (c.supportingKeywords && c.supportingKeywords.length)) {
    children.push(makeSectionBanner('Target Keywords', C.blueLight, C.blue));
    children.push(new Paragraph({
      shading: shaded(C.bluePale),
      spacing: { before: 0, after: 0 },
      indent: { left: 160, right: 160 },
      children: [
        new TextRun({ text: 'RankMath focus keyword:  ', font: 'Arial', size: 20, bold: true, color: C.blue }),
        new TextRun({ text: c.focusKeyword || '—', font: 'Arial', size: 22, bold: true, color: C.navy })
      ]
    }));
    if (c.supportingKeywords && c.supportingKeywords.length) {
      children.push(new Paragraph({
        shading: shaded(C.bluePale),
        spacing: { before: 0, after: 80 },
        indent: { left: 160, right: 160 },
        children: [
          new TextRun({ text: 'Supporting keywords:  ', font: 'Arial', size: 20, bold: true, color: C.blue }),
          new TextRun({ text: c.supportingKeywords.join('  |  '), font: 'Arial', size: 20, color: C.gray })
        ]
      }));
    }
    children.push(sp());
  }
  if (c.seoNotes) {
    children.push(makeSectionBanner('SEO Notes', C.bluePale, C.blue));
    children.push(makeBodyText(c.seoNotes));
    children.push(sp());
  }

  // ── Gap Flags ────────────────────────────────────────────────────────────────
  if (c.gapFlags && c.gapFlags.length) {
    children.push(makeSectionBanner('Information Gaps', C.amberLight, C.amber));
    children.push(new Paragraph({
      spacing: { before: 40, after: 80 },
      indent: { left: 160 },
      children: [new TextRun({ text: 'The following information was missing from the client\'s intake form. Items marked BLOCKS PUBLISHING need to be resolved before the page can go live.', font: 'Arial', size: 20, italics: true, color: C.grayMid })]
    }));
    c.gapFlags.forEach(function (g) {
      makeGapFlag(g.section, g.missing, g.requestLanguage, g.blocksPublish).forEach(function(p) { children.push(p); });
    });
    children.push(sp());
  }

  return children;
}

async function buildPageDocx(pageData, clientName) {
  var doc = new Document({
    styles: makeDocStyles(),
    sections: [{ properties: makePageProps(), children: buildPageChildren(pageData, clientName) }]
  });
  return await Packer.toBuffer(doc);
}

async function buildPackageDocx(pages, clientName, sitemap) {
  var allChildren = [];

  // ── Cover page ───────────────────────────────────────────────────────────────
  allChildren.push(new Paragraph({
    shading: shaded(C.navy),
    spacing: { before: 0, after: 0 },
    children: [new TextRun({ text: '  WEBSITE CONTENT PACKAGE', font: 'Arial', size: 36, bold: true, color: C.white })]
  }));
  allChildren.push(new Paragraph({
    shading: shaded(C.navy),
    spacing: { before: 0, after: 0 },
    indent: { left: 160 },
    children: [new TextRun({ text: clientName || '', font: 'Arial', size: 28, color: 'b0c4de' })]
  }));
  allChildren.push(new Paragraph({
    shading: shaded(C.navy),
    spacing: { before: 0, after: 200 },
    indent: { left: 160 },
    children: [new TextRun({ text: 'Generated ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), font: 'Arial', size: 20, color: '6b8cae' })]
  }));
  allChildren.push(sp());

  // Cover stats
  var readyCount = (pages || []).filter(function(p) { return p.generated; }).length;
  var gapCount = 0;
  (pages || []).forEach(function(p) { if (p.generated) gapCount += (p.generated.gapFlags || []).length; });
  allChildren.push(makeMetaRow('Total pages', readyCount + ''));
  allChildren.push(makeMetaRow('Information gaps', gapCount + (gapCount === 0 ? ' (none — ready to build)' : ' (see gap report at end)')));
  allChildren.push(makeMetaRow('Prepared by', 'Medical Marketing Whiz'));
  allChildren.push(sp());

  // ── Sitemap summary ──────────────────────────────────────────────────────────
  if (sitemap && sitemap.pages) {
    allChildren.push(makeSectionBanner('Page List', C.blueLight, C.blue));
    sitemap.pages.forEach(function (p) {
      allChildren.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 } },
        children: [
          new TextRun({ text: p.number + '.  ', font: 'Arial', size: 20, bold: true, color: C.blue }),
          new TextRun({ text: p.name + '  ', font: 'Arial', size: 22, bold: true, color: C.navy }),
          new TextRun({ text: p.url, font: 'Arial', size: 20, color: C.grayMid })
        ]
      }));
    });
    allChildren.push(sp());
  }

  // ── Each page ────────────────────────────────────────────────────────────────
  (pages || []).forEach(function (p) {
    if (!p.generated) return;
    allChildren.push(new Paragraph({ children: [new PageBreak()] }));
    buildPageChildren(p.generated, clientName).forEach(function (child) { allChildren.push(child); });
  });

  // ── Consolidated gap report ───────────────────────────────────────────────────
  var allGaps = [];
  (pages || []).forEach(function (p) {
    if (!p.generated) return;
    (p.generated.gapFlags || []).forEach(function (g) { allGaps.push(Object.assign({ page: p.name }, g)); });
  });

  if (allGaps.length) {
    allChildren.push(new Paragraph({ children: [new PageBreak()] }));
    allChildren.push(new Paragraph({
      shading: shaded(C.amber),
      children: [new TextRun({ text: '  INFORMATION GAPS — CONSOLIDATED REPORT', font: 'Arial', size: 28, bold: true, color: C.white })]
    }));
    allChildren.push(new Paragraph({
      shading: shaded(C.amberLight),
      spacing: { before: 0, after: 120 },
      indent: { left: 160 },
      children: [new TextRun({ text: 'The items below were missing from the intake information. Please gather these from your client before the site launches. Items marked BLOCKS PUBLISHING must be resolved before that page can go live.', font: 'Arial', size: 21, italics: true, color: C.amber })]
    }));
    allGaps.forEach(function (g) {
      allChildren.push(new Paragraph({
        spacing: { before: 80, after: 20 },
        indent: { left: 160 },
        children: [new TextRun({ text: 'PAGE: ' + (g.page || ''), font: 'Arial', size: 20, bold: true, color: C.grayMid })]
      }));
      makeGapFlag(g.section, g.missing, g.requestLanguage, g.blocksPublish).forEach(function(p) { allChildren.push(p); });
    });
  }

  var doc = new Document({
    styles: makeDocStyles(),
    sections: [{ properties: makePageProps(), children: allChildren }]
  });
  return await Packer.toBuffer(doc);
}

// ─── SITEMAP PROPOSAL DOCX ────────────────────────────────────────────────────

async function buildSitemapDocx(sitemap, clientName, clientLocation) {
  var pages = sitemap.pages || [];
  var addlPages = sitemap.additionalPages || [];
  var today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Type colors
  var typeColors = {
    core:    { fill: 'dbeafe', text: '1e40af', label: 'Core Page' },
    service: { fill: 'ede9fe', text: '5b21b6', label: 'Service Page' },
    support: { fill: 'f1f5f9', text: '334155', label: 'Support Page' }
  };
  var valueColors = {
    high:   { fill: 'dcfce7', text: '166534', label: 'High Priority' },
    medium: { fill: 'fef9c3', text: '854d0e', label: 'Medium Priority' },
    low:    { fill: 'f1f5f9', text: '334155', label: 'Lower Priority' }
  };

  function badge(label, fill, textColor) {
    return new TextRun({ text: ' ' + label + ' ', font: 'Arial', size: 18, bold: true, color: textColor });
  }

  function sp(pts) {
    return new Paragraph({ children: [new TextRun('')], spacing: { before: 0, after: pts || 80 } });
  }

  function coverLine(text, size, color, bold) {
    return new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: C.navy },
      spacing: { before: 0, after: 0 },
      indent: { left: 360 },
      children: [new TextRun({ text: text, font: 'Arial', size: size || 24, color: color || C.white, bold: bold || false })]
    });
  }

  function sectionHeader(text, fill, textColor) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      shading: { val: 'clear', color: 'auto', fill: fill || C.navy },
      spacing: { before: 320, after: 0 },
      children: [new TextRun({ text: '  ' + text, font: 'Arial', size: 26, bold: true, color: textColor || C.white })]
    });
  }

  function pageCard(p) {
    var tc = typeColors[p.type] || typeColors.support;
    var children = [];

    // Card header row — number + name + type badge
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      shading: { val: 'clear', color: 'auto', fill: 'f8fafc' },
      spacing: { before: 200, after: 0 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: C.blue, space: 0 },
        top: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 }
      },
      indent: { left: 0 },
      children: [
        new TextRun({ text: '  ' + (p.number || '') + '.  ', font: 'Arial', size: 26, bold: true, color: C.blue }),
        new TextRun({ text: (p.name || ''), font: 'Arial', size: 26, bold: true, color: C.navy }),
        new TextRun({ text: '    ' }),
        badge(tc.label, tc.fill, tc.text)
      ]
    }));

    // URL row
    children.push(new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: 'f8fafc' },
      spacing: { before: 0, after: 0 },
      indent: { left: 240 },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: C.blue, space: 0 } },
      children: [new TextRun({ text: '  ' + (p.url || ''), font: 'Courier New', size: 18, color: C.grayMid })]
    }));

    // Rationale
    children.push(new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: C.bluePale },
      spacing: { before: 0, after: 100 },
      indent: { left: 240, right: 240 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: C.blue, space: 0 },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 }
      },
      children: [new TextRun({ text: '  ' + (p.rationale || 'No rationale provided.'), font: 'Arial', size: 21, color: C.gray })]
    }));

    return children;
  }

  function addlPageCard(p) {
    var vc = valueColors[p.value] || valueColors.low;
    var children = [];

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      shading: { val: 'clear', color: 'auto', fill: 'f8fafc' },
      spacing: { before: 200, after: 0 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: C.grayMid, space: 0 },
        top: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 }
      },
      indent: { left: 0 },
      children: [
        new TextRun({ text: '  ' + (p.name || ''), font: 'Arial', size: 24, bold: true, color: C.navy }),
        new TextRun({ text: '    ' }),
        badge(vc.label, vc.fill, vc.text)
      ]
    }));

    children.push(new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: 'f8fafc' },
      spacing: { before: 0, after: 0 },
      indent: { left: 240 },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: C.grayMid, space: 0 } },
      children: [new TextRun({ text: '  ' + (p.url || ''), font: 'Courier New', size: 18, color: C.grayMid })]
    }));

    children.push(new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: C.grayLight },
      spacing: { before: 0, after: 100 },
      indent: { left: 240, right: 240 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: C.grayMid, space: 0 },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border, space: 0 }
      },
      children: [new TextRun({ text: '  ' + (p.rationale || ''), font: 'Arial', size: 21, color: C.gray })]
    }));

    return children;
  }

  var children = [];

  // ── Cover ──────────────────────────────────────────────────────────────────
  children.push(coverLine('', 10));
  children.push(coverLine('WEBSITE SITEMAP PROPOSAL', 36, C.white, true));
  children.push(coverLine('', 10));
  children.push(coverLine(clientName || '', 28, 'b0c4de', false));
  children.push(coverLine(clientLocation || '', 22, '6b8cae', false));
  children.push(coverLine('', 10));
  children.push(coverLine('Prepared by Medical Marketing Whiz', 20, '4a6a8a', false));
  children.push(coverLine(today, 20, '4a6a8a', false));
  children.push(coverLine('', 10));
  children.push(sp(200));

  // ── Introduction ──────────────────────────────────────────────────────────
  children.push(sectionHeader('About This Proposal', C.navy, C.white));
  children.push(new Paragraph({
    spacing: { before: 120, after: 80 },
    indent: { left: 200, right: 200 },
    children: [new TextRun({ text: 'Your website sitemap is the foundation of your online presence. It determines which pages exist on your site, how patients navigate to find the care they need, and how search engines understand what your practice offers and where you are located.', font: 'Arial', size: 22, color: C.gray })]
  }));
  children.push(new Paragraph({
    spacing: { before: 0, after: 80 },
    indent: { left: 200, right: 200 },
    children: [new TextRun({ text: 'Every page in this proposal has been selected based on your practice\'s marketing priorities, the services that drive the most revenue, and the search terms your ideal patients are using to find providers like you in your area. The rationale beneath each page explains why it was included and what role it plays in your overall digital strategy.', font: 'Arial', size: 22, color: C.gray })]
  }));
  children.push(new Paragraph({
    shading: { val: 'clear', color: 'auto', fill: C.bluePale },
    spacing: { before: 80, after: 120 },
    indent: { left: 200, right: 200 },
    children: [new TextRun({ text: 'This proposal includes ' + pages.length + ' core pages for your standard build' + (addlPages.length ? ', plus ' + addlPages.length + ' recommended expansion pages to consider as your site grows.' : '.'), font: 'Arial', size: 22, bold: false, color: C.blue })]
  }));
  children.push(sp());

  // ── Core pages ────────────────────────────────────────────────────────────
  children.push(sectionHeader('Your ' + pages.length + '-Page Website', C.blue, C.white));
  children.push(new Paragraph({
    spacing: { before: 80, after: 120 },
    indent: { left: 200, right: 200 },
    children: [new TextRun({ text: 'These are the pages included in your website build. Each one has been chosen to support your local search visibility, communicate your services clearly to prospective patients, and guide visitors toward booking an appointment.', font: 'Arial', size: 22, color: C.gray })]
  }));

  pages.forEach(function(p) {
    pageCard(p).forEach(function(para) { children.push(para); });
  });
  children.push(sp(200));

  // ── Additional pages ──────────────────────────────────────────────────────
  if (addlPages.length) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(sectionHeader('Recommended Growth Pages', '166534', C.white));
    children.push(new Paragraph({
      spacing: { before: 80, after: 80 },
      indent: { left: 200, right: 200 },
      children: [new TextRun({ text: 'The pages below are not included in your base build but are strong candidates for future expansion. Adding these pages over time increases your site\'s search visibility, captures additional patient traffic, and positions your practice as the clear authority in your specialty and service area.', font: 'Arial', size: 22, color: C.gray })]
    }));
    children.push(new Paragraph({
      shading: { val: 'clear', color: 'auto', fill: C.greenLight },
      spacing: { before: 0, after: 120 },
      indent: { left: 200, right: 200 },
      children: [new TextRun({ text: 'Priority ratings reflect the estimated impact on patient acquisition and search visibility relative to implementation effort.', font: 'Arial', size: 20, italics: true, color: C.green })]
    }));

    addlPages.forEach(function(p) {
      addlPageCard(p).forEach(function(para) { children.push(para); });
    });
    children.push(sp(200));
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  children.push(new Paragraph({
    shading: { val: 'clear', color: 'auto', fill: C.navy },
    spacing: { before: 320, after: 0 },
    indent: { left: 200 },
    children: [new TextRun({ text: 'Medical Marketing Whiz  |  Website Sitemap Proposal  |  ' + today, font: 'Arial', size: 18, color: '6b8cae' })]
  }));

  var doc = new Document({
    styles: makeDocStyles(),
    sections: [{ properties: makePageProps(), children: children }]
  });
  return await Packer.toBuffer(doc);
}

server.listen(PORT, function () {
  console.log('\n  MMW Content Engine v2');
  console.log('  http://localhost:' + PORT + '\n');
});
