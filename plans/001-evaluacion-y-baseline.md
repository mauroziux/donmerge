# 001 — Evaluación reproducible antes de optimizar el reviewer

**Estado:** TODO · **Prioridad:** P1, prerrequisito de cambios de calidad · **Base:** `8fd3eef` · **Esfuerzo:** M inicial, más etiquetado.

## Objetivo

Saber si DonMerge encuentra defectos verdaderos y si una mejora aumenta su valor sin disparar falsos positivos, latencia o coste. Decisión del operador: profundidad adaptativa; no más comentarios por sí mismos. Memoria/feedback D1 fuera de alcance.

## Estado actual verificado

- `src/workflows/code-review/review-model-runner.ts:207-231` devuelve el primer review válido; un segundo modelo es fallback por error, no verificación de calidad.
- `src/workflows/code-review/__tests__/review-model-runner.test.ts:9-23` utiliza una respuesta simulada: `overview: 'The change is coherent.'`, `lineComments: []`. Comprueba mecánica, no capacidad de detectar bugs.
- `vitest.config.ts:5` recoge `src/**/*.test.ts`; no se localizó dataset/runner de evaluación de detección ni suite directa del workflow. `src/app.test.ts` lo sustituye por un mock.
- `docs/PRODUCTION-VALIDATION-2026-08-21.md` contiene casos candidatos e incidentes históricos, no etiquetas auditadas ni métricas actuales.

## Alcance y convenciones

Crear `src/workflows/code-review/evaluation/` y tests en `src/workflows/code-review/__tests__/evaluation.test.ts`. Fixtures sintéticos/redactados en `src/workflows/code-review/__tests__/fixtures/evaluation/`. Runner local en `scripts/evaluate-reviews.ts`; si se necesita ejecutor TS, declararlo explícitamente en `package.json` y lock, no asumir una dependencia transitiva. Añadir scripts documentados `eval:review` y `eval:review:compare` durante implementación: **no existen aún**.

Instrumentación mínima en `review-model-runner.ts` y `code-review-workflow.ts`; evitar cambiar lógica del review en este slice. Seguir funciones puras y tests `describe/it/expect/vi` de `__tests__/processor-utils.test.ts`; no introducir plataforma externa de evals inicialmente.

Fuera: migraciones, sistema de memoria, nuevos modelos por defecto, despliegue, envío automático de código privado a otro proveedor. No versionar snapshots privados crudos en este repo.

## Unidades de implementación

### U1 — Caracterizar fallos y crear corpus

1. Empezar por una muestra autorizada de reviews reales: aceptados, rechazados, sin hallazgos, incompletos y errores de infraestructura. Si no hay permiso/datos, usar fixtures sintéticos y marcar resultados como no representativos de producción.
2. Leer diff y código relacionado antes de etiquetar. Categorías iniciales observables: contexto insuficiente, defecto omitido, falso positivo, truncamiento, defecto preexistente, sugerencia equivocada, output inválido y ejecución incompleta. Refinarlas tras inspeccionar ejemplos; no construir jueces genéricos primero.
3. Crear inicialmente 30–50 casos adjudicados con casos limpios difíciles y pares defectuoso/corregido; ampliar a 100+ según cobertura de lenguajes y tipos de fallo. Separar por PR/familia de bug, no por comentario: ambos lados del par deben estar en el mismo split.
4. Cada caso: id, snapshot base/head, alcance/contexto autorizado, defectos conocidos con condición/impacto/evidencia, negativos difíciles, etiquetas y procedencia. Los fixes posteriores sirven para curar etiquetas, **nunca** como contexto del reviewer del snapshot anterior.
5. Casos relevantes al uso histórico de RMS: scopes por restaurante, webhook/idempotencia, concurrencia, estados de reserva, TZ/DST, autorización, migraciones y rendimiento de consultas. Añadir TS/Workers para DonMerge y estratos de otros repos reales cuando existan; no asumir que todos son PHP.

**Verificar:** `npm run test -- src/workflows/code-review/__tests__/evaluation.test.ts`: fixtures válidos, splits sin fuga, pares bien agrupados; sin llamadas de red.

### U2 — Medir detección, no estilo del texto

- Matching por identidad del defecto, condición causal y evidencia, no igualdad de redacción. Cada defecto cuenta una sola vez; duplicados cuentan aparte.
- Precisión = defectos reportados adjudicados correctos / reportados adjudicados. Recall = defectos conocidos detectados / defectos conocidos. Desglosar críticos/altos y negativos limpios; contabilizar abstenciones, no esconderlas del denominador de revisiones.
- Reportar findings descartados por cada etapa, recall antes/después del verificador, severidad correcta y calidad del arreglo por separado.
- Para juicios semánticos, empezar con adjudicación humana. Un juez LLM solo ayuda después de contrastarlo con etiquetas separadas, midiendo sensibilidad/especificidad; nunca usar auto-confianza del reviewer como ground truth.
- Reportar tamaños de muestra e intervalos; desacuerdos quedan pendientes, no se fuerzan a PASS.

**Verificar:** fixtures de matcher con paráfrasis, doble hallazgo del mismo bug, mismo archivo con bugs distintos, explicación plausible pero incorrecta, conjunto vacío y etiqueta desconocida. `eval:review:compare` debe devolver código distinto de cero si pierde un centinela o incumple un umbral congelado.

### U3 — Capturar baseline de rendimiento

Registrar por ejecución: runId, repo/tenant opaco, hashes base/head/config/prompt, modelo solicitado **y servido cuando sea observable**, duración de cola/preparación/setup/inferencia/verify/publicación, intentos, tokens reales o estimados claramente marcados, cache hits, motivo de fallback, coverage y resultado.

No persistir secretos ni prompts/diffs crudos en logs generales. Usar el logging actual con un esquema común; no crear otra memoria de aprendizaje. Si Flue no expone usage/modelo servido, registrar `unknown` e instrumentar el adaptador antes de atribuir coste. Precio del modelo versionado por fecha; tokens no equivalen automáticamente a dólares.

Comparar mismos PRs y contexto de memoria congelado entre versiones. Mínimo tres repeticiones de los experimentos LLM si el presupuesto lo permite, caché controlada e informada. Los fallos de provider se informan aparte de defectos del reviewer, pero siguen contando en disponibilidad/latencia.

**Verificar:** tests con reloj y transport simulados; retry y fallo no pierden contadores; logs no contienen valores de credenciales.

### U4 — Puerta reproducible

Runner offline por defecto con respuestas grabadas/redactadas y fixture sintético. Modo live explícito, presupuesto y proveedor autorizados, sin escribir reviews en GitHub. Exportar JSON + resumen legible con versión del evaluador y denominadores.

Objetivos iniciales para promover cambios: precisión bloqueante ≥90%, recall crítico/alto ≥80%, ningún centinela crítico perdido frente al baseline. Si el corpus es demasiado pequeño, no habilitar bloqueo por el nuevo pipeline: mantener experimental/shadow. Un dataset sintético es regresión útil, no validación comercial.

## Criterios de aceptación

- [ ] `npm run typecheck`, `npm run test`, `git diff --check` pasan.
- [ ] Tests del evaluador no consumen red ni dinero.
- [ ] `npm run eval:review -- --mode offline` (script a crear) genera el mismo informe para las mismas fixtures y configuración.
- [ ] `npm run eval:review:compare -- --baseline <baseline.json> --candidate <candidate.json>` (script a crear) detecta degradación deliberada.
- [ ] Reporte distingue datos sintéticos/reales, calidad semántica/contrato, y métricas desconocidas.
- [ ] Hay revisión humana de las etiquetas antes de usar precisión/recall para promoción.

## Riesgos y mantenimiento

No bloquear las correcciones deterministas de cobertura por falta de datos reales. Sí bloquear afirmaciones de mejora de calidad y selección de modelos hasta tener evidencia. Toda nueva versión de prompt/modelo debe ejecutar la misma evaluación; separar dataset de desarrollo del holdout. Si cambian interfaces por trabajo paralelo en memoria, adaptar el consumidor sin redefinir aprendizaje. Commits por unidad en rama de tarea; draft PR, sin deploy.
