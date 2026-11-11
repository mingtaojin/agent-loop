import { z } from 'zod';
import type { GitHubPort } from '../ports.js';
import type { CollectionRepository, Source } from '../domain.js';

export interface GitHubOptions {
  token: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
}
const issueSchema = z.object({
  node_id: z.string().min(1), number: z.number().int().positive(), html_url: z.string().url(),
  title: z.string(), body: z.string().nullable(), state: z.enum(['open', 'closed']),
  assignees: z.array(z.object({ login: z.string() })),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  type: z.object({ name: z.string() }).nullish(), updated_at: z.string(),
  pull_request: z.object({}).optional(),
});
function source(raw: z.infer<typeof issueSchema>, repository: string): Source {
  return {
    id: raw.node_id, repository, number: raw.number, url: raw.html_url,
    title: raw.title, body: raw.body ?? '', state: raw.state,
    assignees: raw.assignees.map(person => person.login),
    labels: raw.labels.map(label => typeof label === 'string' ? label : label.name),
    nativeType: raw.type?.name ?? null, updatedAt: raw.updated_at,
    isPullRequest: raw.pull_request !== undefined,
  };
}
const commentSchema = z.object({
  node_id: z.string().min(1), html_url: z.string().url(), body: z.string(),
  user: z.object({ login: z.string().min(1) }).nullable(),
  created_at: z.string(), updated_at: z.string(),
});
function nextLink(response: Response, apiUrl: URL): URL | null {
  const next = response.headers.get('link')?.split(',').map(link => link.trim()).find(link => /;\s*rel="next"/.test(link));
  if (!next) return null;
  const target = /^<([^>]+)>/.exec(next)?.[1];
  if (!target) throw new Error('GitHub pagination returned an invalid next link');
  return new URL(target, apiUrl);
}
const pullRequestSchema = z.object({
  draft: z.boolean(), state: z.string(), merged: z.boolean(),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
export class GitHubAdapter implements GitHubPort {
  private readonly apiUrl: URL;
  constructor(private readonly options: GitHubOptions, private readonly fetcher: typeof fetch = fetch) {
    this.apiUrl = new URL(`${(options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')}/`);
  }
  private async request(url: URL): Promise<Response> {
    if (url.origin !== this.apiUrl.origin || !url.pathname.startsWith(this.apiUrl.pathname)) {
      throw new Error('GitHub pagination escaped the configured API');
    }
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
    return response;
  }
  async *list(repository: CollectionRepository): AsyncIterable<Source> {
    if (repository.criteria.states.length === 0) return;
    let url: URL | null = new URL(`repos/${repository.name}/issues?state=all&per_page=100&sort=created&direction=asc`, this.apiUrl);
    if (repository.criteria.states.length === 1) url.searchParams.set('state', repository.criteria.states[0] ?? 'open');
    if (repository.criteria.assigneesAny.length === 1) url.searchParams.set('assignee', repository.criteria.assigneesAny[0] ?? '');
    if (repository.criteria.labelsAll.length) url.searchParams.set('labels', repository.criteria.labelsAll.join(','));
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url.href)) throw new Error('GitHub pagination repeated a page');
      seen.add(url.href);
      const response = await this.request(url);
      const issues = z.array(issueSchema).parse(await response.json());
      for (const issue of issues) yield source(issue, repository.name);
      url = nextLink(response, this.apiUrl);
    }
  }
  async get(repository: string, number: number): Promise<Source> {
    const response = await this.request(new URL(`repos/${repository}/issues/${number}`, this.apiUrl));
    return source(issueSchema.parse(await response.json()), repository);
  }
  async *comments(repository: string, number: number) {
    const issue = await this.get(repository, number);
    if (issue.isPullRequest) throw new Error('GitHub comment collection only accepts Issues');
    let url: URL | null = new URL(`repos/${repository}/issues/${number}/comments?per_page=100`, this.apiUrl);
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url.href)) throw new Error('GitHub pagination repeated a page');
      seen.add(url.href);
      const response = await this.request(url);
      for (const comment of z.array(commentSchema).parse(await response.json())) {
        yield { id: comment.node_id, sourceId: issue.id, url: comment.html_url,
          author: comment.user?.login ?? '[deleted]', body: comment.body,
          createdAt: comment.created_at, updatedAt: comment.updated_at };
      }
      url = nextLink(response, this.apiUrl);
    }
  }
  async verifyPullRequest(input: { url: string; repository: string; branch: string; headSha: string }): Promise<boolean> {
    const url = new URL(input.url);
    const expectedHost = this.apiUrl.hostname === 'api.github.com' ? 'github.com' : this.apiUrl.hostname;
    const path = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== expectedHost || path?.[1]?.toLowerCase() !== input.repository.toLowerCase()) return false;
    const response = await this.request(new URL(`repos/${input.repository}/pulls/${path[2]}`, this.apiUrl));
    const pr = pullRequestSchema.parse(await response.json());
    return pr.draft && pr.state === 'open' && !pr.merged
      && pr.base.repo.full_name.toLowerCase() === input.repository.toLowerCase()
      && pr.head.repo?.full_name.toLowerCase() === input.repository.toLowerCase()
      && pr.head.ref === input.branch && pr.head.sha === input.headSha;
  }
}
