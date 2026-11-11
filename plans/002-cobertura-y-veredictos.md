# 002 — Cobertura explícita, snapshot consistente y veredictos honestos

**Estado:** HECHO — U1–U4 implementadas (`review-snapshot.ts`, `review-coverage.ts`, `review-output-schema.ts`, workflow, github-api, issue-matcher) con suites dedicadas.

## Objetivo

Impedir que código no revisado, una respuesta inválida o un resultado de otra versión del PR se interpreten como revisión limpia. No garantizar “el PR es correcto”: informar alcance real y defectos demostrados. No rediseñar memoria.

## Estado actual verificado

- `src/workflows/code-review/code-review-workflow.ts:430-436`: `/files?per_page=100` y `filesResponse.slice(0, maxFiles)`; no recorre páginas. Focus y excludes se aplican después.
- `src/workflows/code-review/prompts/sanitizers.ts:53-60`: `.slice(0, maxLength)` con default 50.000, incluso en medio de un hunk.
- `src/workflows/code-review/github-api.ts:854-865`: `/contents/${path}` sin `ref`; se lee la rama por defecto, no necesariamente base/head del review.
- `src/workflows/code-review/processor-utils.ts:49-81`: valida resumen y keys, no todo el contrato. Ausencia de `lineComments` se trata como `[]`; `normalizeReviewResult` recalcula aprobación.
- `src/workflows/code-review/github-api.ts:218-241`: éxito si no hay blocking findings. `approval-gate.ts` puede emitir REQUEST_CHANGES por threads pendientes y mantener check verde; es una decisión previa documentada, no un bug nuevo a “corregir” incidentalmente.
- `src/workflows/code-review/issue-matcher.ts:42-49`: issue abierto no encontrado → resolved; workflow lo marca fixed. No prueba que se haya inspeccionado o arreglado.

## Alcance

Modificar `code-review-workflow.ts`, `types.ts`, `github-api.ts`, `prompts/builder.ts`, `prompts/sanitizers.ts`, `processor-utils.ts`, `review-model-runner.ts` bajo `src/workflows/code-review/`; helpers nuevos `review-snapshot.ts`, `review-coverage.ts`, `review-output-schema.ts` en ese directorio. Tests nuevos `__tests__/review-snapshot.test.ts`, `review-coverage.test.ts`, `review-output-schema.test.ts`, `code-review-workflow.test.ts`; extender `builder.test.ts`, `processor-utils.test.ts`, tests existentes de GitHub/anchors según corresponda.

La parte lifecycle es una frontera compartida: adaptar `issue-matcher.ts` y sus tests solo si no pertenece al trabajo paralelo. En caso contrario acordar contrato `verifiedResolvedIds + reviewedScope` y entregar fixtures para integrarlo. No tocar D1, cálculo de pesos ni handlers de feedback.

## Unidades de implementación

### U1 — Snapshot versionado y descubrimiento completo

Capturar `headSha`, `baseSha`, `baseRef` y merge-base usado para construir el diff. El snapshot tiene un digest y cada fuente declara ref/procedencia. Las reglas ejecutables/configuración de confianza se leen de la base confiable; los cambios del PR en reglas/config son datos a revisar, no instrucciones que puedan desactivar la revisión.

Paginar lista de archivos hasta completar, comparando con `changed_files`. No prometer más allá del límite GitHub de 3.000 archivos; si no puede reconstruirse con un mecanismo seguro, declarar parcial. El endpoint de archivos representa un PR mutable: comprobar head/base antes y después de paginar; si cambió, descartar snapshot/reprogramar. Preferir diffs construidos entre refs inmutables cuando el adaptador ya lo permita.

Aplicar include/exclude/focus **antes** de presupuesto. Distinguir exclusión por política de omisión por límite. Un focus sin match es explícito, no cambiar silenciosamente a revisión global. Un review focalizado siempre dice que es focalizado. Leer código en head para lado RIGHT y base/merge-base apropiado para LEFT; probar forks, renames y deletions.

**Verificar:** `npm run test -- src/workflows/code-review/__tests__/review-snapshot.test.ts`: 0, 50, 101 archivos; foco más allá del 50; exclusiones delante de archivo riesgoso; cambio de SHA durante paginación; límite remoto; fork/rename/delete.

### U2 — Manifiesto de cobertura y presupuesto por unidades

Por archivo/hunk: descubierto, elegible, recibido, revisado, excluido, pendiente; razón de omisión y ref exacta. Separar límites de archivo, bytes/tokens y salida. No usar sanitización como asignador de presupuesto. Preservar hunk completo y líneas originales; dividir por funciones/hunks conectados y añadir referencias a dependencias cuando el prompt no quepa.

`[no patch available]` no cuenta como analizado. Reconstruir diff/texto seguro con refs o clasificar binario/inaccesible; registrar límites sin fingir cobertura. El historial de comentarios y documentación también tiene presupuesto separado; no consumir todo el contexto antes del código.

Revisar todos los hunks elegibles es el objetivo. Si el presupuesto no alcanza, publicar cobertura parcial, pendientes y motivo. No usar una fracción “100%” sobre solo los archivos seleccionados como si fuera el PR completo.

**Verificar:** `review-coverage.test.ts`: 49.999/50.001 caracteres, hunk largo, patch ausente, límite de salida, contexto grande, focus, política de exclusiones. Todo hunk está contabilizado exactamente una vez y ningún texto desaparece sin razón.

### U3 — Contrato de salida estricto

Usar Valibot ya instalado: validar desde `unknown`, arrays obligatorios, enums de severidad/side, paths exactos, líneas enteras positivas, tamaños y campos requeridos. Validar evidencia con archivos realmente recuperados; anchors con el parser existente. Una estructura incompleta va a repair/fallo, nunca a review vacío aprobado.

Separar contrato interno (ejecución/cobertura/evidencia) del formato público existente. Mantener compatibilidad explícita para resultados históricos en el status API y no convertir legado sin cobertura en `complete`. No confiar en `approved` generado: derivar veredicto del resultado validado y política.

El futuro esquema de candidatos de 003 añade causalidad/evidencia sobre esta base; no duplicar validadores ni introducir Zod adicional.

**Verificar:** `review-output-schema.test.ts` y `review-model-runner.test.ts`: ausencia de arrays, tipo numérico en summary, severidad inventada, ruta no leída, línea negativa, output truncado y JSON repair válido. Todos los inválidos terminan sin éxito limpio.

### U4 — Publicar la verdad del alcance

Matriz mínima:

| Resultado | Check propuesto | Mensaje |
|---|---|---|
| Completo, sin hallazgo bloqueante | success | Sin defectos bloqueantes detectados en snapshot/alcance declarados |
| Defecto bloqueante validado | failure | Condición, impacto y evidencia; cobertura adicional si parcial |
| Parcial/focalizado sin bloqueante | neutral | Revisión parcial; no certifica el resto del PR |
| Fallo de infraestructura/output | failure o timed_out según causa | Error de ejecución, separado de defecto del PR |
| Snapshot obsoleto | neutral/superseded | No vigente; programar la última versión |

No modificar por accidente la política existente de threads: mostrar por separado `outstandingThreads` y decisión del review. Neutral no garantiza bloqueo de merge en GitHub: documentar esta semántica; convertir incompletitud en check obligatorio fallido requiere decisión de producto posterior, no hacerlo silenciosamente.

Veredicto considera todos los findings verificados vigentes, no solo comentarios nuevos tras dedup. `criticalIssues` debe derivarse de esos findings, nunca una lista independiente que bypassée evidencia. Un fallo de anchor no elimina un defecto probado: mostrarlo en resumen con evidencia y cobertura, sin fabricar otra línea. Informar el límite actual de 40 comentarios y listar el resto en resumen; no silenciarlos.

Los issues no observados son `not assessed` a nivel de resultado, no `fixed`. Mantener estado almacenado salvo evidencia de arreglo explícita ligada a la versión. Respetar dismissals humanos del sistema existente. Conectar mediante contrato, sin tocar aprendizaje.

**Verificar:** suite de composición `code-review-workflow.test.ts` con fetch/DO simulados: parcial sin hallazgos, defecto persistente deduplicado, candidato sin anchor, issue fuera de focus, comentario antiguo no mencionado, error de output y mezcla de threads/resultado.

## Criterios de aceptación

- [ ] Tests indicados, `npm run typecheck`, `npm run test`, `git diff --check` pasan.
- [ ] Cero green-global en todos los fixtures parciales/inválidos.
- [ ] Cada fuente y cada hunk tienen ref, estado y razón; ningún recorte silencioso.
- [ ] Ningún issue queda fixed solo porque desapareció del output.
- [ ] El formatter mantiene anchors, metadata, retries de GitHub y guard de body existentes.
- [ ] El nuevo contrato se serializa y vuelve a leerse en el adaptador Workflow; evitar persistir stubs, funciones o secretos añadidos en artefactos de cobertura.

## Riesgos y mantenimiento

No cambiar el contrato público de status de forma incompatible; añadir campos/versionar adaptador. La revalidación justo antes de publicar corresponde a 004: el snapshot de esta entrega es su entrada. Si cambian los archivos por el agente de memoria, rebasar y conservar su API. Rama de tarea, commits por unidad y draft PR; activación/despliegue separados.

Fuente del límite/paginación: https://docs.github.com/en/rest/pulls/pulls
