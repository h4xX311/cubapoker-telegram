# Requisitos técnicos derivados de los documentos legales

Fecha: 5 de octubre de 2026.

Este documento convierte cada compromiso de `TERMS.md`, `RESPONSIBLE_GAMING.md` y
`PRIVACY.md` en algo que el código tiene que cumplir. Es el puente entre lo que se
promete al usuario y lo que hace el servidor.

Un término que no se puede comprobar es una promesa que se puede romper por
accidente. Todo lo de aquí debería acabar en una prueba o en un endpoint.

---

## 1. Edad mínima

**Lo que se promete** (en los T&C): solo mayores de 18 años pueden jugar.

**Lo que hace falta en el código:**

- Comprobar la edad antes de permitir un depósito. Telegram da `birthdate` en el
  objeto `User` de la API, pero **solo si el usuario lo ha compartido**: es un
  campo opcional y la mayoría no lo rellena. No se puede confiar en ello.
- Segunda barrera: exigir verificación de edad en el momento del primer depósito,
  con un documento o un selfie. Eso es trabajo de un proveedor externo, no código.

**El problema de verdad:** con una cuenta de Telegram cualquiera, alguien puede
declararse mayor. La verificación real es un proceso, no una comprobación. Mientras
no exista, **no se puede afirmar en los T&C que hay un control de edad**, porque no
lo hay. Decirlo de otra forma es una declaración falsa.

---

## 2. Autoexclusión

**Lo que se promete:** el usuario puede excluirse y no volver a jugar.

**Lo que hace falta:**

- Un campo `excludedAt` en `User`, que ninguna ruta de juego pueda saltarse.
- Al excluirse: cerrar cualquier campo en el que estuviera, devolver lo que le
  quede en la mesa, y bloquear depósitos y retiros hasta un periodo determinado.
- Un bloqueo que sobreviva al cierre de sesión y al borrado de cookies.

**Estado actual: no implementado.** Es trabajo directo, sin dependencias externas.

**La comprobación que no se puede saltarse:** el bloqueo tiene que estar en una
función a la que pase todo el acceso al juego, no repartido por las 30 rutas. Si
cada ruta comprueba por su cuenta, el día que se añada una nueva arranca sin
comprobar.

---

## 3. Límites de pérdida y de tiempo

**Lo que se promete:** límites de depósito, pérdida y tiempo de sesión.

**Lo que hace falta:**

- Límites por defecto (no solo configurables): depósito diario, pérdida semanal,
  sesión máxima.
- La pérdida la mide `unlockService`: cada vez que se consume saldo, lo que sale de
  `balance.real` es pérdida. El dato ya existe; lo que falta es la comprobación
  contra el límite.
- Límite de sesión: el motor (`table.manager.tick`) sabe desde cuándo lleva
  conectado. Comprobar ahí es lo barato.

**Estado actual: no implementado.** El `monthlyWinCap` de `config/currency.ts`
(25 000 USDT) es un tope de **retiros**, no un límite de pérdida. No es lo mismo y no
debe presentarse como tal.

---

## 4. Que el saldo de promoción no se retira

**Lo que se promete:** el saldo promocional no es retirable; se desbloquea 1:10.

**Estado actual: implementado y con pruebas.**

- `balance.real` es el único saldo del que se puede retirar
  (`withdrawal.rules.ts`, `checkWithdrawal`).
- La comprobación está en el filtro del `findOneAndUpdate` de `settleWithdrawal`, no
  antes: si estuviera antes, dos aprobaciones simultáneas pasarían las dos.

**La parte delicada:** el mensaje al usuario tiene que explicar el 1:10. Un jugador
que no lo entiende ve su saldo bajar y cree que le están cobrando de más.
`unlockService.disclosure()` existe para eso, y hay que mostrarlo en la pantalla de
depósito, no solo en los términos que nadie lee.

---

## 5. Que el tipo de cambio es un dato, no una promesa

**Lo que hay que decir:** la cuenta se lleva en USDT. El CUP es la vía de entrada y
salida, a un tipo de cambio que decide el operador (hoy 120 CUP/USDT).

**Por qué importa:** si el CUP se deprecia, un saldo que ayer valía 10 000 CUP
pasará a 8 000 CUP sin que nadie haya hecho nada. El usuario tiene que entender que
su saldo es USDT y que el equivalente en CUP es solo una referencia.

**Estado actual: implementado** (`config/currency.ts`), y la interfaz ya muestra las
dos cifras. Lo que falta es decirlo en la pantalla de depósito.

---

## 6. Privacidad: qué se guarda

**Lo que hay que poder responder** si alguien pregunta: qué datos tienen de mí,
durante cuánto tiempo y quién los ve.

**Datos que el sistema guarda hoy:**

| Dato | Dónde | Por qué |
|---|---|---|
| `telegramId`, nombre, usuario | `User` | Identificar al jugador |
| `balance.real`, `balance.play` | `User` | El saldo |
| Estadísticas de juego | `User.stats` | Perfil |
| Historial de manos | `Table`, `Field` | Reconstruir una partida |
| Órdenes de pago con wallet | `PaymentOrder` | Pagar y auditar |
| IP de las peticiones | logs de Render | Seguridad y antifraude |

**Lo que no se guarda:** documentos de identidad, selfie, datos bancarios. Es una
ventaja y conviene decirlo: no hay verificación de edad porque no hay recolección de
identidad, y viceversa.

**Los tres que hay que decidir antes de lanzar:**

1. **Cuánto tiempo se conserva el historial de manos.** Es lo único que no puede
   borrarse sin afectar al producto, y es lo más sensible: un historial completo
   permite reconstruir las decisiones de cada jugador. Es lo que más se parece a
   "datos personales" y lo que un regulator va a preguntar.
2. **Los logs de Render** incluyen IPs y se borran solos tras unos días. Hay que
   confirmarlo y decirlo en la política.
3. **La API de Telegram** impone sus propios términos sobre los datos que se obtienen
   a través del bot. No se pueden usar los datos de un usuario fuera de lo que
   permita Telegram, y eso incluye el marketing.

---

## 7. La reserva de la cláusula de AML

Los documentos de esta carpeta **no cubren** el procedimiento de prevención de
blanqueo. Es lo que un regulator pregunta primero, y aquí no hay nada.

Como mínimo, antes de operar en serio:

- Un umbral a partir del cual hay que verificar identidad.
- Registro de operaciones, que se pueda entregar a una autoridad.
- Lista de jurisdicciones restringidas.
- Quién es el responsable de cumplimiento, por nombre.

**Esto lo escribe el abogado.** Lo que sí puede hacer el código es dejarlo
preparado: que cada movimiento de dinero registre quién, cuánto, desde dónde y con
qué hash de transacción. `Transaction` ya lo hace, y esa es la base correcta.

---

## Resumen: qué está implementado y qué no

| Requisito | Estado | Bloquea el lanzamiento |
|---|---|---|
| Límite de edad | No (y no se puede con la API de Telegram) | Sí |
| Autoexclusión | No | Sí |
| Límites de pérdida y sesión | No | Sí |
| Saldo promoción no retirable | Sí, con pruebas | No |
| Explicación del 1:10 | Parcial (falta en la pantalla de depósito) | No |
| Tipo de cambio como referencia | Sí | No |
| Registro de transacciones | Sí (`Transaction`) | No |
| Política de conservación de datos | No decidida | Sí |
| Procedimiento AML | No | Sí |

Cuatro de los cinco requisitos sin implementar son trabajo directo de código, sin
dependencias externas. Se pueden empezar hoy mismo.