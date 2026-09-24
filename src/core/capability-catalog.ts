/** Safe descriptions of capabilities implemented by the current application. */
export interface CapabilityCatalogEntry {
  readonly id: 'conversation' | 'memory' | 'sessions' | 'notes' | 'reminders' | 'utilities' | 'status';
  readonly category: string;
  readonly helpLines: readonly string[];
  readonly naturalHelp: string;
}

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    id: 'conversation',
    category: 'Conversación',
    helpLines: [
      'Chat multi-turno; una nueva entrada puede interrumpir la respuesta activa.',
      '/help                Muestra esta ayuda',
      '/cancel              Interrumpe la respuesta activa',
      '/history             Muestra el historial actual',
      '/clear               Limpia la sesión actual',
      '/exit                Cierra la conversación',
      '/tone [nombre]       Consulta o cambia el estilo de respuesta local',
      '/format [nombre]     Consulta o cambia el formato de respuesta local',
    ],
    naturalHelp: 'Puedes conversar en varios turnos. Escribe una nueva entrada para interrumpir una respuesta activa, usa /cancel para detenerla o /exit para terminar. Cambia el estilo con /tone [nombre] y la estructura con /format [nombre].',
  },
  {
    id: 'memory',
    category: 'Memoria explícita',
    helpLines: [
      '/remember <clave> <valor>  Guarda una memoria explícita',
      '/memory                    Consulta las memorias guardadas',
      '/forget <clave>            Elimina una memoria por clave',
    ],
    naturalHelp: 'La memoria es explícita: usa /remember <clave> <valor> para guardar, /memory para consultar y /forget <clave> para eliminar. También puedo olvidar una sola memoria si me lo pides y confirmas. No incluiré contenido de memoria al explicar estas funciones.',
  },
  {
    id: 'sessions',
    category: 'Sesiones',
    helpLines: [
      '/save-session <nombre>  Guarda la conversación actual',
      '/sessions               Lista las conversaciones guardadas',
      '/session-info           Muestra metadata de la sesión actual',
      '/rename <nombre>        Cambia el título actual',
      '/load-session <nombre>  Carga una conversación guardada',
      '/delete-session <nombre>  Elimina una conversación guardada',
      '/session-search <id> <texto>  Busca texto literal en una conversación',
      '/export [nombre]        Exporta la conversación actual a Markdown',
      'Las consultas naturales muestran metadata; para buscar mensajes guardados necesito el ID.',
    ],
    naturalHelp: 'Para guardar usa /save-session <nombre> y para listar /sessions. /session-info muestra metadata actual; /rename <nombre>, /load-session <nombre> y /delete-session <nombre> requieren acción explícita. Para exportar usa /export [nombre]. Puedo consultar metadata guardada en lenguaje natural y buscar texto literal con “Busca «texto» en una conversación guardada”; te pediré el ID antes de buscar.',
  },
  {
    id: 'notes',
    category: 'Notas',
    helpLines: [
      '/note-add <texto>  Guarda una nota explícita',
      '/notes             Lista notas con previews',
      '/note-show <id>    Muestra una nota solicitada',
      '/note-delete <id>  Elimina una nota explícitamente',
      'También puedes preguntar qué notas tienes o pedir una nota por ID; “Guarda eso como nota” pide primero el texto explícito.',
    ],
    naturalHelp: 'Para guardar una nota usa /note-add <texto>; también puedes pedir “Guarda eso como nota” y te solicitaré el texto exacto, sin inferirlo. Puedes preguntar qué notas tienes (recibirás previews) o pedir una nota concreta por ID. /notes lista previews, /note-show <id> muestra una nota y /note-delete <id> la elimina solo cuando lo pides explícitamente. Preguntar cómo borrarla no ejecuta el borrado.',
  },
  {
    id: 'reminders',
    category: 'Recordatorios',
    helpLines: [
      '/remind <YYYY-MM-DD HH:mm> <texto>  Programa fecha y hora local',
      '/remind <HH:mm> <texto>             Programa la siguiente hora local',
      '/reminders                           Lista recordatorios pendientes',
      '/reminders --all                    Incluye recordatorios completados',
      '/reminder-complete <id>             Marca uno como completado',
      '/reminder-delete <id>               Elimina uno explícitamente',
      'Las consultas naturales listan pendientes o el próximo; las solicitudes ambiguas piden el dato que falta antes de crear.',
    ],
    naturalHelp: 'Usa /remind <YYYY-MM-DD HH:mm> <texto> para una fecha concreta; /remind <HH:mm> <texto> programa la siguiente ocurrencia local. “Recuérdame mañana <texto>” solicita la hora antes de crear. Puedes preguntar qué recordatorios pendientes tienes o cuál es el próximo; /reminders --all incluye el historial completado. Completar o borrar requiere /reminder-complete <id> o /reminder-delete <id>.',
  },
  {
    id: 'utilities',
    category: 'Utilidades',
    helpLines: [
      '/time              Muestra la hora local',
      '/calc <expresión>  Calcula una expresión aritmética local',
    ],
    naturalHelp: 'La hora local se consulta con /time y los cálculos aritméticos locales con /calc <expresión>.',
  },
  {
    id: 'status',
    category: 'Estado y configuración',
    helpLines: [
      '/status  Muestra un resumen local seguro del estado',
      'Los perfiles de provider se configuran localmente antes de iniciar; no cambio esa configuración desde la conversación.',
    ],
    naturalHelp: 'Usa /status para ver un resumen local seguro. Los perfiles de provider se configuran localmente antes de iniciar Yuki; puedo explicar el mecanismo, pero no cambiar provider ni mostrar credenciales o configuración privada.',
  },
] as const;

const UNAVAILABLE_CAPABILITIES = [
  { pattern: /\b(?:internet|navegar|navegacion web|search|busqueda web|browser|web)\b/u, answer: 'No; la navegación por Internet/Search no está habilitada en esta versión.' },
  { pattern: /\b(?:voz|audio|avatar|live2d|interfaz grafica|gui)\b/u, answer: 'No; las capacidades de voz, avatar e interfaz gráfica no están habilitadas en esta versión.' },
  { pattern: /\b(?:nube|cloud|sync|sincronizacion|notificaciones nativas)\b/u, answer: 'No; la sincronización en la nube y las notificaciones nativas no están habilitadas en esta versión.' },
  { pattern: /\b(?:filesystem|acceso general a archivos|leer archivos|acceder a archivos|archivos del equipo)\b/u, answer: 'No; el acceso general a archivos no está habilitado en esta versión.' },
] as const;

function normalize(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().trim();
}

function cleanQuestion(input: string): string {
  return normalize(input).replace(/^[¿¡\s]+/u, '').replace(/[?!.\s]+$/u, '').trim();
}

function isCapabilityQuestion(question: string): boolean {
  return /^(?:que puedes hacer|que sabes hacer|que capacidades tienes|que comandos tienes|cuales son tus comandos|como te uso|como puedo usar(?:te)?|what can you do|what commands do you have)$/u.test(question)
    || /\b(?:ayuda|instrucciones|capacidad|capacidades|comandos)\b/u.test(question);
}

function isHowToQuestion(question: string): boolean {
  return /^(?:como|how)\b/u.test(question);
}

function matchesTopic(question: string, id: CapabilityCatalogEntry['id']): boolean {
  switch (id) {
    case 'conversation': return /\b(?:interrump|cancelar|cancelacion|salir)\b/u.test(question);
    case 'memory': return /\b(?:memoria|memorias|remember|forget)\b/u.test(question);
    case 'sessions': return /\b(?:sesion|sesiones|conversacion|conversaciones|guardar|exportar|exportacion|busc(?:ar|o|a)|busqueda|cargar|renombrar)\b/u.test(question);
    case 'notes': return /\b(?:nota|notas|guardar|borrar|eliminar)\b/u.test(question);
    case 'reminders': return /\b(?:recordatorio|recordatorios|recordar|recu[eé]rdame|remind)\b/u.test(question);
    case 'utilities': return /\b(?:hora|tiempo|calcular|calculo|calculadora|cuenta|operacion)\b/u.test(question);
    case 'status': return /\b(?:estado|provider|proveedor|perfil|configuracion)\b/u.test(question);
  }
}

export function formatCapabilityHelp(): string {
  return [
    'Capacidades y comandos disponibles:',
    ...CAPABILITY_CATALOG.flatMap(({ category, helpLines }) => [`${category}:`, ...helpLines.map((line) => `  ${line}`)]),
    'Escribe /help en cualquier momento para volver a mostrar esta lista.',
  ].join('\n');
}

function formatNaturalEntry(entry: CapabilityCatalogEntry): string {
  const commands = entry.helpLines.filter((line) => /^\s*\//u.test(line)).map((line) => line.trim());
  return `${entry.naturalHelp}\n\nComandos relacionados:\n${commands.join('\n')}`;
}

/** Resolves only clear help/capability questions. It never executes tools. */
export function resolveNaturalCapabilityHelp(input: string): string | undefined {
  const question = cleanQuestion(input);
  if (!question) return undefined;

  const isCapabilityIntent = isCapabilityQuestion(question);
  const isHowTo = isHowToQuestion(question);
  const asksCapability = isCapabilityIntent || /^(?:puedes|puedo|tienes|tiene|hay|can you|do you have)\b/u.test(question);
  if (asksCapability) {
    const unavailable = UNAVAILABLE_CAPABILITIES.find(({ pattern }) => pattern.test(question));
    if (unavailable) return unavailable.answer;
  }

  const entry = CAPABILITY_CATALOG.find(({ id }) => matchesTopic(question, id));
  if (entry && (isCapabilityIntent || isHowTo)) return formatNaturalEntry(entry);
  if (!isCapabilityIntent) {
    if (isHowTo) {
      const unavailable = UNAVAILABLE_CAPABILITIES.find(({ pattern }) => pattern.test(question));
      if (unavailable) return unavailable.answer;
    }
    return undefined;
  }
  if (entry) return formatNaturalEntry(entry);
  return `Puedo conversar y ayudar con las capacidades locales que aparecen en /help. ${formatCapabilityHelp()}`;
}
