# ADR-004: Validación declarativa propia para Phase 2

- Estado: aceptado para Phase 2.
- Fecha: 2026-09-17.

## Contexto

El sistema de herramientas necesita rechazar argumentos faltantes, desconocidos, mal tipados o inválidos antes de autorizar y ejecutar una herramienta. Phase 2 debe mantener una superficie pequeña y no introducir una dependencia externa sólo para el perímetro inicial.

## Decisión

Phase 2 usa un esquema declarativo propio y mínimo para argumentos de herramientas. El esquema describe un objeto raíz, propiedades conocidas, obligatoriedad, tipos primitivos, enumeraciones y límites simples. La validación produce un resultado tipado con errores estructurados; no ejecuta código ni interpreta expresiones proporcionadas por el modelo.

La política por defecto rechaza propiedades desconocidas. Una herramienta puede declarar explícitamente `allowUnknown`, pero no se habilita por defecto.

## Consecuencias

- No se añade una dependencia externa ni un SDK de validación.
- La estrategia cubre el contrato de Phase 2 y puede sustituirse detrás de `validateToolArguments` si una fase futura demuestra la necesidad de JSON Schema u otra librería.
- Los esquemas complejos, coerción de tipos y validación profunda quedan fuera hasta contar con un caso de uso y pruebas que lo justifiquen.
