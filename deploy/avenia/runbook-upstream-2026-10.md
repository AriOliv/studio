# Runbook: Studio upstream 2026-10 (prod GKE studio-std, ns studio)

Branch `integrate/upstream-2026-10` @ 89a41133eb (worktree ~/Aol/studio-integrate-10)
Imagens: api/worker `gcr.io/ari-teste-492120/studio-peruser-sync:89a41133eb`
         web `gcr.io/ari-teste-492120/studio-nginx-peruser-sync:89a41133eb`
Rollback refs: api/worker `studio-peruser:3a1b535a8b`, web `studio-nginx-peruser:c6b9af4fd8`
Comando antigo: `bun run deco --no-local-mode` (api-0, api-1, worker)

## Ensaio (2026-10-19, clone pg_dump do database studio)
- migrate.js: OK, 171 -> 255, ultima `254-codex-subscriptions`, indices parciais de downstream_tokens intactos.
- Esperado no clone: connections 350 -> 296. Sao as 54 conexoes semente do registry
  (deco-registry / mcp-registry / private-registry-monitor), removidas de proposito por
  `221-remove-private-registry`. Nao e perda de dado de usuario.
- Boot com CMD novo: OK. Login por sessao, COLLECTION_CONNECTIONS_LIST, proxy MCP
  (Temporal: initialize, tools/list 32, list_workflows) OK.
- Erro FK `conn_agg_child_fk` (<org>_self ausente para avenia-io e ifood-privado):
  JA ACONTECE em prod hoje (36x no worker em 2026-10-10). Nao e regressao.
- Burst de "pool saturated" no boot (~1 min, warm-up de caches). Passa sozinho.
- NAO testado no ensaio de proposito: refresh OAuth real (todos os tokens do clone estavam
  expirados; refresh a partir do clone poderia rotacionar o refresh_token de prod).
  Coberto por integration tests (per-user single-flight + upsert concorrente).
- ROLLBACK: imagem antiga NAO boota no schema migrado
  (`corrupted migrations: previously executed migration 170-zz-per-user-oauth is missing`).
  => rollback real = restaurar o backup on-demand do passo 2 + imagens/comando antigos.

## Janela
1. Aviso no Slack (horario, ~30 min, Studio fora do ar).
2. Backup on-demand do Cloud SQL `litellm-pg` (rede de seguranca, NAO e o rollback:
   a instancia tambem tem litellm, openwebui e whatsappmcp, e restaurar a instancia voltaria
   todos eles no tempo):
   `gcloud sql backups create --instance=litellm-pg --project=ari-teste-492120 --description=pre-upstream-2026-10`
3. `kubectl -n studio scale deploy/studio deploy/studio-worker --replicas=0` e esperar 0 pods.
3b. Com o Studio parado: `pg_dump -Fc` SO do database `studio` (pod postgres:16 efemero, mesmo
    metodo do ensaio, ~50 MB). Guardar o dump fora do pod (GCS). Este e o rollback.
4. Renomear a migracao (pod psql efemero com DATABASE_URL do secret, sem imprimir):
   `UPDATE kysely_migration SET name='170-zz-per-user-oauth' WHERE name='171-per-user-oauth';` -> UPDATE 1
5. Job one-off `migrate` com a imagem nova, `envFrom` studio-config + studio-secrets,
   comando `bun run node_modules/decocms/dist/server/migrate.js`. Esperar "Migrations completed."
   Conferir: `select count(*), max(name) from kysely_migration` -> 255 | 254-codex-subscriptions.
6. Imagens + comando:
   - studio: web = imagem web nova; api-0 e api-1 = imagem api nova e
     command `["bun","run","node_modules/decocms/dist/server/server.js"]`
   - studio-worker: imagem api nova + mesmo command
   Escalar de volta (studio 1, worker 2).
7. Esperar ~1 min de 502 do GCLB + warm-up antes de diagnosticar.
8. Smoke: login no browser, lista de conexoes, connect per_user (Notion) e shared,
   Ada chamando Temporal e Zendesk, WhatsApp instance_state.
9. Logs da primeira hora: zero `corrupted migrations`, zero `ON CONFLICT`/42P10.
10. Exportar e versionar os manifests de studio e studio-worker.

## Rollback (se 8/9 falhar)
scale 0 -> `pg_restore --clean --if-exists -d studio` do dump do passo 3b (so o database studio;
NUNCA restaurar o backup da instancia) -> imagens e comando antigos -> scale up.
Ensaiar o pg_restore desse dump num banco descartavel antes da janela.
