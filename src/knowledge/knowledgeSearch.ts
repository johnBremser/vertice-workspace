import {
  VERTICE_KNOWLEDGE_BASE,
  type KnowledgeArticle,
  type KnowledgeCategoryId,
} from './verticeKnowledgeBase';

function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface KnowledgeSearchHit {
  article: KnowledgeArticle;
  score: number;
}

export function searchKnowledgeArticles(
  query: string,
  category?: KnowledgeCategoryId | 'all',
): KnowledgeSearchHit[] {
  const pool =
    category && category !== 'all'
      ? VERTICE_KNOWLEDGE_BASE.filter((a) => a.category === category)
      : VERTICE_KNOWLEDGE_BASE;

  const trimmed = query.trim();
  if (!trimmed) {
    return pool.map((article) => ({ article, score: 1 }));
  }

  const normalizedQuery = normalizeForSearch(trimmed);
  const tokens = normalizedQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const hits: KnowledgeSearchHit[] = [];

  for (const article of pool) {
    const titleNorm = normalizeForSearch(article.title);
    const summaryNorm = normalizeForSearch(article.summary);
    const tagsNorm = normalizeForSearch(article.tags.join(' '));
    const filesNorm = normalizeForSearch(article.relatedFiles.join(' '));
    const bodyNorm = normalizeForSearch(article.bodyMarkdown);

    let score = 0;

    if (titleNorm.includes(normalizedQuery)) score += 20;
    if (tagsNorm.includes(normalizedQuery)) score += 16;
    if (summaryNorm.includes(normalizedQuery)) score += 12;
    if (filesNorm.includes(normalizedQuery)) score += 10;
    if (bodyNorm.includes(normalizedQuery)) score += 6;

    for (const token of tokens) {
      if (titleNorm.includes(token)) score += 8;
      if (tagsNorm.includes(token)) score += 6;
      if (summaryNorm.includes(token)) score += 4;
      if (filesNorm.includes(token)) score += 4;
      if (bodyNorm.includes(token)) score += 2;
    }

    if (score > 0) {
      hits.push({ article, score });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title));
  return hits;
}
