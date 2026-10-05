# Documentos legales · CubaPoker

Fecha: 5 de octubre de 2026.

---

## ESTO NO ES ASESORÍA LEGAL

Los documentos de esta carpeta son **borradores técnicos**, escritos por alguien
que no es abogado y que no puede serlo. Antes de operar hay que pasarlos por un
abogado con experiencia en juegos de azar y criptoactivos.

Un borrador de T&C incorrecto es peor que no tener T&C: da falsa confianza. En
algunas jurisdicciones es además un problema penal.

Los cuatro documentos de abajo cubren lo mínimo que un jugador debe saber antes de
depositar. Dejan fuera casi todo lo que un regulador pediría (procedimiento de
disputas, cumplimiento de AML/KYC, auditoría de los juegos, interacción con
autoridades, lista de jurisdicciones restringidas). Esa parte la tiene que escribir
el abogado, y solo él.

---

## Lo que hay aquí

| Documento | Para qué |
|---|---|
| `TERMS.md` | Términos y condiciones: qué es el servicio, qué no se puede hacer, quién responde de qué. |
| `RESPONSIBLE_GAMING.md` | Juego responsable: límites, autoexclusión, señales de advertencia. |
| `PRIVACY.md` | Qué datos se recogen, para qué y durante cuánto tiempo. |
| `IMPLEMENTATION.md` | Qué tiene que hacer el código para cumplir lo que dicen los otros tres. |

`IMPLEMENTATION.md` es el más importante de los cuatro para quien está construyendo:
convierte cada compromiso legal en un requisito técnico verificable.

---

## Los cuatro bloqueantes que ya no dependen del abogado

De los cuatro bloqueantes del lanzamiento, **tres ya están resueltos en código**
(panel de operador, plan de pago, TRC20) y uno no depende de un abogado sino de una
decisión del operador (cuál es el tipo de cambio de referencia, hoy 120 CUP/USDT).

**El legal sí depende de un abogado**, y no se puede sustituir con trabajo técnico.
Es el único de los cuatro que no se resuelve solo.

### Además: el sistema no puede ejecutarse aún

Ver `LAUNCH_CHECKLIST.md` §3-bis. Ninguna parte del campo se ha ejecutado contra
una base de datos real, porque esta máquina no puede descargar MongoDB. Eso es
independiente del legal: aunque los documentos estuvieran perfectos, el producto no
está listo para recibir usuarios porque el código de pagos y de campos no se ha
ejecutado nunca de punta a punta.

---

## Recomendación sobre el orden

1. **Contratar al abogado** (bloquea el lanzamiento, no el desarrollo).
2. **Montar Atlas y escribir el test de integración end-to-end** (bloquea todo lo
   demás: es lo que valida que el código funciona).
3. Pagar el plan de Render y montar el panel de operador (hecho, solo falta
   probarlo).
4. Clave de TronGrid + dirección TRON, y un depósito de prueba de 1 USDT.
5. Solo entonces, grupo pequeño de usuarios de prueba.

Los puntos 2 a 4 se pueden hacer en paralelo con el 1, porque no dependen del
abogado. Empezar por ellos es lo que reduce el tiempo hasta el lanzamiento.