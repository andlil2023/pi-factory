import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

// Disable index refresh and fsmonitor hooks. Never display Git's potentially sensitive output.
async function git(cwd:string, args:string[]):Promise<{ok:boolean; output:string; code:number|null}> {
  return new Promise(done => {
    const child=spawn('git', ['-c','core.fsmonitor=false',...args], {cwd, shell:false, windowsHide:true, env:{...process.env, GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0'}, stdio:['ignore','pipe','ignore']});
    let output=''; let overflow=false;
    child.stdout.on('data', (chunk:Buffer) => { output+=chunk.toString(); if (output.length>1024*1024) { overflow=true; child.kill(); } });
    const timer=setTimeout(() => child.kill(), 10000);
    child.on('error', () => { clearTimeout(timer); done({ok:false,output:'',code:null}); });
    child.on('close', code => { clearTimeout(timer); done({ok:code===0 && !overflow,output:output.trim(),code:overflow?null:code}); });
  });
}

export async function diagnoseRepository(repository:string, blockers:string[], warnings:string[]):Promise<void> {
  let repo:string;
  try { repo=await realpath(resolve(repository)); } catch { blockers.push('Repository: provide an existing Git working-tree root with --repo.'); return; }
  const root=await git(repo,['rev-parse','--show-toplevel']);
  if (!root.ok) { blockers.push('Repository: select a Git working-tree root with --repo.'); return; }
  try {
    if (await realpath(root.output)!==repo) blockers.push('Repository: pass the Git working-tree root, not a subdirectory, with --repo.');
  } catch { blockers.push('Repository: unable to resolve the working-tree root; inspect the repository.'); }
  if (!(await git(repo,['rev-parse','--verify','HEAD'])).ok) blockers.push('Repository: create an initial commit before starting a run.');
  const gitDir=await git(repo,['rev-parse','--absolute-git-dir']);
  if (!gitDir.ok) blockers.push('Worktree: unable to inspect Git operations; check repository permissions.');
  else for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG']) {
    try {
      await lstat(resolve(gitDir.output,marker));
      blockers.push('Worktree: unfinished Git operation detected; inspect and resolve it using Git before proceeding.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') { blockers.push('Worktree: unable to inspect Git operations; check repository permissions.'); break; }
    }
  }
  // Status can execute clean/process filters. Fail closed if any driver is configured.
  const filters=await git(repo,['config','--name-only','--get-regexp','^filter\\..*\\.(clean|process)$']);
  if (filters.code!==1) blockers.push('Worktree: status inspection unavailable when Git clean filters are configured or cannot be inspected; inspect status safely before proceeding.');
  else {
    // Avoid recursive status in submodules, whose own configuration may contain filters.
    const status=await git(repo,['status','--porcelain','--untracked-files=normal','--ignore-submodules=all']);
    if (!status.ok) blockers.push('Worktree: unable to inspect status; check Git and repository permissions.');
    else if (status.output) blockers.push('Worktree: commit, stash, or otherwise resolve changes before starting a run.');
    if ((await git(repo,['ls-files','--stage'])).output.split('\n').some(line=>line.startsWith('160000 '))) warnings.push('Worktree: submodule changes were not inspected; inspect submodules safely before proceeding.');
  }
  const worktrees=await git(repo,['worktree','list','--porcelain']);
  if (!worktrees.ok) warnings.push('Worktrees: unable to inspect registrations; check Git worktree list manually.');
  else if (/^(prunable|locked)(?: |$)/m.test(worktrees.output)) warnings.push('Worktrees: locked or prunable registrations exist; inspect git worktree list before proceeding.');
}
