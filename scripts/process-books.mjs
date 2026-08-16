#!/usr/bin/env node
// scripts/process-books.mjs
// Processes .epub, .pdf, .mobi, and .azw3 files in /books/ into static JSON under /data/
// Run manually or via GitHub Action on push.

import { EPub } from 'epub2';
import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKS_DIR = path.join(__dirname, '..', 'books');
const DATA_DIR = path.join(__dirname, '..', 'data');
const WORDS_PER_PAGE = 1000;
const WORDS_PER_SYNTHETIC_CHAPTER = 5000;

//--------------------------------------------------------------
// HELPERS
//--------------------------------------------------------------

function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function splitIntoPages(text, wordsPerPage = WORDS_PER_PAGE) {
  const words = text.split(/\s+/).filter(Boolean);
  const pages = [];
  for (let i = 0; i < words.length; i += wordsPerPage) {
    pages.push(words.slice(i, i + wordsPerPage).join(' '));
  }
  return pages;
}

// Split flat text into synthetic chapters of ~N words each
function makeSyntheticChapters(text, wordsPerChapter = WORDS_PER_SYNTHETIC_CHAPTER) {
  const words = text.split(/\s+/).filter(Boolean);
  const chapters = [];
  for (let i = 0; i < words.length; i += wordsPerChapter) {
    chapters.push(words.slice(i, i + wordsPerChapter).join(' '));
  }
  return chapters;
}

// Parse title + author from Anna's Archive filename format:
// "[1] Title -- Author -- ... -- Anna's Archive.ext"
function parseFilename(filename) {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  const parts = withoutExt.split(' -- ');
  // Strip leading series number like "[1] "
  const rawTitle = parts[0].trim().replace(/^\[\d+\]\s*/, '');
  const rawAuthor = parts[1]?.trim() || 'Unknown';
  // Clean up author (e.g. "Maas, Sarah J_" → keep as-is, underscore cleanup)
  const author = rawAuthor.replace(/_/g, '.').split(';')[0].trim();
  return { title: rawTitle, author };
}

//--------------------------------------------------------------
// WRITE BOOK DATA (shared between all formats)
//--------------------------------------------------------------

async function writeBookData({ id, title, author, description, filename, chapterTexts }) {
  const bookDir = path.join(DATA_DIR, id);
  const chaptersDir = path.join(bookDir, 'chapters');
  const pagesDir = path.join(bookDir, 'pages');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.mkdir(pagesDir, { recursive: true });

  const chaptersMeta = [];
  let allText = '';
  let globalPageStart = 1;

  for (let i = 0; i < chapterTexts.length; i++) {
    const { title: chapterTitle, text } = chapterTexts[i];
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const chapterPages = splitIntoPages(text);
    const chapterIndex = i + 1;

    chaptersMeta.push({
      index: chapterIndex,
      title: chapterTitle,
      wordCount,
      pageCount: chapterPages.length,
      startPage: globalPageStart,
    });

    await fs.writeFile(
      path.join(chaptersDir, `${chapterIndex}.json`),
      JSON.stringify({ index: chapterIndex, title: chapterTitle, wordCount, text }, null, 2)
    );

    allText += (allText ? ' ' : '') + text;
    globalPageStart += chapterPages.length;
  }

  const allPages = splitIntoPages(allText);
  for (let i = 0; i < allPages.length; i++) {
    await fs.writeFile(
      path.join(pagesDir, `${i + 1}.json`),
      JSON.stringify({ page: i + 1, totalPages: allPages.length, text: allPages[i] }, null, 2)
    );
  }

  const totalWords = allText.split(/\s+/).filter(Boolean).length;

  const info = {
    id, title, author, description, filename,
    totalWords,
    totalPages: allPages.length,
    totalChapters: chaptersMeta.length,
    chapters: chaptersMeta,
  };
  await fs.writeFile(path.join(bookDir, 'info.json'), JSON.stringify(info, null, 2));

  return { id, title, author, description, filename, totalWords, totalPages: allPages.length, totalChapters: chaptersMeta.length };
}

//--------------------------------------------------------------
// EPUB
//--------------------------------------------------------------

async function processEpub(filePath) {
  const filename = path.basename(filePath);
  const epub = await EPub.createAsync(filePath);

  const title = epub.metadata.title || parseFilename(filename).title;
  const author = epub.metadata.creator || epub.metadata.author || parseFilename(filename).author;
  const description = epub.metadata.description
    ? htmlToText(epub.metadata.description).slice(0, 500)
    : '';
  const id = slugify(title) || slugify(path.basename(filePath, '.epub'));

  const chapterTexts = [];
  for (const item of epub.flow) {
    if (!item.id) continue;
    try {
      const html = await epub.getChapterAsync(item.id);
      const text = htmlToText(html);
      if (!text || text.split(/\s+/).filter(Boolean).length < 30) continue;
      chapterTexts.push({ title: item.title || `Chapter ${chapterTexts.length + 1}`, text });
    } catch {
      // skip unreadable chapters
    }
  }

  return writeBookData({ id, title, author, description, filename, chapterTexts });
}

//--------------------------------------------------------------
// PDF
//--------------------------------------------------------------

async function processPdf(filePath) {
  const filename = path.basename(filePath);
  const { title: fnTitle, author: fnAuthor } = parseFilename(filename);

  const dataBuffer = await fs.readFile(filePath);
  const data = await pdfParse(dataBuffer);

  const title = data.info?.Title?.trim() || fnTitle;
  const author = data.info?.Author?.trim() || fnAuthor;
  const id = slugify(title) || slugify(path.basename(filePath, '.pdf'));

  const syntheticChapters = makeSyntheticChapters(data.text.replace(/\s+/g, ' ').trim());
  const chapterTexts = syntheticChapters.map((text, i) => ({
    title: `Part ${i + 1}`,
    text,
  }));

  return writeBookData({ id, title, author, description: '', filename, chapterTexts });
}

//--------------------------------------------------------------
// MOBI / AZW3 (via calibre ebook-convert)
//--------------------------------------------------------------

async function processMobiAzw3(filePath) {
  const filename = path.basename(filePath);
  const { title: fnTitle, author: fnAuthor } = parseFilename(filename);
  const ext = path.extname(filePath).toLowerCase().slice(1);

  // Check calibre is available
  const calibreAvailable = await execFileAsync('which', ['ebook-convert'])
    .then(() => true)
    .catch(() => false);

  if (!calibreAvailable) {
    throw new Error('calibre not installed — cannot process .mobi/.azw3 files');
  }

  const tmpTxt = path.join(os.tmpdir(), `${path.basename(filePath, '.' + ext)}.txt`);
  await execFileAsync('ebook-convert', [filePath, tmpTxt, '--txt-output-formatting=markdown']);
  const rawText = await fs.readFile(tmpTxt, 'utf8');
  await fs.unlink(tmpTxt).catch(() => {});

  const id = slugify(fnTitle) || slugify(path.basename(filePath, '.' + ext));
  const syntheticChapters = makeSyntheticChapters(rawText.replace(/\s+/g, ' ').trim());
  const chapterTexts = syntheticChapters.map((text, i) => ({
    title: `Part ${i + 1}`,
    text,
  }));

  return writeBookData({ id, title: fnTitle, author: fnAuthor, description: '', filename, chapterTexts });
}

//--------------------------------------------------------------
// MAIN
//--------------------------------------------------------------

// Emitted by a child process so the parent can recover the index entry.
const ENTRY_MARKER = '__BOOK_ENTRY__';
const SUPPORTED = /\.(epub|pdf|mobi|azw3)$/i;

async function fileSha(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// Dispatch a single book. forceCalibre routes anything through ebook-convert,
// which is the fallback when a native parser chokes on a malformed file.
async function processOne(filePath, forceCalibre = false) {
  const ext = path.extname(filePath).toLowerCase();
  if (forceCalibre) return processMobiAzw3(filePath);
  if (ext === '.epub') return processEpub(filePath);
  if (ext === '.pdf') return processPdf(filePath);
  if (ext === '.mobi' || ext === '.azw3') return processMobiAzw3(filePath);
  return null;
}

//--------------------------------------------------------------
// CHILD MODE — process exactly one book, then exit
//--------------------------------------------------------------

async function runAsChild(filePath, forceCalibre) {
  const entry = await processOne(filePath, forceCalibre);
  if (!entry) {
    console.error(`No handler for ${path.basename(filePath)}`);
    process.exit(2);
  }
  console.log(ENTRY_MARKER + JSON.stringify(entry));
  process.exit(0);
}

//--------------------------------------------------------------
// PARENT MODE — isolate each book in its own process
//--------------------------------------------------------------

// epub2 parses via event callbacks, so a malformed table of contents throws
// from inside an I/O callback and escapes any try/catch here — it kills the
// whole run. A child process turns that into a recoverable exit code.
async function processInChild(filePath, forceCalibre = false) {
  const args = [fileURLToPath(import.meta.url), '--single', filePath];
  if (forceCalibre) args.push('--force-calibre');
  const { stdout } = await execFileAsync(process.execPath, args, {
    maxBuffer: 256 * 1024 * 1024,
  });
  const line = stdout.split('\n').find(l => l.startsWith(ENTRY_MARKER));
  if (!line) throw new Error('child exited without producing an entry');
  return JSON.parse(line.slice(ENTRY_MARKER.length));
}

async function readPreviousIndex() {
  const map = new Map();
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'index.json'), 'utf8');
    for (const entry of JSON.parse(raw).books || []) {
      if (entry.filename) map.set(entry.filename, entry);
    }
  } catch {
    // no previous index — first run, or it was never committed
  }
  return map;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BOOKS_DIR, { recursive: true });

  const force = process.argv.includes('--force');
  const prune = process.argv.includes('--prune');

  const allFiles = await fs.readdir(BOOKS_DIR).catch(() => []);
  const files = allFiles.filter(f => SUPPORTED.test(f));
  const previous = await readPreviousIndex();

  console.log(`Found ${files.length} book file(s)${force ? ' — --force, reprocessing all' : ''}`);

  const index = [];
  let skipped = 0, done = 0, failed = 0, salvaged = 0;

  for (const file of files) {
    const filePath = path.join(BOOKS_DIR, file);
    const ext = path.extname(file).toLowerCase();
    const sha = await fileSha(filePath);
    const prior = previous.get(file);

    // Unchanged and its data is still on disk — reuse the entry untouched.
    if (!force && prior?.sha === sha && existsSync(path.join(DATA_DIR, prior.id, 'info.json'))) {
      index.push(prior);
      skipped++;
      continue;
    }

    console.log(`Processing [${ext.slice(1)}]: ${file}`);
    let entry = null;

    try {
      entry = await processInChild(filePath);
    } catch (err) {
      const detail = (err.stderr || err.message || '').split('\n').find(Boolean) || 'unknown error';
      console.error(`  ✗ Native parse failed (${file}): ${detail}`);

      // Fall back to calibre, which rewrites the book to flat text and
      // sidesteps whatever the native parser tripped over.
      if (ext !== '.pdf') {
        try {
          console.log(`  ↻ Retrying via calibre...`);
          entry = await processInChild(filePath, true);
          salvaged++;
        } catch (err2) {
          const d2 = (err2.stderr || err2.message || '').split('\n').find(Boolean) || 'unknown error';
          console.error(`  ✗ Calibre fallback also failed (${file}): ${d2}`);
        }
      }
    }

    if (entry) {
      entry.sha = sha;
      index.push(entry);
      done++;
      console.log(`  ✓ "${entry.title}" by ${entry.author} — ${entry.totalChapters} parts/chapters, ${entry.totalPages} pages`);
    } else {
      failed++;
      // Keep the old entry if we have one, so a newly-broken file doesn't
      // silently vanish from a library that was working yesterday.
      if (prior) {
        index.push(prior);
        console.log(`  ↩ Keeping previous entry for ${file}`);
      }
    }
  }

  // Books removed from /books/ drop out of the index automatically. Their
  // data directories linger unless --prune is passed.
  const liveIds = new Set(index.map(e => e.id));
  const orphans = [...previous.values()].filter(e => !liveIds.has(e.id));
  if (orphans.length) {
    console.log(`\n${orphans.length} orphaned entr(ies): ${orphans.map(o => o.id).join(', ')}`);
    if (prune) {
      for (const o of orphans) {
        await fs.rm(path.join(DATA_DIR, o.id), { recursive: true, force: true });
        console.log(`  🗑 pruned data/${o.id}`);
      }
    } else {
      console.log(`  (run with --prune to delete their data directories)`);
    }
  }

  index.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  await fs.writeFile(
    path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ books: index, updatedAt: new Date().toISOString() }, null, 2)
  );

  console.log(
    `\n✓ Done — ${index.length} book(s) in library ` +
    `(${done} processed, ${salvaged} via calibre fallback, ${skipped} unchanged, ${failed} failed)`
  );
}

//--------------------------------------------------------------

const singleIdx = process.argv.indexOf('--single');
if (singleIdx !== -1 && process.argv[singleIdx + 1]) {
  runAsChild(process.argv[singleIdx + 1], process.argv.includes('--force-calibre'))
    .catch(err => {
      console.error(err?.message || err);
      process.exit(1);
    });
} else {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
