import { Feed } from 'feed';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync } from 'fs';

interface BlogPost {
  title: string;
  link: string;
  description: string;
  category: string;
  date: string;
  source: string;
}

interface BlogSource {
  name: string;
  slug: string;
  url: string;
  siteUrl: string;
  description: string;
  copyright: string;
  parse: (html: string, siteUrl: string) => BlogPost[];
  fetchAll: (fetchPage: (url: string) => Promise<string>, baseUrl: string, siteUrl: string, parse: (html: string, siteUrl: string) => BlogPost[]) => Promise<BlogPost[]>;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BlogRSSAggregator/1.0' }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function parseDate(dateStr: string): Date {
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();

// ============ CURSOR BLOG PARSER ============
function parseCursorBlog(html: string, siteUrl: string): BlogPost[] {
  const $ = cheerio.load(html);
  const posts: BlogPost[] = [];

  const addPost = (post: BlogPost) => {
    if (!post.title || !post.link) return;
    posts.push(post);
  };

  $('article a[href^="/blog/"]').each((_, el) => {
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

    const title = normalizeText($el.find('p').first().text());
    const description = normalizeText($el.find('p').eq(1).text());
    const categoryText = normalizeText($el.find('span.capitalize').first().text());
    const category = categoryText.replace(/\s*·\s*$/, '') || 'post';
    const timeEl = $el.find('time').first();
    const dateStr = timeEl.attr('dateTime') || normalizeText(timeEl.text());

    addPost({
      title,
      link: `${siteUrl}${href}`,
      description,
      category,
      date: dateStr,
      source: 'Cursor'
    });
  });

  // Fallback parser
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
        link: `${siteUrl}${href}`,
        description,
        category,
        date: dateStr,
        source: 'Cursor'
      });
    });
  }

  return posts;
}

async function fetchCursorPosts(
  fetchFn: typeof fetchPage,
  baseUrl: string,
  siteUrl: string,
  parse: typeof parseCursorBlog
): Promise<BlogPost[]> {
  const allPosts: BlogPost[] = [];
  let page = 1;
  const maxPages = 100;

  while (page <= maxPages) {
    const url = page === 1 ? baseUrl : `${baseUrl}/page/${page}`;
    
    try {
      const html = await fetchFn(url);
      const posts = parse(html, siteUrl);
      
      if (posts.length === 0) break;
      
      allPosts.push(...posts);
      
      if (!html.includes(`/blog/page/${page + 1}`)) break;
      
      page++;
    } catch (e) {
      break;
    }
  }

  return allPosts;
}

// ============ CLAUDE BLOG PARSER ============
function parseClaudeBlog(html: string, siteUrl: string): BlogPost[] {
  const $ = cheerio.load(html);
  const posts: BlogPost[] = [];
  const seen = new Set<string>();

  // Look for blog post links - Claude blog uses various card layouts
  // Target links that contain blog post patterns
  $('a[href*="/blog/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    
    // Skip if it's just the main blog link or already seen
    if (href === '/blog' || href === '/blog/' || !href.includes('/blog/')) return;
    
    // Build full URL
    const fullUrl = href.startsWith('http') ? href : `${siteUrl}${href}`;
    
    // Skip duplicates
    if (seen.has(fullUrl)) return;
    
    // Get text content
    const text = $el.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines.length === 0) return;

    // Try to extract title - usually the most prominent text
    let title = '';
    let dateStr = '';
    let category = 'Blog';

    // Look for date patterns like "January 12, 2026" or "December 9, 2025"
    const datePattern = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}$/i;
    const shortDatePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i;
    
    for (const line of lines) {
      if (datePattern.test(line) || shortDatePattern.test(line)) {
        dateStr = line;
      } else if (!title && line.length > 10 && !line.includes('Read more')) {
        title = line;
      } else if (['Agents', 'Coding', 'Enterprise AI', 'Product announcements'].includes(line)) {
        category = line;
      }
    }

    if (!title) return;
    
    seen.add(fullUrl);
    posts.push({
      title: normalizeText(title),
      link: fullUrl,
      description: '',
      category,
      date: dateStr,
      source: 'Claude Blog'
    });
  });

  return posts;
}

async function fetchClaudePosts(
  fetchFn: typeof fetchPage,
  baseUrl: string,
  siteUrl: string,
  parse: typeof parseClaudeBlog
): Promise<BlogPost[]> {
  try {
    const html = await fetchFn(baseUrl);
    return parse(html, siteUrl);
  } catch (e) {
    console.error('Error fetching Claude blog:', e);
    return [];
  }
}

// ============ ANTHROPIC ENGINEERING BLOG PARSER ============
function parseAnthropicEngineering(html: string, siteUrl: string): BlogPost[] {
  const $ = cheerio.load(html);
  const posts: BlogPost[] = [];
  const seen = new Set<string>();

  // Anthropic engineering blog has articles with links
  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    
    // Look for engineering article links
    if (!href.includes('/engineering/') && !href.includes('/news/')) return;
    if (href === '/engineering' || href === '/engineering/') return;
    
    const fullUrl = href.startsWith('http') ? href : `${siteUrl}${href}`;
    if (seen.has(fullUrl)) return;

    const text = $el.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines.length === 0) return;

    let title = '';
    let dateStr = '';
    
    // Date patterns like "Nov 26, 2025" or "December 19, 2024"
    const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i;
    const longDatePattern = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}$/i;
    
    for (const line of lines) {
      if (datePattern.test(line) || longDatePattern.test(line)) {
        dateStr = line;
      } else if (!title && line.length > 15) {
        title = line;
      }
    }

    if (!title) return;
    
    seen.add(fullUrl);
    posts.push({
      title: normalizeText(title),
      link: fullUrl,
      description: '',
      category: 'Engineering',
      date: dateStr,
      source: 'Anthropic Engineering'
    });
  });

  return posts;
}

async function fetchAnthropicEngineeringPosts(
  fetchFn: typeof fetchPage,
  baseUrl: string,
  siteUrl: string,
  parse: typeof parseAnthropicEngineering
): Promise<BlogPost[]> {
  try {
    const html = await fetchFn(baseUrl);
    return parse(html, siteUrl);
  } catch (e) {
    console.error('Error fetching Anthropic Engineering blog:', e);
    return [];
  }
}

// ============ ANTHROPIC RESEARCH BLOG PARSER ============
function parseAnthropicResearch(html: string, siteUrl: string): BlogPost[] {
  const $ = cheerio.load(html);
  const posts: BlogPost[] = [];
  const seen = new Set<string>();

  // Research page has publications with links
  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    
    // Look for research/news article links
    if (!href.includes('/research/') && !href.includes('/news/')) return;
    if (href === '/research' || href === '/research/') return;
    
    const fullUrl = href.startsWith('http') ? href : `${siteUrl}${href}`;
    if (seen.has(fullUrl)) return;

    const text = $el.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines.length === 0) return;

    let title = '';
    let dateStr = '';
    let category = 'Research';
    
    const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}$/i;
    const longDatePattern = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}$/i;
    
    const categories = ['Interpretability', 'Alignment', 'Societal Impacts', 'Policy', 'Economic Research', 'Announcements'];
    
    for (const line of lines) {
      if (datePattern.test(line) || longDatePattern.test(line)) {
        dateStr = line;
      } else if (categories.includes(line)) {
        category = line;
      } else if (!title && line.length > 15) {
        title = line;
      }
    }

    if (!title) return;
    
    seen.add(fullUrl);
    posts.push({
      title: normalizeText(title),
      link: fullUrl,
      description: '',
      category,
      date: dateStr,
      source: 'Anthropic Research'
    });
  });

  return posts;
}

async function fetchAnthropicResearchPosts(
  fetchFn: typeof fetchPage,
  baseUrl: string,
  siteUrl: string,
  parse: typeof parseAnthropicResearch
): Promise<BlogPost[]> {
  try {
    const html = await fetchFn(baseUrl);
    return parse(html, siteUrl);
  } catch (e) {
    console.error('Error fetching Anthropic Research:', e);
    return [];
  }
}

// ============ BLOG SOURCES CONFIGURATION ============
const blogSources: BlogSource[] = [
  {
    name: 'Cursor Blog',
    slug: 'cursor',
    url: 'https://cursor.com/blog',
    siteUrl: 'https://cursor.com',
    description: 'The latest updates from the Cursor team',
    copyright: `© ${new Date().getFullYear()} Anysphere, Inc.`,
    parse: parseCursorBlog,
    fetchAll: fetchCursorPosts
  },
  {
    name: 'Claude Blog',
    slug: 'claude',
    url: 'https://claude.com/blog',
    siteUrl: 'https://claude.com',
    description: 'Product news and best practices for teams building with Claude',
    copyright: `© ${new Date().getFullYear()} Anthropic PBC`,
    parse: parseClaudeBlog,
    fetchAll: fetchClaudePosts
  },
  {
    name: 'Anthropic Engineering',
    slug: 'anthropic-engineering',
    url: 'https://www.anthropic.com/engineering',
    siteUrl: 'https://www.anthropic.com',
    description: 'Inside the team building reliable AI systems at Anthropic',
    copyright: `© ${new Date().getFullYear()} Anthropic PBC`,
    parse: parseAnthropicEngineering,
    fetchAll: fetchAnthropicEngineeringPosts
  },
  {
    name: 'Anthropic Research',
    slug: 'anthropic-research',
    url: 'https://www.anthropic.com/research',
    siteUrl: 'https://www.anthropic.com',
    description: 'Research on AI safety, interpretability, and societal impacts',
    copyright: `© ${new Date().getFullYear()} Anthropic PBC`,
    parse: parseAnthropicResearch,
    fetchAll: fetchAnthropicResearchPosts
  }
];

const BASE_FEED_URL = 'https://dasconnor.github.io/cursor-blog-rss';

function createFeed(
  title: string,
  description: string,
  id: string,
  link: string,
  copyright: string,
  feedSlug: string
): Feed {
  return new Feed({
    title,
    description,
    id,
    link,
    language: 'en',
    copyright,
    updated: new Date(),
    feedLinks: {
      rss: `${BASE_FEED_URL}/${feedSlug}/rss.xml`,
      atom: `${BASE_FEED_URL}/${feedSlug}/atom.xml`
    }
  });
}

function dedupeByLink(posts: BlogPost[]): BlogPost[] {
  const seen = new Set<string>();
  return posts.filter(post => {
    if (seen.has(post.link)) return false;
    seen.add(post.link);
    return true;
  });
}

async function main() {
  console.log('Fetching blog posts from all sources...\n');
  
  const allPosts: BlogPost[] = [];
  const postsBySource: Map<string, BlogPost[]> = new Map();

  // Fetch from all sources
  for (const source of blogSources) {
    console.log(`Fetching ${source.name}...`);
    const posts = await source.fetchAll(fetchPage, source.url, source.siteUrl, source.parse);
    const dedupedPosts = dedupeByLink(posts);
    console.log(`  Found ${dedupedPosts.length} posts`);
    
    postsBySource.set(source.slug, dedupedPosts);
    allPosts.push(...dedupedPosts);
  }

  console.log(`\nTotal posts across all sources: ${allPosts.length}`);

  // Ensure dist directory exists
  mkdirSync('./dist', { recursive: true });

  // Generate individual feeds for each source
  for (const source of blogSources) {
    const posts = postsBySource.get(source.slug) || [];
    const feed = createFeed(
      source.name,
      source.description,
      source.url,
      source.url,
      source.copyright,
      source.slug
    );

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

    // Create source-specific directory
    mkdirSync(`./dist/${source.slug}`, { recursive: true });
    writeFileSync(`./dist/${source.slug}/rss.xml`, feed.rss2());
    writeFileSync(`./dist/${source.slug}/atom.xml`, feed.atom1());
    writeFileSync(`./dist/${source.slug}/feed.json`, feed.json1());
    
    console.log(`Generated feeds for ${source.name} in ./dist/${source.slug}/`);
  }

  // Generate legacy Cursor feed at root (maintains backward compatibility)
  const cursorPosts = postsBySource.get('cursor') || [];
  const cursorFeed = new Feed({
    title: 'Cursor Blog',
    description: 'The latest updates from the Cursor team',
    id: 'https://cursor.com/blog',
    link: 'https://cursor.com/blog',
    language: 'en',
    image: 'https://cursor.com/favicon.ico',
    favicon: 'https://cursor.com/favicon.ico',
    copyright: `© ${new Date().getFullYear()} Anysphere, Inc.`,
    updated: new Date(),
    feedLinks: {
      rss: `${BASE_FEED_URL}/rss.xml`,
      atom: `${BASE_FEED_URL}/atom.xml`
    }
  });

  for (const post of cursorPosts) {
    cursorFeed.addItem({
      title: post.title,
      id: post.link,
      link: post.link,
      description: post.description,
      category: [{ name: post.category }],
      date: parseDate(post.date)
    });
  }

  writeFileSync('./dist/rss.xml', cursorFeed.rss2());
  writeFileSync('./dist/atom.xml', cursorFeed.atom1());
  writeFileSync('./dist/feed.json', cursorFeed.json1());
  console.log('Generated legacy Cursor feeds at ./dist/ root');

  // Generate aggregated feed with all posts
  const aggregatedFeed = new Feed({
    title: 'AI Tools Blog Aggregator',
    description: 'Aggregated feed from Cursor, Claude, and Anthropic blogs',
    id: BASE_FEED_URL,
    link: BASE_FEED_URL,
    language: 'en',
    copyright: `© ${new Date().getFullYear()}`,
    updated: new Date(),
    feedLinks: {
      rss: `${BASE_FEED_URL}/all/rss.xml`,
      atom: `${BASE_FEED_URL}/all/atom.xml`
    }
  });

  // Sort all posts by date (newest first)
  const sortedPosts = dedupeByLink(allPosts).sort((a, b) => {
    return parseDate(b.date).getTime() - parseDate(a.date).getTime();
  });

  for (const post of sortedPosts) {
    aggregatedFeed.addItem({
      title: `[${post.source}] ${post.title}`,
      id: post.link,
      link: post.link,
      description: post.description,
      category: [{ name: post.category }, { name: post.source }],
      date: parseDate(post.date)
    });
  }

  mkdirSync('./dist/all', { recursive: true });
  writeFileSync('./dist/all/rss.xml', aggregatedFeed.rss2());
  writeFileSync('./dist/all/atom.xml', aggregatedFeed.atom1());
  writeFileSync('./dist/all/feed.json', aggregatedFeed.json1());
  console.log('Generated aggregated feed in ./dist/all/');

  // Generate index page with all feeds
  const sourceLinks = blogSources.map(s => `
    <div class="feed-card">
      <h3>${s.name}</h3>
      <p>${s.description}</p>
      <ul>
        <li><a href="${s.slug}/rss.xml">RSS 2.0</a></li>
        <li><a href="${s.slug}/atom.xml">Atom</a></li>
        <li><a href="${s.slug}/feed.json">JSON Feed</a></li>
      </ul>
      <p><a href="${s.url}" target="_blank">Visit ${s.name} →</a></p>
    </div>
  `).join('\n');

  writeFileSync('./dist/index.html', `<!DOCTYPE html>
<html>
<head>
  <title>AI Tools Blog RSS Aggregator</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      line-height: 1.6;
      color: #333;
    }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
    h2 { margin-top: 30px; color: #555; }
    .feed-card {
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 15px 20px;
      margin: 15px 0;
      background: #fafafa;
    }
    .feed-card h3 { margin-top: 0; color: #222; }
    .feed-card ul { margin: 10px 0; }
    .aggregated {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .aggregated h3, .aggregated p { color: white; }
    .aggregated a { color: #fff; font-weight: 500; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .legacy-note {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 4px;
      padding: 10px 15px;
      margin: 20px 0;
    }
    footer { margin-top: 40px; color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>AI Tools Blog RSS Aggregator</h1>
  <p>Subscribe to updates from Cursor, Claude, and Anthropic blogs.</p>

  <div class="feed-card aggregated">
    <h3>All Feeds Combined</h3>
    <p>Get updates from all sources in one feed</p>
    <ul>
      <li><a href="all/rss.xml">RSS 2.0</a></li>
      <li><a href="all/atom.xml">Atom</a></li>
      <li><a href="all/feed.json">JSON Feed</a></li>
    </ul>
  </div>

  <h2>Individual Feeds</h2>
  ${sourceLinks}

  <div class="legacy-note">
    <strong>Note:</strong> The original Cursor-only feed URLs (<code>rss.xml</code>, <code>atom.xml</code>, <code>feed.json</code> at root) continue to work for backward compatibility.
  </div>

  <footer>
    <p>Last updated: ${new Date().toISOString()}</p>
    <p>Feeds are updated twice daily.</p>
  </footer>
</body>
</html>`);

  console.log('\nGenerated index page at ./dist/index.html');
  console.log('Done!');
}

main().catch(console.error);
