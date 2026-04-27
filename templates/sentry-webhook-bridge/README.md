# DonMerge Sentry Webhook Bridge

Worker de Cloudflare que recibe webhooks de Sentry (nuevos issues) y los reenvía como eventos `repository_dispatch` a GitHub, activando automáticamente el pipeline de triage de DonMerge.

```
Sentry (nuevo issue)
    │
    ▼
Cloudflare Worker (donmerge-sentry-bridge)
    │  Valida firma HMAC-SHA256 del webhook
    │  Transforma payload → GitHub repository_dispatch
    ▼
GitHub repo (donmerge-sentry-triage.yml)
    │  Se activa con repository_dispatch tipo: sentry-issue
    ▼
DonMerge reusable workflow (sentry-triage.yml)
    │  POST /api/v1/sentry/triage → polls → resultado
    ▼
GitHub Step Summary
```

## Requisitos previos

- Cuenta de [Cloudflare](https://dash.cloudflare.com/) (el plan gratuito alcanza)
- Acceso de administrador a un proyecto en Sentry
- Acceso de administrador al repositorio de GitHub donde corre DonMerge
- Un GitHub Personal Access Token (PAT) con scope `repo`

## Paso 1 — Desplegar el Worker

1. Copia esta carpeta a tu máquina local:

```bash
cp -r templates/sentry-webhook-bridge sentry-bridge
cd sentry-bridge
```

2. Instala Wrangler y autentícate:

```bash
npm install -g wrangler
wrangler login
```

3. Configura los secretos:

```bash
# Secreto de firma del webhook (lo obtienes en Sentry → Settings → Integrations → Webhooks)
wrangler secret put SENTRY_WEBHOOK_SECRET

# Token de GitHub con scope repo
wrangler secret put GITHUB_TOKEN

# Repositorio destino en formato owner/repo
wrangler secret put GITHUB_REPO
```

4. (Opcional) Configura la rama por defecto para el triage:

Si necesitas que el triage se haga contra una rama distinta a `main` (por ejemplo `develop`), añade la variable de entorno:

```bash
wrangler secret put DEFAULT_SHA
# Ingresa: develop
```

5. Despliega:

```bash
wrangler deploy
```

Toma nota de la URL del worker, será algo como:
```
https://donmerge-sentry-bridge.<tu-subdominio>.workers.dev
```

## Paso 2 — Configurar el webhook en Sentry

1. Ve a **Sentry → Settings → Integrations → Webhooks**
2. Añade la URL de tu worker:
   ```
   https://donmerge-sentry-bridge.<tu-subdominio>.workers.dev
   ```
3. En "Events", selecciona únicamente **Issue Created** (event `event_created`)
4. Guarda la configuración

## Paso 3 — Obtener el secreto de firma

Sentry firma cada webhook con un secreto compartido usando HMAC-SHA256. Este secreto aparece en la configuración del webhook en Sentry (campo **Signing Secret**).

Asegúrate de que el valor que configuraste en `SENTRY_WEBHOOK_SECRET` coincida exactamente con el que muestra Sentry.

## Paso 4 — Probar

### Opción A: Activación manual en GitHub

Ve a tu repositorio → **Actions** → **DonMerge Sentry Triage** → **Run workflow** e ingresa una URL de issue de Sentry.

### Opción B: Probar con un error real

Lanza un error en tu aplicación que esté monitoreada por Sentry y verifica:

1. En **Sentry** → el issue aparece en el dashboard
2. En **Cloudflare** → el worker registró un `200 OK` en los logs
3. En **GitHub** → el workflow "DonMerge Sentry Triage" se ejecutó

## Solución de problemas

### `401 Unauthorized` (firma inválida)

- Verifica que `SENTRY_WEBHOOK_SECRET` coincida con el Signing Secret en Sentry
- Asegúrate de no tener espacios al inicio o final del secreto
- Revisa los logs del worker en `wrangler tail`

### `500 GitHub API error`

- Verifica que `GITHUB_TOKEN` sea un PAT válido con scope `repo`
- Verifica que `GITHUB_REPO` tenga el formato correcto: `owner/repo`
- Comprueba que el token no haya expirado

### No se activa el workflow en GitHub

- Verifica que el archivo `.github/workflows/donmerge-sentry-triage.yml` exista en la rama principal
- El workflow debe tener `on: repository_dispatch: types: [sentry-issue]`
- Revisa los logs del worker con `wrangler tail` para ver la respuesta de GitHub
- Asegúrate de que `GITHUB_TOKEN` tenga permisos sobre el repositorio correcto
