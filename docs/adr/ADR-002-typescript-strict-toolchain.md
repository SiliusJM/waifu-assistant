# ADR-002: Toolchain TypeScript estricto

- Estado: aceptado para Phase 1.
- Fecha: 2026-09-17.

## Contexto

Phase 1 introduce contratos entre sesiones, contexto, respuestas, proveedores y errores. El proyecto ya tenía un runtime ESM mínimo, pero no un typecheck ni un linter de terceros.

El spike inicial confirmó que TypeScript 7.0.2 no era compatible con la versión fijada de typescript-eslint. Se seleccionó TypeScript 5.9.3, última versión 5.x disponible y compatible con el peer range observado.

## Decisión

- TypeScript 5.9.3 exacto.
- ESLint 10.10.0, typescript-eslint 8.70.0 y @eslint/js 10.0.1 exactos.
- @types/node 22.20.3 exacto.
- ESM con NodeNext.
- strict, noUncheckedIndexedAccess, noImplicitOverride y noEmitOnError.
- Código fuente en src y tests compilados en un árbol separado.
- package-lock.json versionado.

El runtime de Phase 1 usa APIs nativas de Node.js y fetch. No se añade un SDK de proveedor.

## Alternativas

- TypeScript 7: descartado por incompatibilidad de dependencias del toolchain actual.
- JavaScript ESM con JSDoc: válido para un prototipo, pero menos adecuado para los contratos centrales aprobados.
- Framework de tests adicional: no necesario mientras node:test cubra el alcance.

## Consecuencias

Los contratos se validan en build y typecheck. El coste es mantener compilador, linter y lockfile. La selección de versiones queda reproducible y podrá actualizarse mediante otro ADR.
