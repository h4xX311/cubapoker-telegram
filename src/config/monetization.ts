/**
 * Configuración Central de Monetización - CubaPoker
 * Todas las tasas, comisiones y recompensas en un solo lugar
 */

export const monetizationConfig = {
  // === RAKE ===
  rake: {
    percentage: 5,           // 5% del pote
    maxRake: 100,            // Máximo 100 CUP por mano
    minPot: 10,              // Mínimo 10 CUP para aplicar rake
    vipDiscount: {           // Descuento por nivel VIP
      basic: 2,              // VIP Basic: 3% (5% - 2%)
      premium: 3,            // VIP Premium: 2% (5% - 3%)
      elite: 5,              // VIP Elite: 0% (5% - 5%)
    },
  },

  // === COMISIONES ===
  commissions: {
    deposit: {
      enzona: 1.5,           // 1.5%
      qvapay: 1.5,           // 1.5%
      usdt: 0.5,             // 0.5%
      min: 10,               // Mínimo 10 CUP
      max: 500,              // Máximo 500 CUP
    },
    withdrawal: {
      enzona: 3,             // 3%
      qvapay: 3,             // 3%
      usdt: 1,               // 1%
      min: 20,               // Mínimo 20 CUP
      max: 1000,             // Máximo 1000 CUP
    },
  },

  // === VIP ===
  vip: {
    basic: {
      name: 'VIP Básico',
      price: 500,
      duration: 30,          // días
      rakeDiscount: 2,       // 2% de descuento
      tournamentDiscount: 5, // 5% de descuento
      benefits: [
        'Rake reducido (3% en lugar de 5%)',
        'Acceso a torneos VIP',
        'Badge especial en el juego',
      ],
    },
    premium: {
      name: 'VIP Premium',
      price: 2000,
      duration: 30,
      rakeDiscount: 3,
      tournamentDiscount: 10,
      benefits: [
        'Rake reducido (2% en lugar de 5%)',
        'Acceso a torneos exclusivos',
        'Badge dorado especial',
        'Retiros prioritarios',
        'Soporte prioritario',
      ],
    },
    elite: {
      name: 'VIP Elite',
      price: 5000,
      duration: 30,
      rakeDiscount: 5,
      tournamentDiscount: 20,
      benefits: [
        'Rake 0% (sin comisión)',
        'Acceso a todos los torneos',
        'Badge legendario',
        'Retiros instantáneos',
        'Gestor de cuenta dedicado',
        'Torneos privados',
      ],
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

// Función para calcular rake con descuento VIP
export const calculateRake = (pot: number, vipLevel?: 'basic' | 'premium' | 'elite'): number => {
  const { percentage, maxRake, minPot, vipDiscount } = monetizationConfig.rake;
  
  if (pot < minPot) return 0;
  
  let finalPercentage = percentage;
  if (vipLevel && vipDiscount[vipLevel]) {
    finalPercentage = percentage - vipDiscount[vipLevel];
  }
  
  const rake = Math.floor((pot * finalPercentage) / 100);
  return Math.min(rake, maxRake);
};

// Función para calcular comisión
export const calculateCommission = (
  amount: number,
  type: 'deposit' | 'withdrawal',
  method: 'enzona' | 'qvapay' | 'usdt'
): number => {
  const config = monetizationConfig.commissions[type];
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
