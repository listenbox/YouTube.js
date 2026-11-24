#!/usr/bin/env bash
# Publishes this commit's YouTube.js bundle for Listenbox clients as the next
# immutable release, versioned bundle-v<ABI>.<N>. Clients verify the
# Ed25519-signed manifest, its ABI and the bundle digest before evaluating it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
public_key='AR4hVDIhsP1dYU2UfIviBBrTqr7jmawFksR2bjRUTM4='
signature_context='listenbox youtubejs release v1'
repository="${GITHUB_REPOSITORY:?}"
source_commit="${1:?usage: release.sh <source commit>}"
abi="$(tr -d '[:space:]' < .github/bundle/abi)"
prefix="bundle-v$abi."

if [[ "$(git rev-parse HEAD)" != "$source_commit" ]]; then
  echo 'Release requires the checked-out source commit.' >&2
  exit 1
fi
git fetch --quiet origin master --tags
if [[ "$source_commit" != "$(git rev-parse origin/master)" ]]; then
  echo 'Skipping a superseded master update.'
  exit 0
fi

latest=0
while IFS= read -r tag; do
  release="${tag#"$prefix"}"
  [[ "$release" =~ ^[1-9][0-9]*$ ]] || continue
  if [[ "$(git rev-parse "$tag^{commit}")" == "$source_commit" ]]; then
    echo "$source_commit is already released as $tag."
    exit 0
  fi
  if ((release > latest)); then
    latest="$release"
  fi
done < <(git tag --list "$prefix*")
release=$((latest + 1))
tag="$prefix$release"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
aube ci --ignore-scripts
node_modules/.bin/esbuild src/platform/cf-worker.ts \
  --bundle --target=es2020 --keep-names --minify --format=iife --global-name=YouTubeJS \
  --define:global=globalThis --conditions=module --platform=node \
  --outfile="$work/youtubejs.js"

# The seed becomes a PKCS#8 Ed25519 key that never leaves this job's temp dir.
seed="$(printf '%s' "${BUNDLE_SIGNING_SEED:?}" | base64 -d | od -An -tx1 -v | tr -d ' \n')"
if [[ ! "$seed" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'BUNDLE_SIGNING_SEED must be a base64 Ed25519 seed.' >&2
  exit 1
fi
der="302e020100300506032b657004220420$seed"
printf '%b' "${der//??/\\x&}" > "$work/key.der"
derived="$(openssl pkey -inform DER -in "$work/key.der" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')"
if [[ "$derived" != "$public_key" ]]; then
  echo 'BUNDLE_SIGNING_SEED does not match the public key clients pin.' >&2
  exit 1
fi

size="$(stat -c %s "$work/youtubejs.js" 2>/dev/null || stat -f %z "$work/youtubejs.js")"
digest="$(openssl dgst -sha256 -r "$work/youtubejs.js" | cut -d ' ' -f 1)"
jq -cnj \
  --argjson abi "$abi" --argjson release "$release" \
  --argjson sequence "$(git show -s --format=%ct "$source_commit")" \
  --arg sha256 "$digest" --argjson size "$size" --arg commit "$source_commit" \
  '{abi: $abi, release: $release, sequence: $sequence, sha256: $sha256, size: $size, commit: $commit}' \
  > "$work/payload.json"
{ printf '%s\n' "$signature_context"; cat "$work/payload.json"; } > "$work/signed"
openssl pkeyutl -sign -rawin -keyform DER -inkey "$work/key.der" -in "$work/signed" -out "$work/signature"
jq -cnj \
  --arg payload "$(base64 < "$work/payload.json" | tr -d '\n')" \
  --arg signature "$(base64 < "$work/signature" | tr -d '\n')" \
  '{payload: $payload, signature: $signature}' > "$work/youtubejs.json"
rm "$work/key.der"

# A failed earlier run may have left an unpublished draft with this tag.
if [[ "$(gh release view "$tag" --repo "$repository" --json isDraft --jq .isDraft 2>/dev/null)" == true ]]; then
  gh release delete "$tag" --repo "$repository" --yes
fi
version="$(jq -r .version package.json)"
# A draft has no tag, so clients never see the tag before both assets exist.
gh release create "$tag" --repo "$repository" --target "$source_commit" --draft --latest=false \
  --title "$tag: YouTube.js $version (${source_commit:0:7})" \
  --notes "Signed bundle of YouTube.js $version from $source_commit for Listenbox clients with bundle ABI $abi." \
  "$work/youtubejs.js" "$work/youtubejs.json"
gh release edit "$tag" --repo "$repository" --draft=false --latest=false
echo "Published $tag"
