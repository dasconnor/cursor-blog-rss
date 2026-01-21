import { Feed } from 'feed';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync } from 'fs';

const BLOG_URL = 'https://cursor.com/blog';
const SITE_URL = 'https://cursor.com';

interface BlogPost {
  title: string;
  link: string;
  description: string;
  category: string;
  date: string;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CursorBlogRSS/1.0' }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function parseBlogPage(html: string): BlogPost[] {
  const $ = cheerio.load(html);
  const posts: BlogPost[] = [];

  const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();

  const addPost = (post: BlogPost) => {
    if (!post.title || !post.link) return;
    posts.push(post);
  };

  // The blog list is server-rendered as articles with a card link inside.
  $('article a[href^="/blog/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');

    // Skip navigation links and topic filters
    if (
      !href ||
      href === '/blog' ||
      href.startsWith('/blog/topic') ||
      href.startsWith('/blog/page')
    ) {
      return;
    }

    const title = normalizeText($el.find('p').first().text());
    const description = normalizeText($el.find('p').eq(1).text());
    const categoryText = normalizeText($el.find('span.capitalize').first().text());
    const category = categoryText.replace(/\s*·\s*$/, '') || 'post';
    const timeEl = $el.find('time').first();
    const dateStr = timeEl.attr('dateTime') || normalizeText(timeEl.text());

    addPost({
      title,
      link: `${SITE_URL}${href}`,
      description,
      category,
      date: dateStr
    });
  });

  // Fallback: try the old text parsing if we didn't find any articles.
  if (posts.length === 0) {
    $('a[href^="/blog/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');

      if (
        !href ||
        href === '/blog' ||
        href.startsWith('/blog/topic') ||
        href.startsWith('/blog/page')
      ) {
        return;
      }

      const text = $el.text();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      if (lines.length < 2) return;

      const title = lines[0];
      const description = lines.length > 2 ? lines.slice(1, -1).join(' ') : '';
      const metaLine = lines[lines.length - 1];
      const metaMatch = metaLine.match(/^(\w+)\s*·\s*(.+)$/);
      const category = metaMatch?.[1] || 'post';
      const dateStr = metaMatch?.[2] || '';

      addPost({
        title,
        link: `${SITE_URL}${href}`,
        description,
        category,
        date: dateStr
      });
    });
  }

  return posts;
}

function parseDate(dateStr: string): Date {
  // Handle "Mon DD, YYYY" format (e.g., "Nov 13, 2025")
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function fetchAllPosts(): Promise<BlogPost[]> {
  const allPosts: BlogPost[] = [];
  let page = 1;
  const maxPages = 100; // Safety limit for full back-catalogue

  while (page <= maxPages) {
    const url = page === 1 ? BLOG_URL : `${BLOG_URL}/page/${page}`;
    
    try {
      const html = await fetchPage(url);
      const posts = parseBlogPage(html);
      
      if (posts.length === 0) break;
      
      allPosts.push(...posts);
      
      // Check if there's a next page link
      if (!html.includes(`/blog/page/${page + 1}`)) break;
      
      page++;
    } catch (e) {
      // No more pages or error
      break;
    }
  }

  // Dedupe by link
  const seen = new Set<string>();
  return allPosts.filter(post => {
    if (seen.has(post.link)) return false;
    seen.add(post.link);
    return true;
  });
}

async function main() {
  console.log('Fetching Cursor blog posts...');
  
  const posts = await fetchAllPosts();
  console.log(`Found ${posts.length} posts`);

  const feed = new Feed({
    title: 'Cursor Blog',
    description: 'The latest updates from the Cursor team',
    id: BLOG_URL,
    link: BLOG_URL,
    language: 'en',
    image: `${SITE_URL}/favicon.ico`,
    favicon: `${SITE_URL}/favicon.ico`,
    copyright: `© ${new Date().getFullYear()} Anysphere, Inc.`,
    updated: new Date(),
    feedLinks: {
      rss: 'https://dasconnor.github.io/cursor-blog-rss/rss.xml',
      atom: 'https://dasconnor.github.io/cursor-blog-rss/atom.xml'
    }
  });

  for (const post of posts) {
    feed.addItem({
      title: post.title,
      id: post.link,
      link: post.link,
      description: post.description,
      category: [{ name: post.category }],
      date: parseDate(post.date)
    });
  }

  // Ensure dist directory exists
  mkdirSync('./dist', { recursive: true });

  // Write feeds
  writeFileSync('./dist/rss.xml', feed.rss2());
  writeFileSync('./dist/atom.xml', feed.atom1());
  writeFileSync('./dist/feed.json', feed.json1());
  
  // Simple index page
  writeFileSync('./dist/index.html', `<!DOCTYPE html>
<html>
<head>
  <title>Cursor Blog RSS</title>
  <meta charset="utf-8">
</head>
<body>
  <h1>Cursor Blog RSS Feed</h1>
  <p>Subscribe to the Cursor blog:</p>
  <ul>
    <li><a href="rss.xml">RSS 2.0</a></li>
    <li><a href="atom.xml">Atom</a></li>
    <li><a href="feed.json">JSON Feed</a></li>
  </ul>
  <p>Last updated: ${new Date().toISOString()}</p>
  <p><a href="https://cursor.com/blog">Visit Cursor Blog →</a></p>
</body>
</html>`);

  console.log('Generated feeds in ./dist/');
}

main().catch(console.error);