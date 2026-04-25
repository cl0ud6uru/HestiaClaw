const SEARXNG_URL = process.env.SEARXNG_URL || ''

export function registerWebSearch(registry) {
  if (!SEARXNG_URL) return false

  registry.register(
    'web_search',
    'Search the web for current information. Use for questions about recent events, facts, or anything you are uncertain about.',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
    async ({ query }) => {
      const url = new URL('/search', SEARXNG_URL)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('engines', 'google,bing,duckduckgo')

      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
      })

      if (!response.ok) {
        throw new Error(`SearXNG returned HTTP ${response.status}`)
      }

      const data = await response.json()
      const results = (data.results || []).slice(0, 5)

      if (!results.length) return 'No results found.'

      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content || ''}`)
        .join('\n\n')
    },
    {
      source: 'builtin',
      displayName: 'Web search',
      kind: 'read',
      risk: 'low',
      timeoutMs: 15000,
    },
  )

  return true
}
