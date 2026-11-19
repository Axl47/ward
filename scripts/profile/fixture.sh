#!/bin/sh
# fixture.sh DIR: create the throwaway fixture repo the profile runs against:
# a minimal React app served by Vite, a Postgres 17 compose stack with a
# healthcheck, and a `node --test` suite that writes and reads that Postgres.
# Ports come from VITE_PORT / PGPORT (default 5173 / 5432), so the same tree
# runs warded on the defaults and unwarded on distinct ports.
set -eu
dir=$1
mkdir -p "$dir/src" "$dir/test" "$dir/public"
cd "$dir"

cat > package.json <<'JSON'
{
  "name": "ward-profile-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "node --test test/"
  },
  "dependencies": {
    "pg": "^8.16.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.1.0",
    "vite": "^7.2.0"
  }
}
JSON

# pnpm 10+ refuses to install until esbuild's build script is allowed.
printf 'allowBuilds:\n  esbuild: true\n' > pnpm-workspace.yaml

cat > vite.config.js <<'JS'
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.VITE_PORT ?? 5173), strictPort: true },
});
JS

cat > index.html <<'HTML'
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>fixture</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
HTML

cat > src/main.jsx <<'JSX'
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")).render(<h1>fixture</h1>);
JSX

cat > compose.yaml <<'YAML'
services:
  db:
    image: docker.io/library/postgres:17
    environment:
      POSTGRES_PASSWORD: fixture
    ports:
      - "${PGPORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 60
volumes:
  pgdata:
YAML

cat > test/db.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const ROWS = 300;

test("insert and select through pg", async () => {
  const client = new pg.Client({
    host: "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: "postgres",
    password: "fixture",
  });
  await client.connect();
  try {
    await client.query("DROP TABLE IF EXISTS items; CREATE TABLE items (id serial PRIMARY KEY, name text)");
    for (let i = 0; i < ROWS; i++) await client.query("INSERT INTO items (name) VALUES ($1)", [`item ${i}`]);
    for (let i = 1; i <= ROWS; i++) {
      const { rows } = await client.query("SELECT name FROM items WHERE id = $1", [i]);
      assert.equal(rows[0].name, `item ${i - 1}`);
    }
  } finally {
    await client.end();
  }
});
JS

# Static files Vite serves as-is: a tiny one for request latency, a large one
# for throughput.
echo pong > public/ping.txt
head -c 64M /dev/zero > public/big.bin
printf 'node_modules\n' > .gitignore

git init -q -b main
git add -A
git -c user.name=fixture -c user.email=fixture@localhost commit -qm "fixture"
