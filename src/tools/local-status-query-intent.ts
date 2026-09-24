const STATUS_TERMS = /\b(?:proveedor|provider|modelo|model|credencial|clave|sesi[oó]n|session|notas?|recordatorios?|pendientes?|completados?|estado|resumen)\b/iu;
const CHANGE_TERMS = /\b(?:cambia|cambiar|cámbiame|cámbiate|pon|poner|configura|configurar|configúrame|selecciona|seleccionar|usa|usar|utiliza|utilizar|switch|set)\b/iu;

export function isExplicitLocalStatusQuery(input: unknown): input is string {
  if (typeof input !== 'string' || !STATUS_TERMS.test(input)) return false;
  return !CHANGE_TERMS.test(input);
}
