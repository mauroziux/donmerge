# DonMerge: reviews de mayor valor y mejor rendimiento

Estado: **plan propuesto, no implementado**. Base inspeccionada: `8fd3eef`.

## Objetivo y decisión del operador

Encontrar errores reales y soluciones incompletas, no producir más comentarios. Tratar la explicación del autor y los tests del PR como afirmaciones que contrastar, no como prueba de corrección. Mejorar rendimiento sin comprar velocidad a costa de ignorar código.

El operador eligió **profundidad adaptativa**: revisar el alcance completo, verificar candidatos y ampliar investigación en cambios riesgosos; no ejecutar varios reviews completos indiscriminadamente.

**Fuera de alcance:** rediseñar la memoria, su persistencia D1, aprendizaje, feedback y pesos; otro agente trabaja en ello. Tampoco implementar ahora, desplegar, cambiar proveedores en producción, abrir issues ni modificar repositorios revisados.

## Diagnóstico con evidencia

Hallazgos de lectura del código, no incidentes reproducidos en producción. Confianza alta en los mecanismos indicados; frecuencia e impacto agregado aún no medidos.

| Prioridad | Hallazgo | Evidencia | Consecuencia | Entrega / esfuerzo / riesgo |
|---|---|---|---|---|
| P0 | Cobertura parcial presentada potencialmente como review limpio | `src/workflows/code-review/code-review-workflow.ts:430-498`: una página, `slice(0, maxFiles)` antes de filtros. `prompts/sanitizers.ts:53-60`: 50.000 caracteres sin señal de truncamiento. `github-api.ts:218-241`: éxito depende de hallazgos, no de cobertura. Rutas de prompts y GitHub bajo `src/workflows/code-review/`. | Se pueden omitir archivos/hunks, incluso el solicitado mediante focus, y devolver éxito. | 002 / M–L / medio |
| P0 | Salida incompleta puede convertirse en ausencia de errores | `src/workflows/code-review/processor-utils.ts:49-81,248-308`: validación centrada en resumen; arrays ausentes se normalizan a vacíos. | Un resumen bien formado no garantiza que el modelo haya producido un resultado de review válido. | 002 / M / medio |
| P0 | Versiones y ejecuciones no están suficientemente aisladas | `processor.ts:93-110,153-166`: running caduca a 5 min y actualizaciones sin runId. `review-model-runner.ts:23`: timeout de 10 min. `webhook.ts:226-235`: un evento durante running se descarta como duplicado sin conservar el SHA nuevo. Rutas bajo `src/workflows/code-review/`. | Se puede perder un push nuevo o aceptar escrituras tardías de un run anterior. | 004 / L / alto |
| P1 | Calidad léxica en lugar de evidencia del defecto | `src/workflows/code-review/processor-utils.ts:18-35,124-151,223-229`: regex de palabras/mecanismos. `review-model-runner.ts:207-231`: se acepta el primer resultado válido; fallback solo por fallo. | Un comentario convincente pasa sin demostrar causalidad; el consenso no se mide y tampoco hay verificación independiente. | 003 / L / medio–alto |
| P1 | Contexto orientado a documentación, no a dependencias del cambio | `src/workflows/code-review/github-api.ts:854-927`: contenidos sin ref explícito y listado estático de docs/configs. `code-review-workflow.ts:565-619`: sandbox en `/home/user`, sin preparación explícita del árbol base/head ni navegación controlada. | No se garantiza que se lean callers, implementaciones, políticas o contratos necesarios para probar/refutar el defecto. Que OpenCode pueda usar herramientas no prueba que lo haga de forma suficiente. | 002 + 003 / L / medio |
| P1 | Ausencia de hallazgo interpretada como arreglo | `src/workflows/code-review/issue-matcher.ts:42-49` marca como resueltos los issues abiertos no encontrados; `code-review-workflow.ts:691-692` los pasa a fixed. | Una omisión o revisión focalizada puede parecer una corrección. Requiere contrato con el dueño de lifecycle/memoria, no reescribir su sistema. | 002 / M / medio |
| P1 | No hay benchmark versionado de detección real en los archivos inspeccionados | `vitest.config.ts`: suites `src/**/*.test.ts`; 45 suites ejecutadas, 1112 tests. `__tests__/review-model-runner.test.ts` simula respuestas. No suite que importe el workflow real, salvo mock en `src/app.test.ts`. | Los tests mecánicos no miden errores omitidos ni falsos positivos. | 001 / M inicial + etiquetado / bajo |
| P1 | Presupuesto de retries y publicación demasiado grueso | `review-model-runner.ts:115-173`: hasta dos prompts de 10 min por modelo. `code-review-workflow.ts:195-205`: step de 40 min y publicación completa reintentable. `utils.ts:309-323`: timeout no cancela la operación. Rutas bajo `src/workflows/code-review/`. | Tres modelos con repair pueden exceder 40 min; un timeout puede dejar trabajo vivo; fallos después de publicar pueden repetir efectos. | 004 / L / alto |
| P2 | Trabajo repetido evitable | `src/workflows/code-review/code-review-workflow.ts:357-395,456-516`: config/skills resueltos dos veces. `github-api.ts:909-927`: varios nombres de configuración compiten por la misma clave en paralelo. | Coste/API y contexto no determinista que conviene eliminar antes de una migración grande. | 005 / M / medio |

Esfuerzo orientativo: M = 1–3 días, L = 3–6 días de implementación y pruebas por entrega; no compromiso de calendario. No incluye espera de etiquetas humanas ni observación de canary.

## Orden recomendado

| Plan | Objetivo | Dependencias | Estado |
|---|---|---|---|
| [001](001-evaluacion-y-baseline.md) | Medir precisión, recall, cobertura, latencia y coste | Ninguna | TODO |
| [002](002-cobertura-y-veredictos.md) | No emitir falsos limpios; snapshot consistente y contrato de evidencia | Ninguna; usar fixtures de 001 cuando existan | TODO |
| [004](004-ejecucion-y-presupuestos.md) | No perder pushes ni duplicar publicación; deadlines y fencing | Snapshot/run contract de 002 | TODO |
| [003](003-review-adversarial-adaptativo.md) | Contexto dirigido + búsqueda de contraejemplos + verificador | 001, 002, 004 | TODO |
| [005](005-rendimiento-incremental.md) | Bajar trabajo repetido y elegir modelos por resultados | 001–004 | TODO |

001 puede empezar mientras se corrige 002. No escribir en paralelo sobre `code-review-workflow.ts`, `types.ts`, `processor-utils.ts` o `builder.ts`. Cada entrega admite commits pequeños; no convertir todo en una reescritura.

## Diseño de destino

Esquema orientativo, no código a copiar:

```text
Evento + versión del PR
  → coordinador: un run vigente, último push pendiente
  → snapshot base/head/merge-base + manifiesto de cobertura
  → priorización de riesgo + bloques completos dentro del presupuesto
  → contexto dirigido: código afectado, callers, contratos y tests
  → investigador: hipótesis de fallo y contraejemplos
  → verificador: intentar refutar cada candidato
       + segunda búsqueda si un cambio de alto riesgo sale limpio
  → decisión determinista: cobertura / ejecución / hallazgos
  → publicación idempotente vinculada a esa versión
```

Mantener Worker, Queue, Workflows, DO y seams existentes. No hace falta incorporar un framework multiagente ni una base vectorial para empezar.

## Qué significa un review útil

Ejemplo del contrato deseado, no hallazgo sobre este repositorio:

> **P1 — reserva duplicada al reintentar.** El webhook confirma la reserva antes de persistir la clave de idempotencia. Si la respuesta se pierde y el emisor reintenta, ambos caminos llegan a `createBooking`. Evidencia: ruta de llamadas y condición de carrera. Arreglo: reservar la clave y persistir el efecto en la misma transacción. Test: dos entregas con el mismo identificador; una sola reserva.

El review debe decir **qué condición falla, por qué, qué impacto tiene y dónde está la evidencia**. No basta con “consider adding idempotency”. Tampoco convertir toda alternativa de diseño en un bug.

Separar cuatro estados: ejecución terminada, cobertura completa, defecto demostrado y decisión de merge. “No se encontraron defectos en el alcance revisado” no equivale a “la solución es correcta”. No solicitar cambios por una mera hipótesis; sí comunicar revisión incompleta sin inventar seguridad.

## Medidas de éxito propuestas

Umbrales iniciales de aceptación, no resultados obtenidos. Congelarlos con el baseline antes de ajustar prompts; no rebajarlos para declarar éxito:

- 100% de archivos descubiertos contabilizados: revisados, excluidos por política o pendientes con razón. Todo recorte es visible; cero limpios globales en fixtures de cobertura incompleta.
- Cero publicaciones de runs ya identificados como obsoletos y cero reviews duplicados en pruebas de replay. Ante un POST ambiguo, reconciliar o dejar pendiente, nunca reenviar a ciegas. Si el SHA cambia durante el POST, marcar obsolescencia y revisar el nuevo SHA; no existe transacción atómica con GitHub.
- Precisión de defectos bloqueantes ≥90% en conjunto adjudicado; recall ≥80% de los defectos conocidos críticos/altos y sin perder ningún caso crítico centinela del baseline.
- Medir también recall antes/después del verificador: no ganar precisión descartándolo todo. Recall es sobre defectos conocidos/etiquetados, no sobre todos los posibles bugs del mundo.
- Para eficiencia: reducción objetivo del 30% de tokens de entrada de reruns elegibles, manteniendo las puertas de calidad. Latencia p50/p95 y coste por PR útil deben compararse por tamaño/riesgo y con la misma mezcla de PRs; no prometer un p95 absoluto sin datos actuales.
- Informar intervalos de confianza, número de muestras, estratos y tasa de revisión incompleta. Si no hay suficientes etiquetas, el resultado es experimental, no “calidad demostrada”.

## Convivencia con el trabajo de memoria

No tocar `memory-store.ts`, `pattern-recalculator.ts`, `feedback-handler.ts`, migraciones de memoria ni `docs/MEMORY-SYSTEM-DESIGN.md`. Consumir `MemoryContext`/`PatternWeight` con un adaptador; no convertir preferencias en prueba de corrección. Versionar la entrada de memoria para comparaciones y cache sin cambiar cómo se aprende.

`types.ts`, `processor-utils.ts`, `prompts/builder.ts` y el workflow son superficies compartidas: integrar sobre el trabajo del otro agente, conservar API y pruebas existentes. La transición `fixed` requiere evidencia explícita; si ese contrato lo está cambiando el otro agente, entregar el requisito/test y no duplicar su implementación. La evaluación adjudicada es independiente de reacciones o comentarios aceptados: silencio, merge y desaparición no son etiquetas de verdad.

## Verificación y despliegue de la implementación futura

Antes de cada commit de implementación: `npm run typecheck`, `npm run test`, `git diff --check`. Tests focalizados durante reparación; suite completa antes de entregar. Cada plan detalla pruebas adicionales. Las nuevas rutas de auth/permisos/sandbox, si se implementan, requieren revisión de seguridad específica y verificación de los límites reales.

Secuencia de activación propuesta: fixtures offline → replay autorizado sin publicar → shadow opt-in sin efectos GitHub → canary por repositorio → expansión. Llamadas pagadas, acceso/exportación de código privado y deploy requieren autorización y presupuesto separados. El rollback desactiva investigación/verificador/incremental nuevos; nunca restaura falsos limpios por truncamiento o ausencia de evidencia.

## Lo que no recomiendo ahora

- Cambiar al modelo “más nuevo” sin el mismo benchmark y precios/credenciales verificados.
- Revisores especialistas ilimitados o tres revisiones completas para todo PR: más coste no garantiza recall.
- Acortar timeout de 10 min a ciegas: el registro histórico describe generaciones de 289–468 s.
- Ejecutar automáticamente scripts/tests del PR con secretos o token GitHub dentro del sandbox.
- Usar similitud de texto, cantidad de comentarios o un juez LLM no calibrado como medida principal de calidad.
- Reimplementar anchors, retry de 422, guard de body o gate de threads: ya existen; conservarlos y probar su composición.
- Afirmar que “la memoria no existe”: el documento antiguo está desactualizado respecto al código, que sí la integra.

## Evidencia, límites y fuentes

Comprobaciones ejecutadas para entregar estos documentos: `npm run typecheck` pasó; `npm run test` pasó (45 suites, 1112 tests); enlaces locales, secciones y whitespace de los seis documentos comprobados. Solo cambian archivos bajo `plans/`. Estas comprobaciones validan la base existente y la integridad documental, **no** la efectividad de mejoras aún no implementadas. No hay diagnósticos LSP disponibles para Markdown en esta sesión.

Auditoría de entrada webhook/API, coordinación, workflow, prompt, normalización, publicación, configuración de modelos y suites relacionadas. No auditoría completa de seguridad del producto, triage/Sentry ni del nuevo sistema de memoria. No se consultaron logs actuales de producción, configuración viva del Gateway, costes reales ni trazas de herramientas del sandbox; no se realizó benchmark LLM. Los registros en `docs/PRODUCTION-VALIDATION-2026-08-21.md` son evidencia histórica, no medidas actuales.

Referencias: `docs/PULLFROG-GAP-CLOSURES.md`, `docs/plans/2026-08-13-001-fix-pullfrog-gap-closures-plan.md` (respetar mejoras existentes); documentación oficial consultada:

- https://docs.github.com/en/rest/pulls/pulls — paginación y límite de 3.000 archivos; paginar por sí solo no garantiza cobertura ilimitada.
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ — retries/timeouts por step.
- https://developers.cloudflare.com/workflows/build/rules-of-workflows/ — efectos externos e idempotencia.

**Siguiente paso recomendado:** implementar 001 y 002 como primera entrega funcional; no activar el nuevo reviewer hasta medirlo.
