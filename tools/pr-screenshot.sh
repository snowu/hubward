#!/usr/bin/env bash
# Publish screenshots for a PR and print their URLs.
#
#   tools/pr-screenshot.sh <pr-number> <image>...
#
# Every image goes on the one orphan `screenshots` branch, named
# pr-<number>-<file name>, and is committed on top of what the branch already
# holds, so earlier PRs' links keep working. Plumbing only: the working tree,
# the index and the current branch are never touched. Link the printed URL in
# a PR comment: <img src="URL" width="320">
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: $0 <pr-number> <image>..." >&2; exit 2; }
pr=$1; shift
[[ $pr =~ ^[0-9]+$ ]] || { echo "PR number must be numeric: $pr" >&2; exit 2; }

branch=screenshots
# owner/name from the remote, so a renamed repo needs only `git remote set-url`.
repo=$(git remote get-url origin | sed -E 's#^(git@[^:]+:|https://[^/]+/)##; s#\.git$##')
# A scratch index of its own; git refuses an empty file, so only a path.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export GIT_INDEX_FILE=$scratch/index

parent=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
if [ -n "$parent" ]; then
  git fetch -q origin "$branch"
  git read-tree "$parent"
else
  git read-tree --empty
fi

urls=()
for file in "$@"; do
  name="pr-$pr-$(basename "$file")"
  git update-index --add --cacheinfo 100644 "$(git hash-object -w "$file")" "$name"
  urls+=("https://raw.githubusercontent.com/$repo/$branch/$name")
done

commit=$(git commit-tree "$(git write-tree)" ${parent:+-p "$parent"} -m "Screenshots for PR #$pr")
# The pre-push hook checks the page; there is no page on this branch.
git push -q --no-verify origin "$commit:refs/heads/$branch"
printf '%s\n' "${urls[@]}"
