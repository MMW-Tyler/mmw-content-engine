# MMW Content Engine

AI-powered sitemap and copy generator for Medical Marketing Whiz client websites.

---

## Setup (one time per machine)

### 1. Install Node.js
Download and install from https://nodejs.org — choose the LTS version.
This is free and takes about 2 minutes. You only do this once.

### 2. Get the files
Put the `mmw-content-engine` folder somewhere on your computer (Desktop is fine).

### 3. Create your API key file
Inside the `mmw-content-engine` folder, create a file named exactly:
```
.env
```
Open it with any text editor (Notepad, TextEdit) and add this one line:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```
Replace `sk-ant-your-key-here` with your actual Anthropic API key.

---

## Running the app

1. Open Terminal (Mac) or Command Prompt (Windows)
2. Navigate to the folder:
   ```
   cd Desktop/mmw-content-engine
   ```
3. Start the server:
   ```
   node server.js
   ```
4. Open your browser and go to:
   ```
   http://localhost:3000
   ```

The app runs until you close the terminal window. Next time you want to use it, just repeat steps 1-4.

---

## Using the app

**Step 1 — Upload**
Upload the client's onboarding form and/or master record. PDF and DOCX both work. Drag and drop or click to browse.

**Step 2 — Review extracted data**
The AI reads the documents and pulls out all client info. Review it for accuracy. Missing fields are flagged.

**Step 3 — Sitemap**
A recommended 10-page sitemap is generated with URL slugs and rationale. You can:
- Approve it as-is and proceed
- Export it as a .txt file, edit it, re-upload it, then proceed
- The bottom section shows recommended additional pages as upsell opportunities

**Step 4 — Copy generation**
Each page generates one at a time. Click any completed page to preview:
- Copy tab: all page sections with inline gap placeholders
- SEO + AEO tab: page title, meta, H1, AEO content blocks, FAQ schema JSON-LD (ready to paste)
- Gap flags tab: what's missing, whether it blocks publishing, and suggested language to send the client

**Step 5 — Export**
Download individual pages or the full package. The full package includes all pages plus a consolidated gap report at the end.

---

## File formats

Accepted: `.pdf`, `.docx`, `.doc`, `.txt`
Output: `.txt` files formatted for agency handoff

---

## Troubleshooting

**"ANTHROPIC_API_KEY not found"**
Check that your `.env` file exists in the right folder and that the key is spelled correctly.

**"Cannot find module"**
Make sure you're in the right folder in your terminal. Run `ls` (Mac) or `dir` (Windows) — you should see `server.js` listed.

**Port already in use**
Something else is using port 3000. Either close that app, or add `PORT=3001` to your `.env` file and go to `http://localhost:3001` instead.

**Page generation fails mid-way**
The API call may have timed out. The page will show "Error" — you can re-run the whole flow. Each generation is independent.
