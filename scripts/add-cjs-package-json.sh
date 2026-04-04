#!/bin/sh
# Adds {"type":"commonjs"} package.json to each CJS dist directory
# so Node.js treats .js files as CommonJS despite root "type":"module"
for d in packages/*/dist/cjs; do
  mkdir -p "$d"
  printf '{"type":"commonjs"}\n' > "$d/package.json"
done
