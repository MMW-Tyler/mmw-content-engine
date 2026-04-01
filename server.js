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
    req.on('data', function (c) { chunks.push(c); });
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
      var filename = (body.clientName || 'page').replace(/\s+/g, '_') + '_' + (body.page.pageName || 'page').replace(/\s+/g, '_') + '.docx';
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

  res.writeHead(404); res.end('Not found');
});

// ─── DOCX BUILDER ─────────────────────────────────────────────────────────────

function makeHeading(text, level) {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text: String(text || ''), bold: true })]
  });
}

function makeBody(text) {
  return new Paragraph({
    children: [new TextRun({ text: String(text || ''), size: 24 })]
  });
}

function makeMeta(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label + ': ', bold: true, size: 22 }),
      new TextRun({ text: String(value || '—'), size: 22 })
    ]
  });
}

function makeRule() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
    children: [new TextRun('')]
  });
}

function makeSpacer() {
  return new Paragraph({ children: [new TextRun('')] });
}

function buildPageChildren(pageData, clientName) {
  var children = [];
  var c = pageData;

  // Page header
  children.push(makeHeading((c.pageName || 'Page') + ' — ' + (clientName || ''), HeadingLevel.HEADING_1));
  children.push(makeSpacer());
  children.push(makeMeta('URL', c.url));
  children.push(makeMeta('Page title', c.pageTitle));
  children.push(makeMeta('Meta description', c.metaDescription));
  children.push(makeMeta('H1', c.h1));
  children.push(makeMeta('Schema type', c.schemaType));
  children.push(makeMeta('Tone', c.toneModifier));
  children.push(makeRule());
  children.push(makeSpacer());

  // Layout sections
  children.push(makeHeading('Layout and Copy', HeadingLevel.HEADING_2));
  children.push(makeSpacer());

  (c.layout || []).forEach(function (s) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: '[' + s.order + '] ' + (s.sectionName || '') + ' ', bold: true, size: 24 }),
        new TextRun({ text: '(' + (s.pattern || '') + ')', size: 22, color: '666666' })
      ]
    }));
    if (s.headline) children.push(new Paragraph({
      children: [new TextRun({ text: 'H2: ' + s.headline, bold: true, size: 26 })]
    }));
    if (s.subheadline) children.push(new Paragraph({
      children: [new TextRun({ text: 'H3: ' + s.subheadline, italics: true, size: 24 })]
    }));
    if (s.body) {
      s.body.split('\n').filter(Boolean).forEach(function (line) {
        children.push(makeBody(line));
      });
    }
    if (s.items && s.items.length) {
      s.items.forEach(function (item) {
        children.push(new Paragraph({
          children: [new TextRun({ text: (item.heading || '') + ': ', bold: true, size: 24 }),
                     new TextRun({ text: item.body || '', size: 24 })]
        }));
      });
    }
    if (s.cta) children.push(new Paragraph({
      children: [new TextRun({ text: 'CTA: ' + (s.cta.label || '') + ' → ' + (s.cta.destination || ''), size: 22, color: '1a5ca8' })]
    }));
    if (s.notes) children.push(new Paragraph({
      children: [new TextRun({ text: 'Build note: ' + s.notes, size: 20, italics: true, color: '888888' })]
    }));
    children.push(makeSpacer());
  });

  // AEO blocks
  if (c.aeoBlocks && c.aeoBlocks.length) {
    children.push(makeRule());
    children.push(makeSpacer());
    children.push(makeHeading('AEO Blocks', HeadingLevel.HEADING_2));
    children.push(makeBody('These prose passages get embedded into the sections noted. Written for AI answer engines — do not format as Q&A on the page.'));
    children.push(makeSpacer());
    c.aeoBlocks.forEach(function (b) {
      children.push(new Paragraph({
        children: [new TextRun({ text: b.question || '', bold: true, size: 24 })]
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Place in: ' + (b.placedInSection || ''), size: 20, italics: true, color: '888888' })]
      }));
      children.push(makeBody(b.answer || ''));
      children.push(makeSpacer());
    });
  }

  // FAQ schema
  if (c.faqSchema && c.faqSchema.length) {
    children.push(makeRule());
    children.push(makeSpacer());
    children.push(makeHeading('FAQ Schema', HeadingLevel.HEADING_2));
    children.push(makeBody('Visible FAQ accordion on page + JSON-LD structured data for Google rich results.'));
    children.push(makeSpacer());
    c.faqSchema.forEach(function (f) {
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Q: ' + (f.q || ''), bold: true, size: 24 })]
      }));
      children.push(makeBody('A: ' + (f.a || '')));
      children.push(makeSpacer());
    });
  }

  // SEO notes
  if (c.seoNotes) {
    children.push(makeRule());
    children.push(makeSpacer());
    children.push(makeHeading('SEO Notes', HeadingLevel.HEADING_2));
    children.push(makeBody(c.seoNotes));
    children.push(makeSpacer());
  }

  // Gap flags
  if (c.gapFlags && c.gapFlags.length) {
    children.push(makeRule());
    children.push(makeSpacer());
    children.push(makeHeading('Gap Flags', HeadingLevel.HEADING_2));
    c.gapFlags.forEach(function (g) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: '[' + (g.section || '') + ']' + (g.blocksPublish ? ' — BLOCKS PUBLISH' : ''), bold: true, size: 24, color: g.blocksPublish ? 'cc0000' : 'b45309' })
        ]
      }));
      children.push(makeBody('Missing: ' + (g.missing || '')));
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Ask: "' + (g.requestLanguage || '') + '"', italics: true, size: 22 })]
      }));
      children.push(makeSpacer());
    });
  }

  return children;
}

async function buildPageDocx(pageData, clientName) {
  var doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 24 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 36, bold: true, font: 'Arial', color: '1a1a18' },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 28, bold: true, font: 'Arial', color: '1a5ca8' },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children: buildPageChildren(pageData, clientName)
    }]
  });
  return await Packer.toBuffer(doc);
}

async function buildPackageDocx(pages, clientName, sitemap) {
  var allChildren = [];

  // Cover
  allChildren.push(makeHeading('MMW Content Engine — Full Package', HeadingLevel.HEADING_1));
  allChildren.push(makeMeta('Client', clientName || ''));
  allChildren.push(makeMeta('Generated', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })));
  allChildren.push(makeMeta('Pages', (pages || []).length + ''));
  allChildren.push(makeSpacer());

  // Sitemap summary
  if (sitemap && sitemap.pages) {
    allChildren.push(makeRule());
    allChildren.push(makeSpacer());
    allChildren.push(makeHeading('Sitemap', HeadingLevel.HEADING_2));
    sitemap.pages.forEach(function (p) {
      allChildren.push(new Paragraph({
        children: [
          new TextRun({ text: p.number + '. ' + p.name + ' ', bold: true, size: 24 }),
          new TextRun({ text: '(' + p.url + ')', size: 22, color: '666666' })
        ]
      }));
    });
    allChildren.push(makeSpacer());
  }

  // Each page
  (pages || []).forEach(function (p, i) {
    if (!p.generated) return;
    allChildren.push(new Paragraph({ children: [new PageBreak()] }));
    buildPageChildren(p.generated, clientName).forEach(function (child) {
      allChildren.push(child);
    });
  });

  // Consolidated gap report
  var allGaps = [];
  (pages || []).forEach(function (p) {
    if (!p.generated) return;
    (p.generated.gapFlags || []).forEach(function (g) {
      allGaps.push({ page: p.name, ...g });
    });
  });

  if (allGaps.length) {
    allChildren.push(new Paragraph({ children: [new PageBreak()] }));
    allChildren.push(makeHeading('Consolidated Gap Report', HeadingLevel.HEADING_1));
    allChildren.push(makeSpacer());
    allGaps.forEach(function (g) {
      allChildren.push(new Paragraph({
        children: [new TextRun({ text: '[' + g.page + '] ' + (g.section || '') + (g.blocksPublish ? ' — BLOCKS PUBLISH' : ''), bold: true, size: 24, color: g.blocksPublish ? 'cc0000' : 'b45309' })]
      }));
      allChildren.push(makeBody('Missing: ' + (g.missing || '')));
      allChildren.push(new Paragraph({
        children: [new TextRun({ text: 'Ask: "' + (g.requestLanguage || '') + '"', italics: true, size: 22 })]
      }));
      allChildren.push(makeSpacer());
    });
  }

  var doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 24 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 36, bold: true, font: 'Arial', color: '1a1a18' },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 28, bold: true, font: 'Arial', color: '1a5ca8' },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children: allChildren
    }]
  });
  return await Packer.toBuffer(doc);
}

server.listen(PORT, function () {
  console.log('\n  MMW Content Engine v2');
  console.log('  http://localhost:' + PORT + '\n');
});
