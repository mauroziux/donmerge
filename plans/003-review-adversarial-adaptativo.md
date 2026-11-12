# 003 — Investigar el cambio y tratar de refutar cada hallazgo

**Estado:** HECHO (núcleo, flags OFF) — `review-risk.ts`, rúbrica adversarial + segunda pasada en `prompts/*`, `finding-verifier.ts`, contexto de archivos en head (`DONMERGE_FILE_CONTEXT`). Activación por entorno y ablación shadow: PENDIENTE-ACTIVACIÓN. Ejecución de repros del PR: no implementada (por diseño en esta fase).

## Objetivo

Revisar si la solución realmente cumple el contrato y qué escenario la rompe. “Desconfiar del PR” significa buscar evidencia independiente y contraejemplos, no asumir culpabilidad ni forzar un número mínimo de errores. El operador eligió profundidad adaptativa; memoria fuera de alcance.

## Estado actual

- `src/workflows/code-review/prompts/templates.ts:19-44` ya exige mecanismos concretos, pero gran parte del prompt fija formato, personalidad y AI Prompt. No exige trazabilidad de llamadas ni intentar refutar candidatos.
- `src/workflows/code-review/prompts/builder.ts:270-311` etiqueta título/body como no confiables; preservar esa defensa. El contexto adicional prioriza docs/configs, no implementaciones relacionadas.
- `src/workflows/code-review/review-model-runner.ts:207-231` acepta el primer resultado válido. Los modelos de fallback no son revisores independientes.
- `src/workflows/code-review/processor-utils.ts:124-151` decide con regex sobre el texto completo. “causes” satisface un mecanismo léxico; no demuestra un bug.
- `src/workflows/code-review/code-review-workflow.ts:565-590` configura un sandbox con entorno que contiene token GitHub y claves de proveedores. No se comprobó el inventario efectivo de herramientas/egress: no afirmar explotación, pero tampoco ejecutar código del PR ahí sin rediseñar el aislamiento.

## Alcance

Nuevos helpers bajo `src/workflows/code-review/`: `review-context.ts`, `review-risk.ts`, `finding-verifier.ts`; ampliar `review-output-schema.ts` de 002. Modificar `prompts/templates.ts`, `prompts/schema.ts`, `prompts/builder.ts`, `review-model-runner.ts`, `code-review-workflow.ts`, `processor-utils.ts`, `types.ts` y tests respectivos. Fixtures/evals de 001.

No reemplazar Flue/Workflows/DO, no crear framework de agentes, no cambiar memory-store/feedback/pesos ni triage. Compartir adaptador de modelos, no renombrar modelos por reputación. Preservar fingerprints/identidad para no duplicar comentarios; metadatos nuevos no alteran arbitrariamente la identidad del defecto.

## Unidades de implementación

### U1 — Contexto mínimo suficiente y verificable

A partir del snapshot de 002, recuperar funciones/clases completas afectadas, imports/implementaciones directas, callers, contratos/tipos, validaciones y tests relacionados. Para PHP/Laravel, incluir scopes, policies, transacciones y modelos relevantes; para TS/Workers, bindings, rutas async y contratos de cola. Navegación acotada, por referencias y búsquedas simples primero; no construir un grafo global obligatorio.

Cada pieza lleva path, ref, rango, hash y motivo de selección. Buscar una dependencia adicional cuando sea necesaria para resolver una hipótesis, no volcar todo el repositorio. Un símbolo dinámico no resuelto queda como limitación; no inventar su comportamiento.

Inicialmente el host recupera contexto de solo lectura y lo entrega al modelo. Si se habilitan herramientas, limitar a lectura/búsqueda de snapshot exacto, rutas normalizadas, cuotas y egress allowlisted. Publicación GitHub permanece fuera del modelo. Config confiable solo de base/tenant; contenido del PR, docs, comentarios, strings y resultados de herramientas son datos no confiables. Escapar etiquetas no es barrera de permisos.

**Verificar:** `npm run test -- src/workflows/code-review/__tests__/review-context.test.ts` (nuevo): validación en caller que refuta bug, guard ausente en rama alternativa, rename, contrato de DB fuera del diff, referencia dinámica no resuelta, instrucción hostil en comentario y ruta fuera de snapshot. Cero recuperación de secretos o lectura arbitraria de otros tenants.

### U2 — Investigar sin anclarse en el relato del autor

Prompt analítico independiente del formato final:

1. Extraer contrato observado desde código base, consumidores y especificación confiable. Descripción del autor = hipótesis, no verdad.
2. Identificar cambio semántico y supuestos nuevos: entradas, permisos, estados, transacciones, orden temporal, reintentos, TZ, tamaño de datos.
3. Buscar contraejemplo concreto; comparar base/head para distinguir regresión de deuda previa. Un defecto preexistente solo es candidato si el PR cambia su alcanzabilidad/impacto y se explica.
4. Inspeccionar si los tests del PR tienen aserciones que fallarían con la implementación equivocada, si mockean la dependencia relevante o solo prueban happy path. Test verde no prueba el contrato de negocio.
5. Examinar efectos en consumers, error paths y límites. No recomendar refactor, cobertura extra o “mejor arquitectura” como bloqueo sin fallo material.
6. Emitir candidatos estructurados, todavía sin comentario decorativo.

Contrato de candidato: id estable, categoría, impacto/severidad, condición de activación, esperado/observado, ruta causal, referencias de evidencia en snapshot, relación con el cambio, contraevidencia buscada, limitaciones y corrección mínima propuesta. Confianza expresada por evidencia disponible, no porcentaje autoestimado.

**Verificar:** tests del builder y fixtures del corpus: solución aparentemente buena que omite idempotencia, comparación DST, aislamiento tenant, null manejado correctamente, validación indirecta, refactor equivalente. El reviewer debe poder devolver cero candidatos sin penalización.

### U3 — Verificador independiente y severidad separada

Nueva llamada con contexto fresco, sin conversación del investigador ni su auto-confianza. Recibe el candidato y fuentes exactas, e intenta **refutarlo**: guard externo, precondición imposible, comportamiento ya existente, contrato incorrectamente supuesto, test que contradice el fallo. No pedir “confirma al reviewer”. Otro modelo es opción a comparar, no requisito; diversificar solo si mejora eval a coste aceptable.

Tres resultados: `supported`, `refuted`, `insufficient_evidence`, con explicación y referencias. Supported puede basarse en traza estática causal completa o reproducción ejecutada segura; no exigir correr todos los repos para cada bug. Evidencia sintácticamente válida no basta: comprobar que las fuentes existen y respaldan la causalidad.

Solo supported puede ser defecto publicado/bloqueante. Insufficient se conserva como limitación pendiente, no se convierte en aprobación si falta completar una pasada requerida. Refuted se guarda en trazas de evaluación, no en comentarios ruidosos. No resolver desacuerdos mediante mayoría automática; recuperar contexto adicional una vez dentro del presupuesto o declarar incertidumbre.

Separar severidad del defecto y certeza de evidencia. P0/P1 bloquean según política; P2 concreto puede ser informativo. Adaptar a `critical/suggestion/low` públicos sin romper consumidores. Derivar resumen y criticalIssues del mismo conjunto verificado. Mantener filtros de estilo solo como higiene, no como sustituto de verificación, y medir pérdidas causadas por ellos.

**Verificar:** `finding-verifier.test.ts` (nuevo): candidato falso convincente rechazado, bug real sin palabra “crash” aceptado, evidencia inventada rechazada, fallo del verifier no aprobado, severidad independiente de certeza. Evals reportan recall bruto y posterior al filtro.

### U4 — Profundidad adaptativa, incluyendo revisiones “limpias”

Risk planner determinista y explicable usando cambios semánticos, dependencias y señales de dominio; no solo paths ni tamaño. Señales: auth/tenant, migraciones, dinero, concurrencia/idempotencia, estado persistido, contratos públicos, manejo de errores o dependencia compartida.

- Bajo riesgo: investigación normal; verificar candidatos si existen. Cero hallazgos no obliga a otra revisión completa.
- Alto riesgo: foco adicional en invariantes afectadas; si la primera pasada sale limpia, segunda búsqueda independiente que no vea la conclusión de la primera. Si encuentra candidatos, verificarlos.
- Desconocido o cobertura incompleta: no rebajar a bajo por falta de datos; recuperar contexto o informar parcial.

Todas las rutas obedecen presupuesto total de 004. Registrar por qué escaló, qué faltó revisar y coste marginal. Verificación por lotes de candidatos relacionados reduce overhead; no perder aislamiento entre bloques no relacionados.

No introducir ejecución automática de comandos del PR en esta primera versión. Reproducciones ejecutables posteriores requieren entorno separado sin credenciales, sin red por defecto, recursos acotados, imágenes/dependencias confiables y comandos aprobados por política de repo, no por contenido del PR. Un test redactado sin ejecutar se etiqueta así.

### U5 — Comentario breve y accionable

Render determinista: problema + condición + consecuencia + evidencia localizable + fix mínimo/test recomendado. Conservar AI Prompt por compatibilidad, pero generarlo después del análisis, sin ocupar la investigación con requisitos de estilo. No duplicar la misma causa por archivo, no inventar “tests ejecutados”, no emitir elogios de seguridad.

Comparar en shadow el pipeline original, contexto mejorado solo, prompt adversarial y verifier (ablación). Así se sabe qué aporta valor y qué solo añade latencia.

## Criterios de aceptación

- [ ] Suites nuevas, `npm run typecheck`, `npm run test`, `git diff --check` pasan.
- [ ] Todo hallazgo bloqueante tiene condición causal y evidencia en snapshot; ningún campo libre bypasséa el verificador.
- [ ] Casos de alto riesgo sin hallazgos hacen búsqueda independiente o terminan incompletos, nunca limpios por timeout.
- [ ] Precisión bloqueante ≥90%, recall crítico/alto ≥80%, ningún centinela crítico perdido; muestras/intervalos informados en eval 001 antes de activar.
- [ ] Tests de injection no cambian permisos, alcance ni publican directamente mediante herramientas.
- [ ] Contexto de memoria existente se consume sin modificar aprendizaje; política de seguridad/veracidad no puede ser anulada por preferencias.

## Riesgos y activación

Dos llamadas no garantizan independencia estadística ni verdad. El juez puede eliminar bugs reales: medir recall antes/después y adjudicar desacuerdos. Mantener feature flags de contexto/verifier separadas para rollback. Si el SDK no permite garantizar herramientas read-only y aislamiento, usar recuperación host-side sin tools; no dar shell más poderoso para resolverlo. Shadow/canary y gasto LLM requieren autorización separada. Entregar commits y draft PR, sin despliegue.
