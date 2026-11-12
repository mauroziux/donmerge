# 005 — Reducir trabajo repetido sin perder defectos

**Estado:** PARCIAL — U1 hecha (config/skills una vez por snapshot vía DTO, prioridad determinista de contexto, ref explícito en contents). U3 (incremental/cache) y U4 (selección por ablación live): TODO.

## Objetivo

Mejorar latencia y coste usando menos trabajo innecesario, no menos cobertura. El operador eligió profundidad adaptativa. Mantener memoria y arquitectura de despliegue existentes.

## Evidencia actual

- `src/workflows/code-review/code-review-workflow.ts:357-395` carga config/skills en fetch-pr-data, pero no los incluye en PrData; `:456-516` vuelve a cargarlos en prepare-files.
- `src/workflows/code-review/github-api.ts:909-927` lee hasta 15 rutas de contexto en paralelo. El `if (context[key]) return` ocurre antes de completar fetch; alternativas de ESLint/Prettier pueden sobrescribirse por orden de llegada, no por prioridad declarada.
- `src/workflows/code-review/prompts/builder.ts:141-165,230-254,317-370` incluye formato/ejemplo y documentación; los reruns no reutilizan evidencia del snapshot ni distinguen contexto afectado.
- `src/lib/llm-providers.ts:135-176` define Gateway primario y fallbacks; no hay selección por precisión/recall medidos. Config viva del Gateway y precios actuales no fueron inspeccionados.
- `docs/PRODUCTION-VALIDATION-2026-08-21.md` registra generaciones históricas de 289–468 s. No atribuir todo ese tiempo al sandbox o al Gateway sin instrumentación.

## Alcance

`src/workflows/code-review/{code-review-workflow,github-api,review-context,review-model-runner,types}.ts`, prompts y tests; `src/lib/llm-providers.ts` solo para adaptadores/config de evaluación. Nuevos helpers `review-cache.ts` y `review-incremental.ts` bajo code-review. Scripts/dataset de evaluación de 001. Actualizar docs de revisión si cambia comportamiento.

No tocar persistencia/algoritmos de memoria, triage, contratos auth ni dependencias de plataforma mayores. Preferir cache efímera por run o storage ya disponible por PR antes de introducir infraestructura adicional. Si almacenamiento necesario supera límites actuales, medir y plantear ese cambio por separado, no añadir R2/Vectorize por anticipado.

## Unidades de implementación

### U1 — Quitar duplicación y controlar prioridad

Cargar config/skills una vez por snapshot confiable, pasar un DTO serializable y rehidratar Maps si procede. Separar datos de credenciales; no introducir tokens en hashes/artefactos de contexto. Memoizar fetches por tenant/repo/ref/path dentro del run.

Conservar paralelismo de lecturas independientes con límite explícito; seleccionar configuración por prioridad declarada después de tener los resultados, no por orden de llegada. Paralelizar contexto/threads cuando no dependan entre sí. No combinar llamadas cuya corrección dependa de un efecto previo.

**Verificar:** `npm run test -- src/workflows/code-review/__tests__/github-api.test.ts src/workflows/code-review/__tests__/code-review-workflow.test.ts` (extender/crear según suite vigente): cada recurso se lee una vez por snapshot; orden de respuesta invertido no cambia configuración; serialización/replay no pierde skills; 404 distingue recurso ausente de auth/rate-limit y se refleja en cobertura si es necesario.

### U2 — Presupuesto de contexto y salida

Medir tokens por sección. Priorizar código/contratos relevantes frente a estilo, README completo o ejemplo repetido. Reservar salida para findings y cobertura. Sacar render de comentarios al formatter de 003; no añadir otra llamada LLM solo para escribir un resumen agradable.

Agrupar hunks por dependencias y riesgo, no solamente por tamaño. Concurrencia pequeña y configurable en batches independientes; inicialmente secuencial donde compartan estado o herramientas. No lanzar diez sandboxes para “acelerar” sin medir cuotas/latencia p95 bajo carga.

**Verificar:** fixtures largos, varios módulos relacionados, cambio en interfaz compartida; todos los bloques elegibles revisados o pendientes explícitos. Benchmark de mismo corpus mantiene calidad y cobertura, con tokens/sección y coste marginal de cada pasada.

### U3 — Incremental conservador y cache segura

Reutilizar contexto leído, no veredictos por similitud de texto. Clave mínima: tenant, repo, base/head o digest del contenido, dependencias relevantes, versión de prompt/modelo/política, configuración y versión/digest opaco de memoria consumida. No registrar contenido de memoria en clave/logs.

Rerun incremental analiza cambios desde el último snapshot revisado **y** los consumers/dependencias afectados. Revalidar findings abiertos y los supuestamente resueltos. Invalidar ante cambio de base, force-push no comparable, contrato/config/shared dependency, nueva versión de memoria/prompt/modelo o grafo insuficiente. En ausencia de evidencia de independencia, revisión completa.

Un archivo sin cambios puede estar afectado por el cambio de su proveedor. Nunca limitar incremental a `git diff previousHead..head` sin cierre de impacto. Reusar hallazgos solo si condiciones y dependencias siguen verificadas para el snapshot nuevo; coverage no se hereda por nombre de archivo.

Cache con namespace por tenant/repo, expiración y borrado según política existente. Nada de compartir prompts/código entre clientes. Fallo de cache → recomputar, no inventar resultado. No cachear conclusiones de error como reviews limpios.

**Verificar:** `review-cache.test.ts` y `review-incremental.test.ts` (nuevos): dos tenants, cambio de dependencia sin tocar consumer, force-push, retarget, memoria/version distinta, cache vencida/corrupta, resolución explícita de issue y rerun sin cambios.

### U4 — Elegir motor/modelos con evidencia

Ablaciones sobre el mismo holdout de 001: pipeline actual; contexto optimizado; incremental; modo adaptativo con verificador. Seleccionar configuración por frontera precisión/recall/coste/p95, no ranking comercial. Confirmar credenciales y modelo efectivamente servido; configurar fallback real para errores, no cambiar de modelo porque no encontró suficientes bugs.

Un experimento opcional puede comparar invocación HTTP directa/structured output con Flue para análisis sin herramientas. No migrar antes: setup podría ser parte pequeña de latencia, y cambiar transporte puede perder herramientas, repair o semántica del proveedor. Debe conservar timeout/cancelación/esquema/telemetría y pasar las mismas pruebas. Si no hay mejora material, descartarlo y conservar Flue.

Cooldown de proveedores por auth/cuota puede evitar fallbacks condenados, pero alcance por credencial/tenant y duración acotada: no hacer que el error de un cliente deshabilite otro. Implementarlo solo si el baseline muestra repetición relevante.

**Verificar:** modelo primario y fallback contra misma evaluación y fallos controlados; nunca alterar `CODEX_MODEL`/ruta viva sin autorización de activación. Los scripts de sincronización de defaults en CI deben seguir pasando si posteriormente se decide cambiar defaults.

## Criterios de aceptación

- [ ] `npm run typecheck`, `npm run test`, `git diff --check` pasan.
- [ ] Sin lecturas duplicadas de config/skills en un run y prioridad determinista.
- [ ] Objetivo inicial: ≥30% menos tokens de entrada en reruns elegibles, sin bajar precisión ≥90%, recall crítico/alto ≥80% ni perder centinelas. Si no se alcanza, reportar medida real y no promover la optimización por intuición.
- [ ] Comparación p50/p95 y coste por PR estratificada por tamaño/riesgo, mismos casos y estados de cache publicados. Sin empeorar p95 del estrato optimizado más de 10% frente al baseline congelado.
- [ ] Toda invalidación sensible se prueba y cache no cruza tenants.
- [ ] El modo completo sigue disponible y es fallback ante duda; ninguna mejora esconde cobertura parcial.

## Riesgos y mantenimiento

Incremental es la última optimización porque su error típico son falsos negativos silenciosos. Incluir canaries completos periódicos para medir discrepancias respecto a incremental, sin publicar comentarios duplicados. No reutilizar estado del sandbox entre tenants. Revalidar resultados tras cambios de modelos, prompts o contrato de memoria. Desactivar incremental si pierde un centinela o aparece inconsistencia de cobertura; mantener mejoras de U1 independientemente. Rama de tarea, commits por unidad, draft PR; presupuesto y canary autorizados separadamente.
