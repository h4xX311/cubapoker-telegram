/**
 * Configuración Central de Monetización - CubaPoker
 * Todas las tasas, comisiones y recompensas en un solo lugar
 */

import { WITHDRAWALS } from './currency';
import { usdtToUnits } from './units';

export const monetizationConfig = {
  // === RAKE ===
  rake: {
    percentage: 5,           // 5% del pote
    maxRake: 100,            // Máximo 100 CUP por mano
    minPot: 10,              // Mínimo 10 CUP para aplicar rake
    // El VIP no descuenta rake. El beneficio es el rakeback semanal: descontar
    // rake en la mesa reduciría el bote que se reparte y el ingreso de la casa
    // en cada mano. `calculateRake` ignora el nivel a propósito.
  },

  // === COMISIONES ===
  //
  // UNIDADES, Y AQUI ESTA LA TRAMPA
  //
  // Los porcentajes son unitless, pero `min` y `max` estan en UNIDADES INTERNAS, no en CUP
  // ni en USDT. La convencion del proyecto es que todo importe que toca un saldo va en
  // unidades internas (1 USDT = 1000 unidades, ver `config/units.ts`), que es la misma que
  // documenta `withdrawal.rules.ts`.
  //
  //   min 10 unidades  = 0,01 USDT  <- minimo razonable
  //   min 10 CUP       = 0,083 USDT <- un 8 % de comision: absurdo
  //   min 10 USDT      = imposible  <- mas que un deposito pequeno
  //
  // El comentario de antes decia "CUP" y no lo era. Con esa etiqueta, un deposito de 5 USDT
  // daba: comision = floor(5 * 0,5 / 100) = 0, el minimo la subia a 10, y el acreditado era
  // 5 - 10 = **-5**: saldo negativo. Medido.
  //
  // Si alguna vez se cambian estas cifras, que sea en la MISMA unidad y con un comentario que
  // lo diga. Es exactamente lo que faltó aquí.
  commissions: {
    deposit: {
      enzona: 1.5, // 1.5%
      qvapay: 1.5, // 1.5%
      usdt: 0.5, // 0.5%
      min: 10, // 10 unidades = 0,01 USDT
      max: 500, // 500 unidades = 0,5 USDT
    },
    withdrawal: {
      enzona: 3, // 3%
      qvapay: 3, // 3%
      usdt: 1, // 1%
      min: 20, // 20 unidades = 0,02 USDT
      max: 1000, // 1000 unidades = 1 USDT
    },
  },

  // === REFERIDOS ===
  referrals: {
    level1: 10,              // 10% del rake de referidos directos
    level2: 5,               // 5% del rake de segundo nivel
    level3: 2,               // 2% del rake de tercer nivel
    minPayout: 100,          // Mínimo para retirar comisiones
    bonus: 50,               // Bonus por cada referido activo
  },

  // === TORNEOS ===
  tournaments: {
    daily: {
      name: 'Torneo Diario',
      buyIn: 100,
      rake: 10,              // 10% del buy-in
      maxPlayers: 20,
      minPlayers: 4,
      prizeStructure: [50, 30, 20], // % para 1º, 2º, 3º
    },
    weekly: {
      name: 'Torneo Semanal',
      buyIn: 500,
      rake: 10,
      maxPlayers: 50,
      minPlayers: 10,
      prizeStructure: [50, 30, 20],
    },
    special: {
      name: 'Torneo Especial',
      buyIn: 1000,
      rake: 5,
      maxPlayers: 100,
      minPlayers: 20,
      prizeStructure: [40, 25, 15, 10, 5, 5],
    },
    freeroll: {
      name: 'Freeroll',
      buyIn: 0,
      rake: 0,
      maxPlayers: 50,
      minPlayers: 10,
      prizeStructure: [40, 30, 20, 10],
    },
  },

  // === RACHAS ===
  streaks: {
    3: 50,                   // 3 días seguidos
    7: 200,                  // 1 semana
    14: 500,                 // 2 semanas
    30: 1500,                // 1 mes
  },

  // === LOGROS ===
  achievements: {
    first_win: 50,
    win_streak_3: 100,
    win_streak_5: 250,
    win_streak_10: 500,
    royal_flush: 1000,
    four_of_a_kind: 500,
    full_house: 200,
    hands_played_10: 50,
    hands_played_50: 200,
    hands_played_100: 500,
    hands_played_500: 2000,
    tournament_win: 500,
    tournament_finalist: 200,
    referral_1: 100,
    referral_5: 500,
    referral_10: 1000,
    first_deposit: 50,
    deposit_1000: 100,
    deposit_10000: 500,
  },

  // === BONOS ===
  bonuses: {
    welcome: 100,            // Bonus de bienvenida
    firstDeposit: 10,        // 10% extra en primer depósito
    dailyLogin: 10,          // Bonus por login diario
    referralActive: 50,      // Bonus por referido activo
  },

  // === COSMÉTICOS ===
  cosmetics: {
    goldenChips: 100,        // Fichas doradas
    avatarExclusive: 200,    // Avatar exclusivo
    specialEffects: 150,     // Efectos especiales
    tableTheme: 300,         // Tema de mesa
  },
};

/**
 * Rake de una mano.
 *
 * `_vipLevel` se conserva para no romper llamadas antiguas, pero NO cambia el
 * porcentaje. El VIP de CubaPoker reparte rake a fin de semana; no lo descuenta
 * en la mesa. Un descuento por nivel haría que dos jugadores en la misma mano
 * pagaran rake distinto y complicaría la contabilidad sin dar más ingresos.
 */
export const calculateRake = (pot: number, _vipLevel?: string): number => {
  const { percentage, maxRake, minPot } = monetizationConfig.rake;

  if (pot < minPot) return 0;

  const rake = Math.floor((pot * percentage) / 100);
  return Math.min(rake, maxRake);
};

/**
 * Comisión de un movimiento, EN UNIDADES INTERNAS.
 *
 * ------------------------------------------------------------------
 * EN QUE UNIDAD TRABAJA
 *
 * Recibe y devuelve **unidades internas** (1 USDT = 1000). Es la unidad del saldo, de las
 * fichas y de los topes de `monetizationConfig.commissions`, y la misma que documenta
 * `withdrawal.rules.ts`.
 *
 * Antes la tomaba en USDT (lo que llegaba del-body) y la devolvia en USDT, mientras sus
 * topes `min`/`max` estaban en unidades. Dos escalas en una linea:
 *
 *     const commission = Math.floor((amount * rate) / 100);  // amount en USDT
 *     return Math.max(config.min, Math.min(commission, config.max));
 *                                          // ^^^ min/max en unidades (1000x mas grandes)
 *
 * Con un deposito de 5 USDT: comision = 0, el minimo la subia a 10, y el acreditado era
 * 5 - 10 = **-5**. Saldo negativo. Medido.
 *
 * ------------------------------------------------------------------
 * POR QUE EN UNIDADES Y NO EN USDT
 *
 * Porque el resultado se resta de un importe que va a tocar el saldo, y el saldo esta en
 * unidades. Convertir dentro de la funcion obligaria a que todos los llamantes acordaran la
 * conversion, y con cuatro llamantes es exactamente donde se colaba el error. Convertir una
 * sola vez, en la frontera del servicio, deja esta funcion sin sorpresas.
 *
 * Si algun dia hace falta llamado en USDT, se anade `calculateCommissionUsdt()` que
 * delegue en esta. No se cambia el contrato de golpe.
 */
export const calculateCommission = (
  amount: number,
  type: 'deposit' | 'withdrawal',
  method: 'enzona' | 'qvapay' | 'usdt',
): number => {
  const config = monetizationConfig.commissions[type];

  // Un importe no finito o negativo no produce una comision: se trataria de restar NaN o un
  // numero negativo a un saldo, que es la forma mas rapida de corromper el dinero de
  // alguien. Se devuelve 0 y el error real lo detecta el llamante que valida el importe.
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  // ------------------------------------------------------------------
  // RETIRO USDT: COMISION FIJA DE 5 USDT
  //
  // Decision de producto, copiada de CoinPoker: el jugador paga 5 USDT por
  // retiro, no un porcentaje ni un fee distinto por red. El coste real de la
  // red se cubre con esos 5 USDT; lo que sobre se queda la casa. No se aplica
  // el minimo/maximo de la tabla de comisiones porque el fee ya es el importe
  // fijo, y nunca puede superar lo que se retira.
  // ------------------------------------------------------------------
  if (type === 'withdrawal' && method === 'usdt') {
    const fixed = usdtToUnits(WITHDRAWALS.fixedFeeUsdt);
    return Math.min(amount, fixed);
  }

  const rate = config[method] || 0;
  const commission = Math.floor((amount * rate) / 100);

  return Math.max(config.min, Math.min(commission, config.max));
};

// Función para calcular premio de torneo
export const calculateTournamentPrize = (
  buyIn: number,
  playerCount: number,
  position: number,
  prizeStructure: number[]
): number => {
  const totalPrize = playerCount * buyIn;
  const rake = Math.floor((totalPrize * monetizationConfig.tournaments.daily.rake) / 100);
  const netPrize = totalPrize - rake;
  
  if (position > prizeStructure.length) return 0;
  
  const percentage = prizeStructure[position - 1];
  return Math.floor((netPrize * percentage) / 100);
};
