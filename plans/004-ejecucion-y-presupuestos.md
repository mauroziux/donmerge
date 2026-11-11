# 004 — Revisar la última versión sin duplicar trabajo ni efectos

**Estado:** HECHO (núcleo) — runId fencing + pendingLatest + handoff durable en `processor.ts`; presupuesto extremo-a-extremo en `review-model-runner.ts`; publicación idempotente por marcador de run en `github-api.ts`. Cancelación real del adaptador Flue e inventario de retries del Gateway: PENDIENTE-ACTIVACIÓN (requiere entorno desechable).

## Objetivo

No perder pushes, no permitir que runs viejos sobrescriban el resultado vigente y acotar el coste real de fallbacks/retries. Mantener Queue + Workflow + ReviewProcessor DO; sin migración de plataforma ni cambios de memoria.

## Evidencia actual

- `src/workflows/code-review/processor.ts:93-110`: mismo umbral de 5 minutos para pending y running. `review-model-runner.ts:23`: prompt puede durar 600.000 ms.
- `src/workflows/code-review/webhook.ts:226-235`: start rechazado se reconoce como duplicado y no conserva otro SHA. `workflow-id.ts:15-30`: eventos normales comparten ID por PR, no por snapshot.
- `src/queues/code-review-consumer.ts:56-73` hace restart ante already_exists; hay que consultar estado y generación antes de reiniciar trabajo activo válido.
- `src/workflows/code-review/processor.ts:153-166`: `updateFromWorkflow` no recibe runId. RPCs de issues tampoco comprueban generación.
- `src/workflows/code-review/code-review-workflow.ts:195-205`: step LLM 40 min, publicación 3 min, ambos con retries. `review-model-runner.ts:115-173`: hasta dos prompts de 10 min por modelo; cadena configurable puede exceder presupuesto.
- `src/workflows/code-review/utils.ts:309-323`: Promise.race rechaza al vencer, sin cancelar prompt.
- `src/workflows/code-review/code-review-workflow.ts:775-805`: después del POST del review siguen lecturas, guardado, check y edición de descripción. Un fallo tardío reintenta el step completo. El retry acotado de 422 existente no cubre un POST aceptado con respuesta perdida.

## Alcance

`src/workflows/code-review/{processor,code-review-workflow,webhook,workflow-id,review-model-runner,github-api,types,utils}.ts`, `src/queues/code-review-consumer.ts`, `src/api/routes.ts` y pruebas asociadas; `src/lib/sandbox-lifecycle.ts` solo para cancelación/cleanup si hace falta. Nuevos helpers puros de deadline/publicación bajo code-review.

No cambiar permisos públicos ni autorizar nuevos remitentes; conservar aislamiento de tenant y auth del status API. Fencing en RPC de issues protege writes, no redefine lifecycle, memoria o pesos. Tests de referencia: `__tests__/processor.test.ts`, `__tests__/review-model-runner.test.ts`, `src/queues/__tests__/code-review-consumer.test.ts`, `src/api/__tests__/routes.test.ts`.

## Unidades de implementación

### U1 — Identidad, último push pendiente y fencing

Incluir runId/generación, snapshot base/head y fingerprint de solicitud (focus/instrucción/política) en la coordinación. Delivery duplicado no crea trabajo; push con SHA diferente se guarda como pendiente más reciente. Comentario nuevo con intención distinta no se pierde por compartir SHA; conservar semántica explícita para solicitudes manuales. Retarget/base SHA diferente invalida alcance anterior.

Un run activo por PR; coalescer ráfagas al último snapshot, sin revisar todos los pushes intermedios. Al terminar/fallar/superarse el run, arrancar el pendiente mediante handoff durable (no callback en memoria). Recuperación mediante estado Workflow/lease y alarm según SDK, no asumir stale solo porque el review tarda más de cinco minutos. Pending huérfano y running vivo tienen políticas distintas.

Cada update, guardado de issues y permiso de publicación exige generación vigente. Un resultado viejo no puede borrar credenciales/contexto del nuevo run ni actualizar su status. IDs de workflows reproducibles por run/snapshot dentro de límites nativos; retry de la misma entrega no cambia identidad. En eventos de comentario, resolver SHA confiablemente antes de decidir duplicidad.

**Verificar:** fake clock/storage: dos deliveries idénticos, A→B→C mientras A ejecuta, A termina tarde, comentario distinto sobre C, retarget, deploy entre start y create, pending huérfano y running vivo >5 min. Comprobar que solo C queda pendiente y se ejecuta; no reescribir contexto de otro initiator.

### U2 — Un presupuesto de extremo a extremo

Definir deadline persistido por ejecución y subpresupuestos de preparación, investigación, verificación, fallback y publicación. Cada intento usa `remainingBudget`; no iniciar un prompt de 10 min si quedan 30 s. Reservar tiempo para cancelar, cerrar check y registrar cobertura incompleta. Replays del step no reinician el presupuesto global.

Distinguir error de formato (una reparación corta con respuesta previa + schema, sin releer todo), auth/cuota (fallback sin retry idéntico), transitorio (backoff/jitter limitado), contenido insuficiente y fallo del sandbox. El prompt anterior puede contener datos no confiables: la reparación no debe obedecerlos como instrucciones.

Conservar fallback entre proveedores, pero no usarlo como juez. Inventariar política real del Gateway al implementar: sus retries más los locales no pueden multiplicarse sin control. Registrar ruta solicitada y modelo servido cuando sea observable; no asumir que dos rutas son modelos distintos.

No reducir el timeout actual arbitrariamente: hay evidencia histórica de llamadas >6 min. El límite final se fija con p95 medido y presupuesto autorizado. Si no hay presupuesto para la pasada requerida, resultado parcial, no limpio.

**Verificar:** fake timers con 3 modelos y reparación, deadline casi agotado, replay, cuota, 429, fallo de formato, verifier tardío y último fallback exitoso. Assert total <= deadline + margen explícito de cleanup, no la suma ilimitada de timeouts.

### U3 — Cancelación real y aislamiento de intentos

Inspeccionar API de cancelación de Flue/OpenCode instalada. Si es soportada, abortar sesión/operación y esperar cierre antes del siguiente intento. Si no puede cancelarse fiablemente, destruir el sandbox del intento y crear uno nuevo; el cambio del ownership de sandbox debe ser explícito entre workflow y runner.

Promise.race no basta. Rechazar resultados tardíos mediante run/attempt ID. Cleanup best-effort no oculta el error primario; no reutilizar una sesión que quedó colgada. Nunca compartir entorno o workspace de diferentes tenants.

**Verificar:** promesa que termina después del timeout, fallo de cleanup, DO evictado, sesión que no arranca y fallback en entorno nuevo. Prueba del adaptador real de cancelación en entorno desechable autorizado antes de afirmar que detiene consumo; mocks solo prueban nuestra lógica.

### U4 — Publicación idempotente y reconciliable

Persistir un publication intent: runId, snapshot, digest del resultado, marker y estado/IDs de efectos. Separar review POST, reconciliación de comentarios, check completion y actualización de descripción en operaciones/steps recuperables; no reejecutar inferencia por fallo de publicación.

Antes de publicar: comprobar generación vigente y head/base actuales. Si cambiaron, no publicar ni resolver issues sobre el nuevo snapshot; finalizar como superseded y programar el pendiente. GitHub no ofrece transacción atómica entre consulta de SHA y POST: anclar siempre `commit_id`, incluir snapshot y revalidar después. Si el PR avanza durante el POST, marcar ese resultado como obsoleto y garantizar review del último SHA; no prometer exclusión absoluta de esa carrera externa.

Antes de repetir un POST tras timeout/transporte ambiguo, buscar marker de publicación por run/snapshot en reviews existentes con paginación. Si se confirma, reconciliar IDs y continuar; si la lectura no permite resolver la ambigüedad, mantener publicación pendiente y no volver a enviar a ciegas. No afirmar exactly-once absoluto: se busca no duplicar en casos observables y hacer explícitos los inciertos.

Completar check y guardar resultado desde un conjunto inmutable de hallazgos, no desde lo que quedó después del dedup. Edición de descripción debe preservar texto del autor alrededor de un bloque con inicio/fin; no es una excusa para volver a publicar review. Manejar fallo de descripción como efecto separado, sin borrar una revisión válida.

**Verificar:** workflow + fetch simulados: POST exitoso seguido de fallo al completar check; POST aceptado con respuesta perdida; replay tras guardar issues; publicación existente paginada; head cambiado antes/durante POST; descripción editada por autor. Assert un review por publication intent en casos reconciliables y estado pendiente en ambiguos, nunca segundo POST ciego.

## Criterios de aceptación

- [ ] Tests focalizados de coordinator, runner, queue, API y publicación pasan.
- [ ] `npm run typecheck`, `npm run test`, `git diff --check` pasan antes de commit.
- [ ] Todos los RPC de mutación/terminal update rechazan generación vieja.
- [ ] Un nuevo SHA recibido durante un run no desaparece; queda programado duramente.
- [ ] Una ejecución válida de más de 5 min no se reinicia solo por antigüedad.
- [ ] No hay inferencia ni POST duplicado al reintentar efectos posteriores en fixtures.
- [ ] Deadline y cancelación reportan pruebas de adaptador y limitaciones, no solo fake timers.

## Riesgos y entrega

Es la entrega con mayor riesgo de compatibilidad operacional. Introducir lectura de estados antiguos sin runId como legado explícito, recuperar sin corromper resultados existentes; no borrar storage. Conservar owner/tenant e initiatorKeyHash en todos los caminos. Cambios de auth/permisos necesitarían revisión específica, no ampliarlos para simplificar coordinación. Commits por unidad y draft PR; canary opt-in autorizado. No deploy automático.

Fuentes: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ y https://developers.cloudflare.com/workflows/build/rules-of-workflows/
