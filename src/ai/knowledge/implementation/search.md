# Search & Filtering

## When to Use This

Use these patterns when adding search functionality to your application — full-text search in PostgreSQL, debounced search inputs, URL-synced filters, faceted search, or autocomplete. These patterns avoid adding external search services (Elasticsearch, Algolia) for cases where PostgreSQL is sufficient.

## Quick Start

### Dependencies

```bash
# PostgreSQL full-text search — no extra packages needed (uses pg/drizzle)

# Debounce hook
npm install use-debounce

# URL state management
npm install nuqs           # Next.js App Router URL state
# OR
npm install react-router-dom  # For React Router apps

# Fuzzy matching (client-side, small datasets)
npm install fuse.js

# Optional: pg_trgm extension (enable once in DB migration)
# CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
```

---

## Patterns

### 1. PostgreSQL Full-Text Search — tsvector + tsquery

```typescript
// src/db/schema/posts.ts — add tsvector column
import { pgTable, uuid, text, timestamp, customType } from 'drizzle-orm/pg-core';

// tsvector is not natively in Drizzle — use customType
const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector'; },
});

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  authorName: text('author_name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  // Computed tsvector column — maintained via trigger or on insert/update
  searchVector: tsvector('search_vector'),
});

// Migration SQL — create GIN index and trigger
// drizzle/0010_search.sql
/*
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS posts_search_idx ON posts USING GIN (search_vector);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION posts_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.author_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint
CREATE TRIGGER posts_search_vector_trigger
  BEFORE INSERT OR UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_search_vector_update();
*/
```

```typescript
// src/db/queries/search.ts
import { sql, desc, and, isNull } from 'drizzle-orm';
import { db } from '../index';
import { posts } from '../schema';

export interface SearchPostsParams {
  query: string;
  limit?: number;
  offset?: number;
  authorId?: string;
}

export interface SearchResult<T> {
  data: T[];
  total: number;
  hasMore: boolean;
}

export async function searchPosts({
  query,
  limit = 20,
  offset = 0,
  authorId,
}: SearchPostsParams): Promise<SearchResult<typeof posts.$inferSelect & { rank: number }>> {
  // Sanitize: replace special tsquery chars
  const sanitized = query.trim().replace(/[!&|():*'"\\]/g, ' ').trim();
  if (!sanitized) {
    // Return all posts when query is empty
    const data = await db.select().from(posts)
      .where(isNull(posts.deletedAt))
      .limit(limit).offset(offset)
      .orderBy(desc(posts.createdAt));
    return { data: data.map((d) => ({ ...d, rank: 0 })), total: data.length, hasMore: false };
  }

  // Convert to tsquery: "hello world" -> "hello & world" (AND), or use websearch_to_tsquery
  const tsQuery = sql`websearch_to_tsquery('english', ${sanitized})`;

  const conditions = [
    sql`${posts.searchVector} @@ ${tsQuery}`,
    isNull(posts.deletedAt),
    ...(authorId ? [sql`${posts.authorId} = ${authorId}`] : []),
  ];

  // Ranked results with ts_rank
  const results = await db
    .select({
      id: posts.id,
      title: posts.title,
      content: posts.content,
      authorName: posts.authorName,
      createdAt: posts.createdAt,
      rank: sql<number>`ts_rank(${posts.searchVector}, ${tsQuery})`,
      // Highlighted snippets
      titleHighlight: sql<string>`ts_headline('english', ${posts.title}, ${tsQuery}, 'MaxWords=10, MinWords=5')`,
      contentSnippet: sql<string>`ts_headline('english', ${posts.content}, ${tsQuery}, 'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>')`,
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(sql`ts_rank(${posts.searchVector}, ${tsQuery}) DESC`)
    .limit(limit + 1)
    .offset(offset);

  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;

  return { data, total: data.length, hasMore };
}
```

---

### 2. ILIKE Search (simpler, no tsvector setup needed)

```typescript
// src/db/queries/ilike-search.ts
import { ilike, or, and, isNull, sql, desc } from 'drizzle-orm';
import { db } from '../index';
import { posts } from '../schema';

export async function searchPostsIlike(query: string, limit = 20) {
  if (!query.trim()) {
    return db.select().from(posts)
      .where(isNull(posts.deletedAt))
      .orderBy(desc(posts.createdAt))
      .limit(limit);
  }

  const term = `%${query.trim()}%`;

  return db.select().from(posts)
    .where(
      and(
        isNull(posts.deletedAt),
        or(
          ilike(posts.title, term),
          ilike(posts.content, term),
          ilike(posts.authorName, term),
        )
      )
    )
    .orderBy(desc(posts.createdAt))
    .limit(limit);
}

// With pg_trgm similarity for typo-tolerant search:
export async function searchPostsTrigram(query: string, limit = 20, threshold = 0.1) {
  return db.execute(sql`
    SELECT *, similarity(title, ${query}) AS sim
    FROM posts
    WHERE deletedAt IS NULL
      AND (
        similarity(title, ${query}) > ${threshold}
        OR title ILIKE ${'%' + query + '%'}
      )
    ORDER BY sim DESC, created_at DESC
    LIMIT ${limit}
  `);
}
```

---

### 3. Search API Route with Filters

```typescript
// src/routes/search.ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validateQuery } from '../lib/route-helpers';
import { searchPosts } from '../db/queries/search';
import { eq, and, gte, lte, isNull, inArray } from 'drizzle-orm';
import { db } from '../db';
import { posts } from '../db/schema';

export const searchRouter = Router();

const searchQuerySchema = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  authorId: z.string().uuid().optional(),
  tags: z.string().optional().transform((v) => v?.split(',').filter(Boolean)),
  published: z.enum(['true', 'false']).optional().transform((v) =>
    v === undefined ? undefined : v === 'true'
  ),
  fromDate: z.string().optional().transform((v) => v ? new Date(v) : undefined),
  toDate: z.string().optional().transform((v) => v ? new Date(v) : undefined),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;

// GET /api/v1/search/posts?q=typescript&tags=react,nodejs&published=true
searchRouter.get(
  '/posts',
  validateQuery(searchQuerySchema),
  asyncHandler(async (req, res) => {
    const params = (req as any).validatedQuery as SearchQuery;
    const { q, limit, offset, authorId, tags, published, fromDate, toDate } = params;

    // Build Drizzle conditions for filters
    const filterConditions = [
      isNull(posts.deletedAt),
      ...(published !== undefined ? [eq(posts.published, published)] : []),
      ...(authorId ? [eq(posts.authorId, authorId)] : []),
      ...(fromDate ? [gte(posts.createdAt, fromDate)] : []),
      ...(toDate ? [lte(posts.createdAt, toDate)] : []),
    ];

    let data: any[];
    let hasMore = false;

    if (q.trim()) {
      const result = await searchPosts({ query: q, limit, offset, authorId });
      data = result.data;
      hasMore = result.hasMore;
    } else {
      const rows = await db.select().from(posts)
        .where(and(...filterConditions))
        .limit(limit + 1)
        .offset(offset)
        .orderBy(posts.createdAt);
      hasMore = rows.length > limit;
      data = hasMore ? rows.slice(0, limit) : rows;
    }

    res.json({
      data,
      meta: {
        query: q,
        hasMore,
        limit,
        offset,
        nextOffset: hasMore ? offset + limit : null,
      },
    });
  })
);

// GET /api/v1/search/autocomplete?q=type — fast suggestions
searchRouter.get(
  '/autocomplete',
  validateQuery(z.object({ q: z.string().min(1), limit: z.coerce.number().default(5) })),
  asyncHandler(async (req, res) => {
    const { q, limit } = (req as any).validatedQuery as { q: string; limit: number };

    const suggestions = await db
      .select({ title: posts.title, id: posts.id, slug: posts.slug })
      .from(posts)
      .where(and(isNull(posts.deletedAt), ilike(posts.title, `${q}%`)))
      .orderBy(posts.title)
      .limit(limit);

    res.json({ data: suggestions });
  })
);
```

---

### 4. Debounced Search Input (React)

```tsx
// src/components/SearchInput.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useDebounce } from 'use-debounce';

interface SearchInputProps {
  placeholder?: string;
  onSearch: (query: string) => void;
  debounceMs?: number;
  isLoading?: boolean;
  initialValue?: string;
}

export function SearchInput({
  placeholder = 'Search...',
  onSearch,
  debounceMs = 300,
  isLoading = false,
  initialValue = '',
}: SearchInputProps) {
  const [value, setValue] = useState(initialValue);
  const [debouncedValue] = useDebounce(value, debounceMs);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onSearch(debouncedValue);
  }, [debouncedValue]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
        {isLoading ? (
          <svg className="w-4 h-4 text-gray-400 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        )}
      </div>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {value && (
        <button
          onClick={() => { setValue(''); onSearch(''); }}
          className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-gray-600"
        >
          x
        </button>
      )}
    </div>
  );
}
```

---

### 5. URL-Synced Filter State (Next.js App Router with nuqs)

```tsx
// src/components/PostFilters.tsx
'use client';

import { parseAsString, parseAsBoolean, parseAsArrayOf, useQueryStates } from 'nuqs';
import { SearchInput } from './SearchInput';

const filterParsers = {
  q: parseAsString.withDefault(''),
  published: parseAsBoolean.withDefault(true),
  tags: parseAsArrayOf(parseAsString).withDefault([]),
  authorId: parseAsString,
};

interface PostFiltersProps {
  allTags: Array<{ id: string; name: string }>;
}

export function PostFilters({ allTags }: PostFiltersProps) {
  const [filters, setFilters] = useQueryStates(filterParsers, {
    history: 'push',
    shallow: false, // triggers server re-render (Next.js)
  });

  const toggleTag = (tagId: string) => {
    setFilters((prev) => ({
      tags: prev.tags.includes(tagId)
        ? prev.tags.filter((t) => t !== tagId)
        : [...prev.tags, tagId],
    }));
  };

  const clearFilters = () => setFilters({ q: '', published: true, tags: [], authorId: null });

  const hasActiveFilters =
    filters.q !== '' || !filters.published || filters.tags.length > 0 || filters.authorId;

  return (
    <div className="space-y-4">
      <SearchInput
        initialValue={filters.q}
        onSearch={(q) => setFilters({ q })}
        placeholder="Search posts..."
      />

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.published}
            onChange={(e) => setFilters({ published: e.target.checked })}
            className="rounded"
          />
          Published only
        </label>
      </div>

      <div>
        <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Tags</p>
        <div className="flex flex-wrap gap-2">
          {allTags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => toggleTag(tag.id)}
              className={[
                'px-3 py-1 rounded-full text-sm border transition-colors',
                filters.tags.includes(tag.id)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-300 text-gray-600 hover:border-blue-400',
              ].join(' ')}
            >
              {tag.name}
            </button>
          ))}
        </div>
      </div>

      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          Clear all filters
        </button>
      )}
    </div>
  );
}
```

---

### 6. Autocomplete / Typeahead Component

```tsx
// src/components/Autocomplete.tsx
'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useDebounce } from 'use-debounce';

interface Suggestion {
  id: string;
  label: string;
  sublabel?: string;
}

interface AutocompleteProps {
  fetchSuggestions: (query: string) => Promise<Suggestion[]>;
  onSelect: (suggestion: Suggestion) => void;
  placeholder?: string;
  debounceMs?: number;
}

export function Autocomplete({
  fetchSuggestions,
  onSelect,
  placeholder = 'Search...',
  debounceMs = 200,
}: AutocompleteProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [debouncedQuery] = useDebounce(query, debounceMs);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchSuggestions(debouncedQuery)
      .then((results) => {
        if (!cancelled) {
          setSuggestions(results);
          setIsOpen(results.length > 0);
          setActiveIndex(-1);
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleSelect = (suggestion: Suggestion) => {
    setQuery(suggestion.label);
    setIsOpen(false);
    setSuggestions([]);
    onSelect(suggestion);
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setIsOpen(true)}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined}
        className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {loading && (
        <div className="absolute right-3 top-2.5 text-gray-400 text-xs">Loading...</div>
      )}

      {isOpen && (
        <ul
          role="listbox"
          className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => handleSelect(s)}
              onMouseEnter={() => setActiveIndex(i)}
              className={[
                'px-4 py-2 cursor-pointer text-sm',
                i === activeIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
              ].join(' ')}
            >
              <div className="font-medium">{s.label}</div>
              {s.sublabel && <div className="text-xs text-gray-400">{s.sublabel}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

### 7. Faceted Search with Count Aggregations

```typescript
// src/db/queries/facets.ts
import { sql, and, isNull, eq } from 'drizzle-orm';
import { db } from '../index';
import { posts, tags, tagsOnPosts, users } from '../schema';

export interface FacetCounts {
  tags: Array<{ id: string; name: string; count: number }>;
  authors: Array<{ id: string; name: string; count: number }>;
  publishedCounts: { published: number; draft: number };
}

export async function getFacets(baseQuery?: string): Promise<FacetCounts> {
  const tsQuery = baseQuery?.trim()
    ? sql`websearch_to_tsquery('english', ${baseQuery})`
    : null;

  const whereCondition = and(
    isNull(posts.deletedAt),
    ...(tsQuery ? [sql`${posts.searchVector} @@ ${tsQuery}`] : [])
  );

  const [tagCounts, authorCounts, publishedCounts] = await Promise.all([
    // Tag facet counts
    db
      .select({
        id: tags.id,
        name: tags.name,
        count: sql<number>`count(${tagsOnPosts.postId})::int`,
      })
      .from(tags)
      .innerJoin(tagsOnPosts, eq(tags.id, tagsOnPosts.tagId))
      .innerJoin(posts, and(eq(tagsOnPosts.postId, posts.id), whereCondition))
      .groupBy(tags.id, tags.name)
      .orderBy(sql`count(${tagsOnPosts.postId}) DESC`)
      .limit(20),

    // Author facet counts
    db
      .select({
        id: users.id,
        name: sql<string>`coalesce(${users.name}, ${users.email})`,
        count: sql<number>`count(${posts.id})::int`,
      })
      .from(users)
      .innerJoin(posts, and(eq(users.id, posts.authorId), whereCondition))
      .groupBy(users.id, users.name, users.email)
      .orderBy(sql`count(${posts.id}) DESC`)
      .limit(10),

    // Published vs draft counts
    db
      .select({
        published: posts.published,
        count: sql<number>`count(*)::int`,
      })
      .from(posts)
      .where(whereCondition)
      .groupBy(posts.published),
  ]);

  const pubMap = Object.fromEntries(publishedCounts.map((r) => [String(r.published), r.count]));

  return {
    tags: tagCounts,
    authors: authorCounts,
    publishedCounts: {
      published: pubMap['true'] ?? 0,
      draft: pubMap['false'] ?? 0,
    },
  };
}
```

---

## Common Mistakes

- **Calling the search API on every keystroke**: Always debounce the input (300ms is a good default). Without debounce, every character change fires a DB query.

- **Using `LIKE '%term%'` without a GIN index**: A leading wildcard (`%term`) forces a full table scan. For contains-search, use `pg_trgm` with a GIN index. For prefix-search, `LIKE 'term%'` can use a B-tree index.

- **Not sanitizing tsquery input**: User input like `'hello & world | :*'` will throw a PostgreSQL syntax error if passed directly to `to_tsquery()`. Always use `websearch_to_tsquery()` which handles user-provided strings safely, or sanitize before `to_tsquery()`.

- **Forgetting `isNull(deletedAt)` in search queries**: The full-text index and facet queries must also exclude soft-deleted records.

- **Returning all columns in autocomplete**: Autocomplete endpoints should return only `id`, `label`, and at most one or two extra fields. Never `SELECT *` for typeahead suggestions.

- **Not persisting filter state to the URL**: Users expect to be able to share, bookmark, or back-navigate to filtered views. Always sync filters to URL query params.

- **Blocking the main thread with Fuse.js on large datasets**: Fuse.js runs synchronously in the browser. For datasets over ~1000 items, run the search in a Web Worker or move to server-side search.

---

## Framework-Specific Notes

### Next.js

- Use `nuqs` for URL search param state — it integrates with the App Router and triggers server-side re-renders when `shallow: false`.
- For Server Components, read search params from `searchParams` prop directly:
  ```tsx
  // app/posts/page.tsx
  export default async function PostsPage({ searchParams }: { searchParams: { q?: string; tags?: string } }) {
    const results = await searchPosts({ query: searchParams.q ?? '', limit: 20 });
    return <PostList results={results} />;
  }
  ```
- Cache facet counts with `unstable_cache` since they change less frequently than search results.

### Express

- Validate and parse all search query params through a Zod schema using the `validateQuery` middleware before they reach the DB layer.
- For high-traffic search endpoints, add a Redis cache with a short TTL (30-60 seconds) keyed by the sanitized query string and filter hash.
- Expose the `X-Total-Count` header for offset-based pagination so clients can render pagination controls without an extra count request.
