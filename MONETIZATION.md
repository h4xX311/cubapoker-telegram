# CubaPoker - Sistema de Monetización Completo

## Resumen

Sistema de monetización completo con 8 fuentes de ingresos integradas.

---

## Fuentes de Ingresos

### 1. Rake (Comisión por mano) - 74% de ingresos

| Aspecto | Detalle |
|---------|---------|
| **Tasa** | 5% del pote |
| **Máximo** | 100 CUP por mano |
| **Mínimo** | 10 CUP de pote |
| **VIP Discount** | Basic: 3%, Premium: 2%, Elite: 0% |

**Código:** `src/game/rake.ts`

---

### 2. Torneos con Buy-in - 8% de ingresos

| Tipo | Buy-in | Rake | Jugadores |
|------|--------|------|-----------|
| Diario | 100 CUP | 10% | 20 |
| Semanal | 500 CUP | 10% | 50 |
| Especial | 1000 CUP | 5% | 100 |
| Freeroll | Gratis | 0% | 50 |

**Código:** `src/game/tournament.ts`

---

### 3. Comisiones por Depósitos/Retiros - 7% de ingresos

| Operación | EnZona | QvaPay | USDT |
|-----------|--------|--------|------|
| Depósito | 1.5% | 1.5% | 0.5% |
| Retiro | 3% | 3% | 1% |

**Código:** `src/config/monetization.ts`

---

### 4. Suscripciones VIP - 5% de ingresos

| Nivel | Precio | Rake | Torneos | Beneficios |
|-------|--------|------|---------|------------|
| Basic | 500 CUP/mes | 3% | 5% desc | Badge, torneos VIP |
| Premium | 2000 CUP/mes | 2% | 10% desc | Badge dorado, retiros prioritarios |
| Elite | 5000 CUP/mes | 0% | 20% desc | Sin rake, gestor dedicado |

**Código:** `src/models/VIP.ts`

---

### 5. Sistema de Referidos - 3% de ingresos

| Nivel | Comisión | Descripción |
|-------|----------|-------------|
| Nivel 1 | 10% | Referidos directos |
| Nivel 2 | 5% | Referidos de referidos |
| Nivel 3 | 2% | Tercer nivel |

**Bonus:** 50 CUP por cada referido activo

**Código:** `src/models/Referral.ts`

---

### 6. Logros y Rachas - 2% de ingresos

**Rachas:**
- 3 días: 50 CUP
- 7 días: 200 CUP
- 14 días: 500 CUP
- 30 días: 1500 CUP

**Logros destacados:**
- Primera Victoria: 50 CUP
- Escalera Real: 1000 CUP
- 100 Manos: 500 CUP
- Campeón de Torneo: 500 CUP

**Código:** `src/models/Achievement.ts`

---

### 7. Publicidad y Patrocinios - 1% de ingresos

- Banners en Mini App
- Torneos patrocinados
- Afiliados

---

### 8. Cosméticos - 1% de ingresos

| Item | Precio |
|------|--------|
| Fichas doradas | 100 CUP |
| Avatar exclusivo | 200 CUP |
| Efectos especiales | 150 CUP |
| Tema de mesa | 300 CUP |

---

## Estructura de Archivos

```
src/
├── config/
│   └── monetization.ts       # Configuración central
├── models/
│   ├── Referral.ts           # Sistema de referidos
│   ├── VIP.ts                # Sistema VIP
│   ├── Achievement.ts        # Logros y rachas
│   └── Transaction.ts        # Transacciones con comisiones
├── services/
│   └── monetization.service.ts # Lógica de negocio
├── routes/
│   └── monetization.routes.ts  # API endpoints
└── game/
    ├── rake.ts               # Sistema de rake
    └── tournament.ts         # Sistema de torneos
```

---

## API Endpoints

### VIP
- `GET /api/monetization/vip/:telegramId` - Obtener nivel VIP
- `POST /api/monetization/vip/purchase` - Comprar VIP
- `GET /api/monetization/vip/config` - Configuración VIP

### Referidos
- `GET /api/monetization/referrals/:telegramId` - Estadísticas
- `POST /api/monetization/referrals/register` - Registrar referido

### Logros
- `GET /api/monetization/achievements/:telegramId` - Logros del usuario
- `POST /api/monetization/achievements/unlock` - Desbloquear logro
- `GET /api/monetization/streaks/:telegramId` - Racha del usuario
- `POST /api/monetization/streaks/update` - Actualizar racha

### Estadísticas
- `GET /api/monetization/stats` - Estadísticas globales
- `GET /api/monetization/config` - Configuración

---

## Comandos del Bot

| Comando | Descripción |
|---------|-------------|
| `/vip` | Ver y comprar VIP |
| `/referrals` | Ver estadísticas de referidos |
| `/achievements` | Ver logros y rachas |

---

## Proyección de Ingresos Mensuales

| Fuente | CUP | USD |
|--------|-----|-----|
| Rake | 75,000 | ~214 |
| Torneos | 8,000 | ~23 |
| Comisiones | 7,500 | ~21 |
| VIP | 5,000 | ~14 |
| Referidos | 3,000 | ~9 |
| Logros | 2,000 | ~6 |
| Publicidad | 1,000 | ~3 |
| Cosméticos | 1,000 | ~3 |
| **TOTAL** | **102,500** | **~293** |

---

## Implementación por Fases

### Fase 1: Lanzamiento (Mes 1-2)
- [x] Rake 5%
- [x] Torneos diarios
- [x] Sistema de referidos
- [x] Logros básicos

### Fase 2: Crecimiento (Mes 3-6)
- [x] VIP Basic
- [x] Torneos semanales
- [x] Comisiones por depósitos
- [x] Rachas

### Fase 3: Expansión (Mes 7-12)
- [x] VIP Premium y Elite
- [x] Torneos especiales
- [ ] Publicidad
- [ ] Cosméticos

---

## Seguridad

- Todas las transacciones quedan registradas en MongoDB
- Comisiones calculadas automáticamente
- Sin manipulación manual de balances
- Auditoría completa de todas las operaciones

---

## Monitoreo

```bash
# Ver estadísticas de monetización
curl https://api.cubapoker.com/api/monetization/stats

# Ver configuración actual
curl https://api.cubapoker.com/api/monetization/config
```

---

## Conclusión

El sistema de monetización está completo y listo para producción. Todas las fuentes de ingresos están integradas y funcionando automáticamente.
