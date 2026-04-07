#!/usr/bin/env node
// scripts/process-books.mjs
// Processes all .epub files in /books/ into static JSON files under /data/
// Run manually or via GitHub Action on push.

import { EPub } from 'epub2';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOKS_DIR = path.join(__dirname, '..', 'books');
const DATA_DIR = path.join(__dirname, '..', 'data');
const WORDS_PER_PAGE = 1000;

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

//--------------------------------------------------------------
// PROCESS A SINGLE EPUB
//--------------------------------------------------------------

async function processEpub(filePath) {
  const filename = path.basename(filePath);
  const epub = await EPub.createAsync(filePath);

  const title = epub.metadata.title || path.basename(filePath, '.epub');
  const author = epub.metadata.creator || epub.metadata.author || 'Unknown';
  const description = epub.metadata.description
    ? htmlToText(epub.metadata.description).slice(0, 500)
    : '';
  const id = slugify(title) || slugify(path.basename(filePath, '.epub'));

  const bookDir = path.join(DATA_DIR, id);
  const chaptersDir = path.join(bookDir, 'chapters');
  const pagesDir = path.join(bookDir, 'pages');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.mkdir(pagesDir, { recursive: true });

  // Extract and write chapters
  const chaptersMeta = [];
  let allText = '';
  let globalPageStart = 1;

  for (const item of epub.flow) {
    if (!item.id) continue;
    try {
      const html = await epub.getChapterAsync(item.id);
      const text = htmlToText(html);
      if (!text || text.split(/\s+/).filter(Boolean).length < 30) continue;

      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const chapterPages = splitIntoPages(text);
      const chapterIndex = chaptersMeta.length + 1;
      const chapterTitle = item.title || `Chapter ${chapterIndex}`;

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

    } catch (err) {
      // skip unreadable chapters silently
    }
  }

  // Write pages (global, cross-chapter)
  const allPages = splitIntoPages(allText);
  for (let i = 0; i < allPages.length; i++) {
    await fs.writeFile(
      path.join(pagesDir, `${i + 1}.json`),
      JSON.stringify({ page: i + 1, totalPages: allPages.length, text: allPages[i] }, null, 2)
    );
  }

  const totalWords = allText.split(/\s+/).filter(Boolean).length;

  // Write book info
  const info = {
    id,
    title,
    author,
    description,
    filename,
    totalWords,
    totalPages: allPages.length,
    totalChapters: chaptersMeta.length,
    chapters: chaptersMeta,
  };
  await fs.writeFile(path.join(bookDir, 'info.json'), JSON.stringify(info, null, 2));

  return {
    id,
    title,
    author,
    description,
    totalWords,
    totalPages: allPages.length,
    totalChapters: chaptersMeta.length,
  };
}

//--------------------------------------------------------------
// MAIN
//--------------------------------------------------------------

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BOOKS_DIR, { recursive: true });

  let files;
  try {
    files = (await fs.readdir(BOOKS_DIR)).filter(f => f.toLowerCase().endsWith('.epub'));
  } catch {
    files = [];
  }

  console.log(`Found ${files.length} epub file(s)`);

  const index = [];

  for (const file of files) {
    console.log(`Processing: ${file}`);
    try {
      const entry = await processEpub(path.join(BOOKS_DIR, file));
      index.push(entry);
      console.log(`  ✓ "${entry.title}" by ${entry.author} — ${entry.totalChapters} chapters, ${entry.totalPages} pages`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }
  }

  await fs.writeFile(
    path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ books: index, updatedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`\n✓ Done — ${index.length} book(s) in library`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
