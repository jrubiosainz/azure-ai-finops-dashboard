# Configuracion de Azure

El dashboard es un lector local. Todos los pasos que modifiquen Azure son opcionales,
deben realizarlos administradores autorizados y quedan fuera del arranque de la aplicacion.

## Fuentes minimas y opcionales

La suscripcion, su inventario y las consultas principales de Cost Management son
necesarios para una lectura real. Si fallan, se muestra un error en lugar de costes cero.
El acceso financiero tambien depende de las politicas de EA, MCA, CSP u otro contrato.

Las metricas de modelos dependen de las cuentas existentes y de la actividad en la
ventana. Se usan `InputTokens`, `OutputTokens` y `ModelRequests` en cuentas compatibles,
o los equivalentes `ProcessedPromptTokens`, `GeneratedTokens` y `AzureOpenAIRequests`.
No todas las cuentas de Speech, servicios cognitivos o generaciones de Foundry publican
esas metricas o dimensiones.

El inventario de agentes usa el endpoint de proyecto
`/api/projects/{project}/assistants` con API `2025-05-15-preview`. Se necesita acceso
de plano de datos. Nuevas generaciones o regiones que no expongan esa API pueden
mostrar el inventario de modelos y costes sin agentes. No se garantiza compatibilidad
con todas las versiones de agentes, cuentas privadas o todas las nubes de Azure.
Los endpoints actuales estan orientados a Azure publico.

Para recursos con red privada, ejecuta el dashboard desde una maquina con DNS, VPN y
rutas hacia esos endpoints. Los roles de Azure no sustituyen el acceso de red.

## Telemetria GenAI (opcional)

Application Insights necesita estar asociado a un workspace de Log Analytics
consultable por la identidad de Azure CLI. El lector busca en `AppDependencies`,
`AppTraces`, `AppEvents` y `AppGenAIContent`.

Las aplicaciones que llaman a modelos deben emitir OpenTelemetry GenAI. Los campos
que se aprovechan incluyen:

| Campo | Uso |
|---|---|
| `gen_ai.agent.name`, `gen_ai.agent.id` | Identificacion declarada por el llamante. |
| `gen_ai.operation.name` | Chat, invocacion de agente, herramienta, etc. |
| `gen_ai.request.model`, `gen_ai.response.model` | Modelo solicitado o declarado en la respuesta. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Desglose de uso, cuando existe. |
| `gen_ai.usage.cached_tokens` | Tokens de cache declarados por el emisor. |
| `gen_ai.conversation.id` | Conversacion declarada. |
| `gen_ai.azure_ai_project.id` | Contexto de proyecto, cuando lo emite el SDK. |

La compatibilidad depende de la version y convenciones del SDK del cliente.
No se captura automaticamente el contenido de prompts desde este dashboard.
No actives captura de datos personales, direcciones IP o contenido sensible sin
revisar las politicas de privacidad, retencion y acceso de tu organizacion.

La consulta recupera como maximo 4.000 registros recientes por workspace. Se conservan
500 priorizados por evidencia y la lista muestra hasta 120 por filtro. Los totales son
los registros recuperados, no un censo garantizado de todas las ejecuciones.
El indicador de cobertura compara registros con tokens y peticiones de Monitor; sus
granularidades no equivalen necesariamente. Las fechas usan UTC.

## Casos de uso en API Management (opcional)

Esta capa no se crea al arrancar. Puede omitirse sin impedir el resto del dashboard.
Necesitas una pasarela existente, despliegues existentes y acceso de lectura a sus
informes. El coste de APIM no se incluye automaticamente en el coste del caso.

1. Copia [examples/use-cases.json](../examples/use-cases.json) y sustituye los campos
   de ejemplo por los nombres de tu entorno. Cada entrada requiere `id`, `account`,
   `deployments` (nombres) y `agents` (nombres). `display`, `description`, `owner` y
   `resourceGroup` aportan contexto.
2. En tu servicio de APIM, crea un **named value no secreto** cuyo identificador sea
   `casos-de-uso` y cuyo valor sea el array JSON completo. No introduzcas claves,
   credenciales, prompts ni datos personales en ese registro.
3. Crea una etiqueta por caso cuyo identificador coincida exactamente con `id`.
   Asocia la etiqueta a las APIs, operaciones y productos correspondientes.
4. Las operaciones deben identificarse como `{nombre-del-despliegue}-{sufijo}`,
   por ejemplo `support-chat-chat` o `support-embedding-embeddings`. El prefijo se
   utiliza para enlazar los informes de operaciones con el despliegue.
5. Concede a la identidad del dashboard acceso de lectura al registro, enlaces e informes.
   Cuando APIM disponga de trafico real registrado en la ventana, pulsa **Releer Azure**.

Configurar el registro y las etiquetas requiere permisos de escritura en APIM; leer
el dashboard no. No hay scripts de aprovisionamiento, asignacion de roles ni generacion
de trafico en esta distribucion. Si pruebas los modelos manualmente, ese consumo puede
generar cargos.

### Reglas para que la agrupacion no sea enganosa

- Cada caso del formato soportado fija una cuenta de Foundry y lista sus despliegues.
  Para varias cuentas, declara entradas separadas con identificadores distintos.
- Los identificadores de caso deben ser unicos entre las pasarelas consultadas.
- Un despliegue de una cuenta solo puede estar en un caso. Si se repite, se muestra
  un aviso y no se presenta un total de casos duplicado. El reparto de un despliegue
  compartido por negocios distintos requiere otro modelo de atribucion.
- Los agentes se buscan por cuenta y nombre. Un nombre ambiguo no se asigna a ciegas;
  utiliza nombres unicos dentro de la cuenta.
- Los costes vienen de los despliegues completos. Si reciben llamadas fuera de la
  pasarela, dividir por las llamadas de APIM no da un precio exacto del trafico APIM.
- El numero de llamadas por agente es un reparto, no una medicion. Cuando es necesario
  repartir un entero, el resto se asigna a los primeros agentes declarados.

## Seguridad y operaciones

El servidor no tiene autenticacion web, base de datos remota ni telemetria propia.
Escucha solo en loopback y utiliza la identidad del usuario que ha ejecutado `az login`.
La interfaz no consulta servicios de fuentes tipograficas ni CDNs externos.

No compartas `.env`, `.cache/`, la cache de credenciales de Azure CLI, volcados de API
o capturas reales. La cache financiera usa nombres separados por suscripcion y rango.
Si necesitas eliminarla, deten el servidor y borra los archivos concretos de `.cache/`
que correspondan; la proxima visita volvera a consultar Azure.

Para un despliegue de equipo o produccion se requiere una arquitectura adicional:
autenticacion de usuarios, autorizacion por suscripcion, identidad administrada o
equivalente, aislamiento de cache, HTTPS y control de acceso de red. Esta referencia
no implementa ni recomienda exponer directamente el proceso Node.
