import {shellQuote} from './preview-plan.ts';
/** Initialize only a genuinely empty remote; never treat auth/network failures as empty. */
export function emptyRepoBootstrap(baseBranch:string):string {
 return `
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    REMOTE_HEADS=$(git ls-remote --heads origin) || { echo "Cannot inspect repository branches"; exit 1; }
    if [ -z "$REMOTE_HEADS" ]; then
        echo "Initializing empty repository base branch"
        git check-ref-format --branch ${shellQuote(baseBranch)} >/dev/null || exit 1
        git symbolic-ref HEAD ${shellQuote('refs/heads/'+baseBranch)} || exit 1
        git -c user.name='LFG AI' -c user.email='ai@lfg.dev' commit --allow-empty --only -m 'Initialize project repository' || exit 1
        git push -u origin ${shellQuote(baseBranch)} || exit 1
    else
        git fetch origin || exit 1
        git checkout ${shellQuote(baseBranch)} || { echo "Base branch unavailable; existing remote branches were preserved"; exit 1; }
    fi
fi
`;
}
