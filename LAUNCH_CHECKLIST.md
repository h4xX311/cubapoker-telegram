# CubaPoker · Estado de preparación para lanzamiento

Análisis del estado real del proyecto y qué falta para operar en público.
Fecha: 3 de octubre de 2026.

---

## Resumen

| Área | Estado | Bloquea lanzamiento |
|---|---|---|
| Autenticación y seguridad | Completo | No |
| Flujo de pagos (simulado) | Completo | No |
| Multi-red USDT (5 cadenas) | Completo | No |
| Juego de poker | Completo | No |
| Monetización | Completo | No |
| Interfaz | Completo | No |
| **Pasarelas reales** | **Pendiente** | **Sí** |
| **Panel de operador** | **Pendiente** | **Sí** |
| **Infraestructura 24/7** | **Pendiente** | **Sí** |
| **Cumplimiento legal** | **Pendiente** | **Sí** |

---

## 1. Lo que quedó resuelto en esta iteración

### Pagos simulados de punta a punta

El flujo ya no acredita saldo al instante. Antes, un POST a `/api/deposit`.sumaba
créditos sin comprobar nada. Ahora es un recorrido verificable:

```
crear orden  ->  el usuario "paga"  ->  confirmar  ->  acreditar saldo
   (pending)                          (paid)         (una sola vez)
```

Cada paso persiste una orden en MongoDB (`PaymentOrder`), así que todo crédito
es trazable a una orden concreta. La acreditación es **idempotente**: confirmar
dos veces no duplica saldo (verificado).

Los retiros cambiaron de语义: antes se descontaba el saldo al solicitarlos
(pérdida de dinero si el operador nunca respondía). Ahora se descuentan al
**liquidarse**, tras la verificación del pago, y se puede cancelar devolviendo
el saldo.

### Cinco redes USDT

| Red | Comisión | Confirmación | Formato de dirección |
|---|---|---|---|
| TRC20 (Tron) | ~0.50 USD | 1 min | `T` + 33 chars |
| SOL (Solana) | ~0.001 USD | 1 min | Base58 32-44 |
| POL (Polygon) | ~0.01 USD | 2 min | `0x` + 40 hex |
| BEP20 (BSC) | ~0.05 USD | 3 min | `0x` + 40 hex |
| ERC20 (Ethereum) | ~4.50 USD | 12 min | `0x` + 40 hex |

Cada cadena declara su token, exploradora, decimales y patrón de validación.
BEP20 usa 18 decimales y el resto 6 — confundirlo es una pérdida de fondos
silenciosa, por eso está aislado y probado.

**Bug encontrado y corregido durante las pruebas:** una dirección de Tron
(`T` + 33 caracteres) es Base58 válida, así que pasaba el filtro de Solana. Un
usuario podía enviar USDT por TRC20 creyendo que iba a Solana y perderlo. Ahora
el patrón de Solana rechaza explícitamente ese formato.

### Interfaz

- Barra superior fija con saldo sincronizado
- Jerarquía tipográfica y espaciado consistentes
- Estados vacíos con contexto en lugar de pantallas en blanco
- Validación en línea con mensajes accionables
- Respeto a `prefers-reduced-motion` y safe-area de iOS

---

## 2. Lo que falta para lanzar

### 2.1 Pasarelas de pago reales — BLOQUEA

Hoy `SIMULATE_PAYMENTS=true` (por defecto). Ninguna pasarela mueve dinero real.

Para pasar a producción hay que implementar contra la interfaz `PaymentGateway`
(`src/services/payment/gateway.ts`), una clase por proveedor:

| work needed | Esfuerzo |
|---|---|
| `EnZonaGateway` — crear orden, webhook de confirmación | ~4 h |
| `QvaPayGateway` — ídem | ~3 h |
| `USDTGateway` — monitorear 5 cadenas, confirmar incoming | ~12 h |

La parte difícil es USDT: hay que escuchar ERC-20 (logs), TRC20 (API de Tron),
BEP20/Polygon (RPC) y Solana (RPC + SPL token accounts). Recomendación:
arrancar solo con TRC20, que es la más barata para el usuario y la más simple
de monitorear.

Al conectar las reales, se cambia `SIMULATE_PAYMENTS=false` y desaparece la
pantalla de prueba.

### 2.2 Panel de operador — BLOQUEA

Ahora no hay forma de aprobar un retiro porque no existe interfaz de gestión.
Sin ella, si alguien pide un retiro, el dinero queda retenido sin salida.

Necesario:
- Listado de retiros pendientes
- Aprobar (ejecuta el pago, descuenta saldo) / Cancelar (devuelve saldo)
- Ver órdenes de depósito y su estado
- Estadísticas de negocio

Existe la lógica de servidor (`settleWithdrawal`, `cancelWithdrawal`); falta la
interfaz y exponer las rutas con `ADMIN_API_KEY`.

### 2.3 Infraestructura 24/7 — BLOQUEA

Dos problemas de Render en plan gratuito:

1. **El servicio se suspende a los 15 min de inactividad.** Con `polling: true`
   el bot pierde la conexión con Telegram y el juego en curso se cae.
2. **El plan gratuito no es un servicio de producción.** Sin garantía de uptime.

Opciones:
- Plan de pago (~$7/mes) y migrar de `polling` a **webhooks**, que es la
  solución correcta: HTTP entrante en vez de sondeos.
- Alternativa: VPS propio (DigitalOcean, Hetzner) con `pm2`.

Migrar a webhooks es recomendable de cualquier forma: reduce consumo y latencia.

### 2.4 Cumplimiento legal — BLOQUEA

Poker con dinero real está regulado en la mayoría de jurisdicciones, y Cuba no
es la excepción en cuanto a pagos. Antes de operar:

- Licencia o autorización para juegos de azar online
- Verificación de edad (el bot da acceso a menores sin comprobación)
- Términos y condiciones visibles y aceptados
- Política de juego responsable
- Imposibilidad de autobloqueo
- Reporte de operaciones sospechosas (KYC/AML)
- Política de privacidad

Nada de esto está implementado. **No lanzar sin consultar a un abogado.**

### 2.5 Integridad del juego — NO BLOQUEA pero conviene

- **Rake VIP no se aplica.** La página VIP promete 3%/2%/0%, el código cobra 5%
  fijo. Un usuario VIP que lo compruebe pierde la confianza.
- **Logros y rachas no se disparan.** No hay hook que los active al ganar.
- **Torneos no se ejecutan.** El gestor existe pero no hay asignación de mesas
  ni reparto de premios.
- **Colusión.** Nada impide que dos cuentas coordinen. En poker de dinero real
  eso vacía la plataforma.

### 2.6 Confianza y operación

- Email transaccional (confirmaciones de depósito/retiro)
- Historial de transacciones visible en la app (las órdenes ya se guardan; falta
  la pantalla)
- Sentry o equivalente para errores
- Slasks de CA con alertas (retiros sin procesar, errores de webhook)
- Límite de intentos de login

---

## 3. Orden de ejecución recomendado

```
1. Legal              ← bloquea todo lo demás
2. Panel de operador  ← sin esto los retiros se atascan
3. TRC20 real         ← la más simple, valida el circuito completo
4. Webhooks + plan pago ← el polling no aguanta producción
5. Logros/rachas/VIP  ←REQUIRED honestidad con lo prometido
6. EnZona + QvaPay    ← requiere cuenta de empresa
7. Resto de cadenas
```

Los puntos 1, 2, 3 y 4 son los mínimos para abrir a un grupo pequeño de
usuarios de prueba. El 6 puede esperar si EnZona exige tramitacion.

---

## 4. Cómo probar el flujo de pagos ahora

```bash
# 1. Levantar con simulación
SIMULATE_PAYMENTS=true DEV_AUTH_BYPASS=true npm run dev

# 2. En otro terminal, lógica pura (sin base de datos)
node scripts/test-chains.js

# 3. Flujo completo (requiere MongoDB)
node scripts/test-payment-flow.js
```

Dentro de Telegram, el flujo es: Depositar → elegir método y monto →
continuar → "Simular pago" → saldo acreditado.

---

## 5. Verificación realizada

| Prueba | Resultado |
|---|---|
| Build backend | limpio |
| Build frontend | 43 módulos, 193 kB |
| Cadenas y comisiones | 33/33 |
| Auth sin firma | 401 correcto |
| Flujo de pago completo | **no ejecutado** (sin MongoDB local) |
| Multi-red en navegador real | **no ejecutado** |

El flujo completo de pagos está escrito (`test-payment-flow.js`) pero no se ha
ejecutado: no hay MongoDB ni Docker en esta máquina. Debe correr en un entorno
con base de datos antes de confiar en él.
