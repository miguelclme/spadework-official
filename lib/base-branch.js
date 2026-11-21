'use strict';

// The branch a Bug is planned and implemented from, found in the work item's
// development links. The rules are above resolve(). No git and no Azure DevOps
// calls here: the skill reads the pull requests, and the caller says whether a
// merge commit is already in the main branch.

// vstfs:///Git/Ref/<projectId>%2F<repoId>%2FGB<branch>
// vstfs:///Git/Commit/<projectId>%2F<repoId>%2F<commit>
// vstfs:///Git/PullRequestId/<projectId>%2F<repoId>%2F<pull request id>
// The ids are GUIDs. Azure DevOps writes %2F in capitals in a work item and
// in lowercase in a pull request's own artifactId.
const LINK = /^vstfs:\/\/\/Git\/(Ref|Commit|PullRequestId)\/([^%/]+)%2F([^%/]+)%2F(.+)$/i;
const KINDS = { ref: 'branch', commit: 'commit', pullrequestid: 'pull_request' };

// { kind: 'branch' | 'commit' | 'pull_request', project, repo, branch | commit | id }, or null.
// A branch with a slash may come with %2F in it: only the first two %2F split the link.
function parseLink(url) {
  const match = String(url ?? '').match(LINK);
  if (!match) return null;
  const kind = KINDS[match[1].toLowerCase()];
  const link = { kind, project: match[2].toLowerCase(), repo: match[3].toLowerCase() };
  if (kind === 'commit') return { ...link, commit: match[4] };
  if (kind === 'pull_request') return /^\d+$/.test(match[4]) ? { ...link, id: Number(match[4]) } : null;
  if (!/^GB/i.test(match[4])) return null;
  try {
    const branch = decodeURIComponent(match[4].slice(2));
    return branch ? { ...link, branch } : null;
  } catch {
    return null;
  }
}

// The links to one repo, by its id: { branches: [name], pull_requests: [{ id, project, repo }] }.
// A link to another repo or project is left out: it can't be read from this one.
function linksOfRepo(urls, repoId) {
  const wanted = String(repoId ?? '').trim().toLowerCase();
  const out = { branches: [], pull_requests: [] };
  if (!wanted) return out;
  for (const link of (urls || []).map(parseLink)) {
    if (!link || link.repo !== wanted) continue;
    if (link.kind === 'branch' && !out.branches.includes(link.branch)) out.branches.push(link.branch);
    if (link.kind === 'pull_request' && !out.pull_requests.some((pr) => pr.id === link.id)) out.pull_requests.push({ id: link.id, project: link.project, repo: link.repo });
  }
  return out;
}

// refs/heads/add_graphify → add_graphify
const shortRef = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');

// Azure DevOps sends a pull request's status as a number (1 active, 2 abandoned,
// 3 completed) or as a word.
function statusOf(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === '1' || value === 'active') return 'active';
  if (value === '2' || value === 'abandoned') return 'abandoned';
  if (value === '3' || value === 'completed') return 'completed';
  return null;
}

// Where the Bug is. input:
//   branches: the linked branches
//   pullRequests: [{ id, status, source, target, merge_commit } | { id, error }], read by the skill
//   mainBranch, inMain(commit): whether the commit is already in the main branch
// A linked branch wins. Without one, an active pull request gives its source
// branch, and a completed one the main branch, unless it was merged into
// another branch whose merge commit isn't in main yet: then that branch. An
// abandoned one is ignored. Nothing left means the main branch.
// Returns { branch, why }, { ambiguous: [{ branch, why }] } or { problem }.
function resolve({ branches = [], pullRequests = [], mainBranch, inMain = () => false }) {
  const found = [];
  const add = (branch, why) => {
    if (!found.some((entry) => entry.branch === branch)) found.push({ branch, why });
  };
  for (const branch of branches) add(branch, 'it is linked to the work item');
  if (!found.length) {
    const failed = pullRequests.filter((pr) => pr.error);
    if (failed.length) return { problem: `Couldn't read pull request ${failed.map((pr) => pr.id).join(', ')}: ${failed[0].error}` };
    for (const pr of pullRequests) {
      const status = statusOf(pr.status);
      const source = shortRef(pr.source);
      const target = shortRef(pr.target);
      if (status === 'active' && source) add(source, `pull request ${pr.id} is open`);
      if (status === 'completed' && target) {
        const intoMain = target === mainBranch || inMain(pr.merge_commit);
        add(intoMain ? mainBranch : target, intoMain ? `pull request ${pr.id} was merged into ${mainBranch}` : `pull request ${pr.id} was merged into ${target}, which ${mainBranch} doesn't have yet`);
      }
    }
  }
  if (!found.length) return { branch: mainBranch, why: 'no branch or open pull request is linked' };
  return found.length === 1 ? found[0] : { ambiguous: found };
}

// The Base branch saved on a row (or on an implementing record), trimmed; '' when there is none.
const rowBaseBranch = (row) => String((row && row.base_branch) || '').trim();

module.exports = { rowBaseBranch, parseLink, linksOfRepo, resolve, shortRef, statusOf };
